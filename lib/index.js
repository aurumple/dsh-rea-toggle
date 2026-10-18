/**
 * dsh-rea-toggle — host half.
 *
 * One switch per conversation over the REA MCP server's share of the model
 * context. REA registers 207 tool schemas plus a multi-kilobyte
 * server-instructions block; `dsh-mcp-client` puts both on the GLOBAL layer, so
 * every agent pays for them whether or not the task is a reverse-engineering
 * task.
 *
 * In DSH an agent IS a conversation: `Agent.id` is the same `SessionId` the
 * composer sends, so "per conversation" and "per agent" are the same key.
 *
 * Two independent mechanisms are needed, because the two travel different paths:
 *
 * 1. Tools. `tools.restrict({ deny })` filters what a scope INHERITS from the
 *    global layer (`ToolRuntime.view`), and the model-facing schema list is
 *    rebuilt from that view on every assembly. The reserved `run_code`
 *    transport is appended outside the filterable layers, so it survives.
 * 2. Prompt. `dsh-mcp-client` registers the server instructions as a section
 *    named `mcp:<server>` at order `MCP_SERVERS`. `systemPrompt.section()`
 *    documents that "a scoped section shadows a global section with the same
 *    name", and an empty section is dropped at render (`renderPrompt` filters on
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

/** File remembering every conversation's position, under $DSH_HOME. */
const STATE_FILE = 'rea-toggle.json'

/** On-disk shape version. A file without it predates per-conversation state. */
const STATE_VERSION = 2

/**
 * How many conversations to remember.
 *
 * The key is a session id, so this map grows with use and would otherwise be
 * unbounded. Eviction is by least-recently-changed: a conversation that has not
 * been touched in hundreds of others is not one whose switch position anyone
 * will miss, and it simply falls back to the default.
 */
const MAX_SESSIONS = 500

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
 * Resolve the per-user DSH home the way the host does, so remembered positions
 * survive a restart and stay out of the profile tree.
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

/**
 * Read the remembered positions.
 *
 * A file this plugin cannot parse, or one written by a version that had a
 * single process-wide position, yields an empty map rather than an error:
 * "never switched" and "switched before per-conversation state existed" both
 * mean the conversation has no recorded position, and the default answers it.
 * @param path - absolute state file path.
 * @returns session id -> { enabled, updatedAt }.
 */
export function loadSessions(path) {
  const sessions = new Map()
  let parsed
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return sessions
  }
  if (parsed?.version !== STATE_VERSION || typeof parsed.sessions !== 'object' || parsed.sessions === null) {
    return sessions
  }
  for (const [session, entry] of Object.entries(parsed.sessions)) {
    if (typeof entry?.enabled !== 'boolean') continue
    sessions.set(session, {
      enabled: entry.enabled,
      updatedAt: typeof entry.updatedAt === 'string' ? entry.updatedAt : '',
    })
  }
  return sessions
}

/**
 * Read one query parameter without assuming the request URL is absolute.
 * @param url - the raw request URL.
 * @param name - the parameter to read.
 * @returns the value, or undefined.
 */
function queryParam(url, name) {
  const text = String(url ?? '')
  const at = text.indexOf('?')
  if (at === -1) return undefined
  const value = new URLSearchParams(text.slice(at + 1)).get(name)
  return value === null || value === '' ? undefined : value
}

export function apply(ctx, config) {
  const servers = resolveServers(config)
  /** `mcp__rea__`, `mcp__ghidra__`, … — one per governed server. */
  const prefixes = servers.map(server => `${TOOL_PREFIX}${server}__`)
  /** `mcp:rea`, `mcp:ghidra`, … — the section names `dsh-mcp-client` uses. */
  const sections = servers.map(server => `mcp:${server}`)
  const statePath = `${dshHome()}/${STATE_FILE}`

  /**
   * Position for a conversation nobody has switched yet.
   *
   * Off is the default: a fresh conversation is far more often ordinary work
   * than reverse engineering, and the whole point of the plugin is to stop
   * paying for those schemas on turns that cannot use them. `defaultEnabled`
   * flips it back for anyone who wants the opposite.
   */
  const defaultEnabled = config?.defaultEnabled === true

  /** session id -> { enabled, updatedAt } — only conversations switched by hand. */
  const sessions = loadSessions(statePath)
  /** agent id -> owning agent id, or undefined for a root. */
  const parentOf = new Map()
  /** agent id -> the conversation it belongs to. */
  const sessionOf = new Map()
  /** agent id -> whether the switch is off for it. */
  const desired = new Map()
  /** agent id -> the exact disposers installed for it. */
  const covered = new Map()
  /** Re-entrancy latch: our own registrations emit `tools/change`. */
  let reconciling = false

  // --- remembered positions --------------------------------------------------

  /** Drop the least recently changed conversations once the map outgrows its cap. */
  function pruneSessions() {
    if (sessions.size <= MAX_SESSIONS) return
    const oldest = [...sessions.entries()].sort((a, b) =>
      String(a[1].updatedAt).localeCompare(String(b[1].updatedAt)),
    )
    for (const [session] of oldest.slice(0, sessions.size - MAX_SESSIONS)) sessions.delete(session)
  }

  /**
   * Persist every remembered position.
   * @returns whether the write succeeded.
   */
  function saveSessions() {
    pruneSessions()
    try {
      mkdirSync(dshHome(), { recursive: true })
      const shaped = Object.fromEntries(
        [...sessions.entries()].sort((a, b) => String(a[1].updatedAt).localeCompare(String(b[1].updatedAt))),
      )
      writeFileSync(
        statePath,
        `${JSON.stringify({ version: STATE_VERSION, servers, sessions: shaped }, null, 2)}\n`,
        'utf8',
      )
      return true
    } catch (error) {
      ctx.logger?.warn?.(`rea-toggle: could not save ${statePath}: ${String(error)}`)
      return false
    }
  }

  /**
   * The position a conversation should have when it has no recorded one.
   * @param session - the conversation id.
   * @returns whether REA is visible for it.
   */
  function positionFor(session) {
    const recorded = sessions.get(session)
    return recorded === undefined ? defaultEnabled : recorded.enabled
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

  /** Lift every agent's coverage. Used by teardown and by a plugin-level unload. */
  function uncoverAll() {
    for (const id of [...covered.keys()]) uncover(id)
  }

  /**
   * Put one live agent in line with its own position.
   * @param agent - the live agent.
   */
  function applyTo(agent) {
    if (desired.get(agent.id) === false) cover(agent)
    else uncover(agent.id)
  }

  /**
   * Re-derive what every live agent should be showing and make it so.
   *
   * A full pass rather than a diff: the live agent set and the governed tool set
   * both change underneath us, and the registry is small enough that re-deriving
   * is cheaper than reasoning about staleness.
   *
   * The latch is load-bearing and must wrap EVERY registration and disposal this
   * plugin performs, including the lifting done for `fresh`. Its own
   * registrations emit `tools/change`, and a listener that lifts anything before
   * entering here would re-enter with the latch open — turning one event into an
   * unbounded register/dispose storm that never yields to the event loop.
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

      // Forget agents that are gone, so a resumed id starts clean.
      const live = new Set(agents.map(agent => agent.id))
      for (const id of [...covered.keys()]) if (!live.has(id)) covered.delete(id)
      for (const id of [...desired.keys()]) if (!live.has(id)) desired.delete(id)

      // A re-derivation drops every existing restriction first, so a deny list
      // derived before a reconnect cannot outlive the tool set it described.
      if (fresh) for (const id of [...covered.keys()]) uncover(id)

      for (const agent of agents) {
        // An agent the registry has but we never saw created (the plugin loaded
        // into a running profile) is a root of its own conversation.
        if (!sessionOf.has(agent.id)) adopt(agent, undefined)
        applyTo(agent)
      }
    } finally {
      reconciling = false
    }
  }

  // --- conversation bookkeeping ----------------------------------------------

  /**
   * Find the agent that owns a newly created one.
   *
   * `isOwnedBy` is the authoritative answer and is asked first: it reports
   * whether this exact child was created through that parent's scoped context.
   * `currentInitiator()` is the cheaper hint and is only trusted for an agent we
   * already track, because it reports whoever is running, which during an
   * unrelated chain need not be a parent at all.
   * @param agent - the agent just created.
   * @returns the owning agent, or undefined for a root conversation.
   */
  function ownerOf(agent) {
    let candidates = []
    try {
      candidates = ctx.agents.list()
    } catch {
      candidates = []
    }
    try {
      for (const candidate of candidates) {
        if (candidate.id === agent.id) continue
        if (ctx.agents.isOwnedBy?.(agent.id, candidate) === true) return candidate
      }
    } catch {
      /* ownership is a refinement, not a requirement */
    }
    try {
      const initiator = ctx.agents.currentInitiator?.()
      if (initiator !== undefined && initiator.id !== agent.id && sessionOf.has(initiator.id)) {
        return candidates.find(candidate => candidate.id === initiator.id) ?? initiator
      }
    } catch {
      /* no initiator boundary here */
    }
    return undefined
  }

  /**
   * Record a live agent's place in the conversation graph and its position.
   *
   * A subagent belongs to its parent's conversation and starts with the parent's
   * position: a conversation doing reverse-engineering work spawned a subagent
   * to do that work, and handing it a default silently breaks the task it was
   * created for.
   * @param agent - the live agent.
   * @param owner - its owning agent, or undefined for a root.
   */
  function adopt(agent, owner) {
    if (owner !== undefined) {
      parentOf.set(agent.id, owner.id)
      sessionOf.set(agent.id, sessionOf.get(owner.id) ?? owner.id)
      desired.set(agent.id, desired.get(owner.id) ?? positionFor(sessionOf.get(agent.id)))
      return
    }
    parentOf.set(agent.id, undefined)
    sessionOf.set(agent.id, agent.id)
    desired.set(agent.id, positionFor(agent.id))
  }

  /** Forget everything recorded for one agent. */
  function forget(agentId) {
    covered.delete(agentId)
    desired.delete(agentId)
    sessionOf.delete(agentId)
    parentOf.delete(agentId)
  }

  // --- the switch ------------------------------------------------------------

  /**
   * Move one conversation's switch and apply it to that conversation's agents.
   * @param session - the conversation id.
   * @param next - the desired position; omitted flips it.
   * @returns the position after the call.
   */
  function setPosition(session, next) {
    const current = positionFor(session)
    const enabled = typeof next === 'boolean' ? next : !current
    sessions.set(session, { enabled, updatedAt: new Date().toISOString() })
    saveSessions()

    // Every live agent of that conversation follows, subagents included.
    let agents = []
    try {
      agents = ctx.agents.list()
    } catch {
      agents = []
    }
    for (const agent of agents) {
      if (sessionOf.get(agent.id) !== session) continue
      desired.set(agent.id, enabled)
    }
    reconcile()
    return enabled
  }

  /**
   * Describe one conversation's switch.
   * @param session - the conversation id, or undefined for a summary.
   * @returns a JSON-safe object for the Client button and the slash command.
   */
  function statusFor(session) {
    const live = (() => {
      try {
        return ctx.agents.list()
      } catch {
        return []
      }
    })()
    const tools = live.length === 0 ? 0 : toolNamesFor(live[0]).length

    if (session === undefined) {
      return {
        session: null,
        defaultEnabled,
        servers,
        conversations: [...sessions.entries()]
          .sort((a, b) => String(b[1].updatedAt).localeCompare(String(a[1].updatedAt)))
          .map(([id, entry]) => ({ session: id, enabled: entry.enabled, updatedAt: entry.updatedAt })),
        agents: covered.size,
        tools,
        statePath,
      }
    }

    const enabled = positionFor(session)
    return {
      session,
      enabled,
      known: sessions.has(session),
      defaultEnabled,
      servers,
      agents: live.filter(agent => sessionOf.get(agent.id) === session && covered.has(agent.id)).length,
      tools,
      statePath,
    }
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

  // A new agent — every new conversation and every subagent — must be in its
  // final position before its first step. `agent/created` is serial and awaited
  // by the registry, so installing here lands inside the announcement, ahead of
  // any assembly.
  ctx.effect(
    () =>
      ctx.on('agent/created', ({ agent }) => {
        adopt(agent, ownerOf(agent))
        applyTo(agent)
      }),
    'rea-toggle: position new agents',
  )

  // The agent's own fiber teardown already dropped the registrations; forget the
  // bookkeeping so a resumed id starts clean.
  ctx.effect(
    () =>
      ctx.on('agent/disposed', ({ agent }) => {
        forget(agent.id)
      }),
    'rea-toggle: forget disposed agents',
  )

  // A reconnect (or the server's first successful sync) re-registers the tool
  // set, so a restriction derived earlier can miss names added later. Only
  // conversations that should be off need re-deriving; when none is, this
  // listener does nothing at all.
  //
  // Every registration this plugin makes emits `tools/change`, so re-deriving
  // must happen entirely inside `reconcile`'s latch. Doing any lifting out here
  // — even just dropping a stale restriction — re-enters this handler with the
  // latch still open, and each disposal that follows re-enters it again: one
  // external event becomes thousands of register/dispose pairs and the event
  // loop never returns. That is a wedged UI, not a slow switch.
  ctx.effect(
    () =>
      ctx.on('tools/change', () => {
        if (reconciling) return
        if (![...desired.values()].some(enabled => enabled === false)) return
        reconcile(true)
      }),
    'rea-toggle: follow tool registry changes',
  )

  // The slash command: the keyboard path to the same switch, for the
  // conversation the command was typed in.
  ctx.inject(['commands'], commandCtx => {
    commandCtx.effect(
      () =>
        commandCtx.commands.register({
          name: 'rea',
          description:
            'Turn the REA reverse-engineering context on or off for THIS conversation: /rea on, /rea off, /rea status. · 开关本对话的 REA 逆向工具上下文',
          handler: async invocation => {
            const session = sessionOf.get(invocation.agent.id) ?? invocation.agent.id
            const argument = String(invocation.rawInput ?? '').trim().toLowerCase()
            if (argument === 'on' || argument === 'enable') {
              return { kind: 'success', text: sentence(setPosition(session, true)) }
            }
            if (argument === 'off' || argument === 'disable') {
              return { kind: 'success', text: sentence(setPosition(session, false)) }
            }
            if (argument === '') {
              return {
                kind: 'success',
                text: `${sentence(positionFor(session))} — /rea on | /rea off`,
              }
            }
            if (argument === 'status') return { kind: 'success', text: sentence(positionFor(session)) }
            if (argument === 'toggle') return { kind: 'success', text: sentence(setPosition(session, undefined)) }
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
  // travel through the /api prefix fence. The conversation is a query parameter
  // on GET and a body field on POST: the pill always knows which one it is
  // showing, and a request that does not say cannot be answered for it.
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
            if (method === 'GET') {
              return reply(200, statusFor(queryParam(request.url, 'session')))
            }
            if (method !== 'POST') {
              response.writeHead(405, { allow: 'GET, POST' })
              response.end()
              return
            }

            const chunks = []
            request.on('data', chunk => chunks.push(chunk))
            request.on('end', () => {
              let body
              try {
                const text = Buffer.concat(chunks).toString('utf8')
                body = text.trim() === '' ? {} : JSON.parse(text)
              } catch {
                return reply(400, { error: 'body must be JSON: { "session": string, "enabled"?: boolean }' })
              }
              if (typeof body !== 'object' || body === null || Array.isArray(body)) {
                return reply(400, { error: 'body must be a JSON object' })
              }
              if (typeof body.session !== 'string' || body.session.trim() === '') {
                return reply(400, { error: '"session" must be the conversation id' })
              }
              if (body.enabled !== undefined && typeof body.enabled !== 'boolean') {
                return reply(400, { error: '"enabled" must be a boolean' })
              }
              const session = body.session.trim()
              setPosition(session, body.enabled)
              return reply(200, statusFor(session))
            })
          },
        }),
      'rea-toggle: /rea-toggle/state',
    )
  })

  // Position whatever already exists. REA may not have connected yet at this
  // point; the `tools/change` listener above covers that case when it does.
  reconcile()
}
