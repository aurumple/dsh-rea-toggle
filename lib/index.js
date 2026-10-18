/**
 * dsh-rea-toggle — host half.
 *
 * One switch deciding whether the REA MCP server's context reaches the model at
 * all. REA registers 207 tool schemas plus a multi-kilobyte server-instructions
 * block; `dsh-mcp-client` puts both on the GLOBAL layer, so every agent pays for
 * them whether or not the task is a reverse-engineering task.
 *
 * Two independent mechanisms are needed, because the two travel different paths:
 *
 * 1. Tools. `tools.restrict({ deny })` filters what a scope INHERITS from the
 *    global layer (`ToolRuntime.view`), and the model-facing schema list is
 *    rebuilt from that view on every assembly. The reserved `run_code`
 *    transport is appended outside the filterable layers, so it survives.
 * 2. Prompt. `dsh-mcp-client` registers the server instructions as a section
 *    named `mcp:<server>` at order `MCP_SERVERS`. A scoped section with the SAME
 *    name shadows the global one (`SystemPrompt.assemble` merges by name), and
 *    an empty section is dropped at render (`renderPrompt` filters on
 *    `text.length > 0`). Registering that name returning `''` therefore removes
 *    the block for that agent alone.
 *
 * Both are scoped registrations, so disposing them restores the previous state
 * exactly — that is what makes the switch reversible without a restart.
 *
 * @module dsh-rea-toggle
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'

/** Prefix `dsh-mcp-client` gives every tool of a server it bridges. */
const TOOL_PREFIX = 'mcp__'

/** File remembering the switch's position, under $DSH_HOME. */
const STATE_FILE = 'rea-toggle.json'

/** The one-line answer both the command and the UI show, in both languages. */
const SENTENCE = {
  on: 'REA context: ON — its tools and instructions are visible to the model. · REA 上下文：开',
  off: 'REA context: OFF — its tools and instructions are out of the model context. · REA 上下文：关',
}

export const name = 'rea-toggle'

/**
 * Core services only. A profile without any of these has no agent loop to
 * switch context for in the first place, so a hard dependency is honest.
 * `commands` and `webServer` are picked up optionally, because a headless
 * profile legitimately has neither.
 */
export const inject = ['tools', 'agents', 'systemPrompt']

/**
 * Resolve the per-user DSH home the way the host does, so the remembered
 * position survives a restart and stays out of the profile tree.
 * @returns the absolute directory path.
 */
function dshHome() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv.trim()
  const home = process.env.USERPROFILE || process.env.HOME || '.'
  const separator = home.endsWith('\\') || home.endsWith('/') ? '' : '/'
  return `${home}${separator}.dsh`
}

/**
 * The MCP servers this instance governs.
 *
 * `servers` is the plural form and wins when present; `server` stays supported
 * because a single server is by far the common case. Both are read defensively:
 * the row config is user-authored YAML and a wrong shape must not take the
 * plugin down.
 * @param config - the row's `config` object, possibly empty.
 * @returns at least one server name, without duplicates.
 */
export function resolveServers(config) {
  const names = []
  const push = value => {
    if (typeof value === 'string' && value.trim() !== '') names.push(value.trim())
  }
  if (Array.isArray(config?.servers)) for (const value of config.servers) push(value)
  push(config?.server)
  if (names.length === 0) names.push('rea')
  return [...new Set(names)]
}

export function apply(ctx, config) {
  const servers = resolveServers(config)
  /** `mcp__rea__`, `mcp__ghidra__`, … — one per governed server. */
  const prefixes = servers.map(server => `${TOOL_PREFIX}${server}__`)
  /** `mcp:rea`, `mcp:ghidra`, … — the section names `dsh-mcp-client` uses. */
  const sections = servers.map(server => `mcp:${server}`)
  const statePath = `${dshHome()}/${STATE_FILE}`

  /** Live position. `true` = REA context visible, i.e. the pre-install behaviour. */
  let enabled = true
  /** Per covered agent: the exact disposers installed for it, newest last. */
  const covered = new Map()
  /** Re-entrancy latch: our own registrations emit `tools/change`. */
  let reconciling = false

  // --- remembered position ---------------------------------------------------

  // Read once at load. A missing or unreadable file is not an error: it means
  // "never switched", which is the default-on behaviour.
  try {
    const parsed = JSON.parse(readFileSync(statePath, 'utf8'))
    if (typeof parsed?.enabled === 'boolean') enabled = parsed.enabled
  } catch {
    /* first run, or no permission to read it */
  }

  /**
   * Persist the position so it survives a restart.
   * @returns whether the write succeeded.
   */
  function savePosition() {
    try {
      mkdirSync(dshHome(), { recursive: true })
      writeFileSync(
        statePath,
        `${JSON.stringify({ enabled, servers, updatedAt: new Date().toISOString() }, null, 2)}\n`,
        'utf8',
      )
      return true
    } catch (error) {
      ctx.logger?.warn?.(`rea-toggle: could not save ${statePath}: ${String(error)}`)
      return false
    }
  }

  // --- per-agent coverage ----------------------------------------------------

  /**
   * The governed servers' tool names as the registry currently knows them.
   *
   * `restrict()` rejects names it cannot see, and `restrictableNames` is exactly
   * that set — deriving the deny list from it keeps the two in agreement across
   * a reconnect that changes the tool set.
   * @param agent - the agent whose scope to read.
   * @returns the governed tool names, or an empty array.
   */
  function toolNamesFor(agent) {
    let names
    try {
      names = ctx.tools.view(agent).restrictableNames
    } catch {
      return []
    }
    if (names === undefined) return []
    return [...names].filter(toolName => prefixes.some(prefix => toolName.startsWith(prefix)))
  }

  /**
   * Install the "off" state for one agent.
   *
   * Both registrations go through the agent's own context, so they land in that
   * agent's scope layer and can be lifted individually. The returned disposers
   * belong to the agent's fiber, not to this plugin's, so the plugin keeps them
   * and lifts them itself — see the teardown effect below.
   * @param agent - the live agent to cover.
   * @returns whether the agent is covered after the call.
   */
  function cover(agent) {
    if (covered.has(agent.id)) return true

    const names = toolNamesFor(agent)
    const disposers = []
    try {
      if (names.length > 0) {
        disposers.push(agent.ctx.tools.restrict({ deny: names }))
      }
      for (const section of sections) {
        disposers.push(
          agent.ctx.systemPrompt.section({
            name: section,
            order: agent.ctx.systemPrompt.getSectionOrder('MCP_SERVERS'),
            interpolate: false,
            text: () => '',
          }),
        )
      }
    } catch (error) {
      // A half-covered agent is worse than an uncovered one: undo, and let the
      // next event try again.
      for (const dispose of disposers.reverse()) {
        try {
          dispose()
        } catch {
          /* its fiber is already gone */
        }
      }
      ctx.logger?.warn?.(`rea-toggle: could not cover agent ${agent.id}: ${String(error)}`)
      return false
    }

    covered.set(agent.id, disposers)
    return true
  }

  /**
   * Lift the "off" state for one agent, restoring the inherited context.
   * @param agentId - the agent to uncover.
   */
  function uncover(agentId) {
    const disposers = covered.get(agentId)
    if (disposers === undefined) return
    covered.delete(agentId)
    for (const dispose of disposers.reverse()) {
      try {
        dispose()
      } catch (error) {
        ctx.logger?.warn?.(`rea-toggle: teardown for ${agentId} failed: ${String(error)}`)
      }
    }
  }

  /** Lift every agent's coverage. Used by teardown and by turning the switch on. */
  function uncoverAll() {
    for (const id of [...covered.keys()]) uncover(id)
  }

  /**
   * Bring every live agent in line with the current position.
   *
   * A full pass rather than a diff: the live agent set and the governed tool set
   * both change underneath us, and the registry is small enough that re-deriving
   * is cheaper than reasoning about staleness. The latch is load-bearing —
   * registering a restriction emits `tools/change`, which calls back here.
   * @param fresh - reinstall even for agents already covered (the tool set moved).
   */
  function reconcile(fresh = false) {
    if (reconciling) return
    reconciling = true
    try {
      let agents
      try {
        agents = ctx.agents.list()
      } catch (error) {
        ctx.logger?.warn?.(`rea-toggle: could not list agents: ${String(error)}`)
        return
      }

      // Forget agents that are gone, so a resumed id can be covered again.
      const live = new Set(agents.map(agent => agent.id))
      for (const id of [...covered.keys()]) if (!live.has(id)) covered.delete(id)

      if (enabled) {
        uncoverAll()
        return
      }
      for (const agent of agents) {
        if (fresh) uncover(agent.id)
        cover(agent)
      }
    } finally {
      reconciling = false
    }
  }

  // --- the switch ------------------------------------------------------------

  /**
   * Move the switch and apply it immediately.
   * @param next - the desired position; omitted flips it.
   * @returns the position after the call.
   */
  function setEnabled(next) {
    enabled = typeof next === 'boolean' ? next : !enabled
    savePosition()
    reconcile(true)
    return enabled
  }

  /**
   * Describe what the switch currently does and how much it is hiding.
   * @returns a JSON-safe summary for the Client button and the slash command.
   */
  function status() {
    let tools = 0
    try {
      const first = ctx.agents.list()[0]
      if (first !== undefined) tools = toolNamesFor(first).length
    } catch {
      /* reported as zero */
    }
    return { enabled, servers, agents: covered.size, tools, statePath }
  }

  /**
   * The one-line answer both the command and the UI use.
   * @param state - the position to describe.
   * @returns bilingual text.
   */
  function sentence(state) {
    return state ? SENTENCE.on : SENTENCE.off
  }

  // --- wiring ----------------------------------------------------------------

  // Teardown. These disposers live on the agents' fibers, so disposing this
  // plugin does NOT take them with it; without this effect a config reload
  // would leave every live agent permanently stripped.
  ctx.effect(() => () => uncoverAll(), 'rea-toggle: lift coverage on unload')

  // A new agent — every subagent included — must be covered before its first
  // step. `agent/created` is serial and awaited by the registry, so installing
  // here lands inside the announcement, ahead of any assembly.
  ctx.effect(
    () =>
      ctx.on('agent/created', ({ agent }) => {
        if (!enabled) cover(agent)
      }),
    'rea-toggle: cover new agents',
  )

  // The agent's own fiber teardown already dropped the registrations; forget the
  // bookkeeping so a resumed id can be covered again.
  ctx.effect(
    () =>
      ctx.on('agent/disposed', ({ agent }) => {
        covered.delete(agent.id)
      }),
    'rea-toggle: forget disposed agents',
  )

  // A reconnect (or the server's first successful sync) re-registers the tool
  // set, so a restriction derived earlier can miss names added later.
  ctx.effect(
    () =>
      ctx.on('tools/change', () => {
        if (!enabled) reconcile(true)
      }),
    'rea-toggle: follow tool registry changes',
  )

  // The slash command: the keyboard path to the same switch.
  ctx.inject(['commands'], commandCtx => {
    commandCtx.effect(
      () =>
        commandCtx.commands.register({
          name: 'rea',
          description:
            'Turn the REA reverse-engineering context on or off: /rea on, /rea off, /rea status. · 开关 REA 逆向工具上下文',
          handler: async ({ rawInput }) => {
            const argument = String(rawInput ?? '').trim().toLowerCase()
            if (argument === 'on' || argument === 'enable') {
              return { kind: 'success', text: sentence(setEnabled(true)) }
            }
            if (argument === 'off' || argument === 'disable') {
              return { kind: 'success', text: sentence(setEnabled(false)) }
            }
            if (argument === '') {
              return { kind: 'success', text: `${sentence(enabled)} — /rea on | /rea off` }
            }
            if (argument === 'status') return { kind: 'success', text: sentence(enabled) }
            if (argument === 'toggle') return { kind: 'success', text: sentence(setEnabled(undefined)) }
            return {
              kind: 'error',
              text: `unknown argument "${argument}" — use on, off, status, or toggle`,
            }
          },
        }),
      'rea-toggle: /rea command',
    )
  })

  // The HTTP surface the Client half talks to. Registered on the bare webServer
  // as an exact route — the same shape the installed bundles use, so it does not
  // travel through the /api prefix fence.
  ctx.inject(['webServer'], hostCtx => {
    hostCtx.effect(
      () =>
        hostCtx.webServer.register({
          kind: 'exact',
          path: '/rea-toggle/state',
          handler: (request, response) => {
            const reply = (code, payload) => {
              response.writeHead(code, {
                'content-type': 'application/json; charset=utf-8',
                'cache-control': 'no-store',
              })
              response.end(JSON.stringify(payload))
            }

            const method = String(request.method ?? 'GET').toUpperCase()
            if (method === 'GET') return reply(200, status())
            if (method !== 'POST') {
              response.writeHead(405, { allow: 'GET, POST' })
              response.end()
              return
            }

            const chunks = []
            request.on('data', chunk => chunks.push(chunk))
            request.on('end', () => {
              let desired
              try {
                const body = Buffer.concat(chunks).toString('utf8')
                if (body.trim() !== '') desired = JSON.parse(body)?.enabled
              } catch {
                return reply(400, { error: 'body must be JSON: { "enabled": boolean }' })
              }
              if (desired !== undefined && typeof desired !== 'boolean') {
                return reply(400, { error: '"enabled" must be a boolean' })
              }
              setEnabled(desired)
              return reply(200, status())
            })
          },
        }),
      'rea-toggle: /rea-toggle/state',
    )
  })

  // Cover whatever already exists. REA may not have connected yet at this point;
  // the `tools/change` listener above covers that case when it does.
  if (!enabled) reconcile(true)
}
