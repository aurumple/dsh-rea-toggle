/**
 * Behavioural tests for the Host half.
 *
 * There is no DSH runtime to boot here, so this file builds a small model of
 * the three contracts the plugin depends on — the tool view, the prompt section
 * merge, and the agent registry — and drives the real `apply()` against it.
 *
 * The point is not to re-test DSH. It is to pin the plugin's own promises: what
 * "off" removes, that "on" restores it exactly, that the position survives a
 * restart, and that the HTTP surface the Client half talks to behaves.
 */

import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply, resolveServers } from '../lib/index.js'

/** A global tool set shaped like a profile with REA connected. */
const GLOBAL_TOOLS = [
  'read',
  'write',
  'bash',
  'run_code',
  'mcp__rea__binary_session',
  'mcp__rea__inspect_android_package',
  'mcp__rea__decompile_method',
  'mcp__other__ping',
]

/** The global prompt layer `dsh-mcp-client` leaves behind. */
const GLOBAL_SECTIONS = new Map([
  ['mcp:rea', () => 'REA server instructions, several kilobytes of them.'],
  ['mcp:other', () => 'Another server.'],
])

/**
 * Build a fake Host context that models the three real contracts.
 * @param options - `tools` overrides the global tool set.
 * @returns the context plus the handles assertions read.
 */
function makeCtx({ tools = GLOBAL_TOOLS } = {}) {
  const globalTools = [...tools]

  /** agentId -> Set of tool names still denied in that scope. */
  const denials = new Map()
  /** agentId -> Map of section name -> definition registered in that scope. */
  const scopedSections = new Map()
  /** agentId -> Set of tool names the registry has, per agent. */
  const agents = new Map()

  const listeners = new Map()
  const routes = []
  const commands = []
  const warnings = []
  const effects = []

  function emit(event, payload) {
    for (const handler of listeners.get(event) ?? []) handler(payload)
  }

  function agentOf(id) {
    return {
      id,
      ctx: {
        tools: {
          restrict({ deny }) {
            const set = denials.get(id) ?? new Set()
            for (const name of deny) set.add(name)
            denials.set(id, set)
            emit('tools/change', {})
            let done = false
            return () => {
              if (done) return
              done = true
              for (const name of deny) set.delete(name)
              if (set.size === 0) denials.delete(id)
              emit('tools/change', {})
            }
          },
        },
        systemPrompt: {
          getSectionOrder: kind => (kind === 'MCP_SERVERS' ? 3100 : 0),
          section(definition) {
            const map = scopedSections.get(id) ?? new Map()
            map.set(definition.name, definition)
            scopedSections.set(id, map)
            let done = false
            return () => {
              if (done) return
              done = true
              map.delete(definition.name)
              if (map.size === 0) scopedSections.delete(id)
            }
          },
        },
      },
    }
  }

  const ctx = {
    logger: {
      warn: message => warnings.push(String(message)),
      info() {},
      error() {},
    },
    tools: {
      view(agent) {
        const denied = denials.get(agent.id) ?? new Set()
        return { restrictableNames: globalTools.filter(name => !denied.has(name)) }
      },
    },
    agents: {
      list: () => [...agents.values()],
    },
    systemPrompt: {
      getSectionOrder: kind => (kind === 'MCP_SERVERS' ? 3100 : 0),
    },
    effect(factory) {
      const dispose = factory()
      effects.push(dispose)
      return dispose
    },
    on(event, handler) {
      const set = listeners.get(event) ?? new Set()
      set.add(handler)
      listeners.set(event, set)
      return () => set.delete(handler)
    },
    inject(_deps, callback) {
      callback({
        effect: factory => ctx.effect(factory),
        webServer: {
          register(route) {
            routes.push(route)
            return () => {
              const at = routes.indexOf(route)
              if (at !== -1) routes.splice(at, 1)
            }
          },
        },
        commands: {
          register(command) {
            commands.push(command)
            return () => {
              const at = commands.indexOf(command)
              if (at !== -1) commands.splice(at, 1)
            }
          },
        },
      })
    },
  }

  // The main agent exists before the plugin is applied, as in a live session.
  agents.set('main', agentOf('main'))

  return {
    ctx,
    routes,
    commands,
    warnings,
    effects,
    emit,
    /** Tools the model would actually see for one agent. */
    visibleTools(id) {
      const denied = denials.get(id) ?? new Set()
      return globalTools.filter(name => !denied.has(name))
    },
    /** The prompt as `SystemPrompt.assemble` would render it for one agent. */
    assembledPrompt(id) {
      const merged = new Map()
      for (const [name, render] of GLOBAL_SECTIONS) merged.set(name, { text: render(), owner: 'global' })
      for (const [name, definition] of scopedSections.get(id) ?? new Map()) {
        merged.set(name, { text: definition.text(), owner: 'scoped' })
      }
      return [...merged.entries()]
        .map(([name, entry]) => ({ name, text: entry.text, owner: entry.owner }))
        .filter(entry => entry.text.length > 0)
    },
    /** Whether a scoped section is currently installed for one agent. */
    scopedSectionNames(id) {
      return [...(scopedSections.get(id) ?? new Map()).keys()]
    },
    /** Add an agent the way the registry would, announcing it first. */
    spawn(id) {
      const agent = agentOf(id)
      agents.set(id, agent)
      emit('agent/created', { agent })
      return agent
    },
    /** Remove an agent, as its fiber teardown would. */
    reap(id) {
      const agent = agents.get(id)
      agents.delete(id)
      denials.delete(id)
      scopedSections.delete(id)
      emit('agent/disposed', { agent })
    },
  }
}

/**
 * Drive the plugin's own HTTP route the way the browser would.
 * @param host - the fake host whose routes to use.
 * @param method - HTTP verb.
 * @param body - request body, already serialized.
 * @returns status and parsed payload.
 */
async function callRoute(host, method, body) {
  const route = host.routes.find(entry => entry.path === '/rea-toggle/state')
  assert.ok(route, 'the state route must be registered')

  return await new Promise(resolve => {
    const request = {
      method,
      on(event, handler) {
        if (event === 'data' && body !== undefined) handler(Buffer.from(body))
        if (event === 'end') handler()
        return request
      },
    }
    const response = {
      statusCode: 0,
      headers: {},
      payload: undefined,
      writeHead(code, headers) {
        this.statusCode = code
        this.headers = headers ?? {}
      },
      end(text) {
        this.payload = text === undefined ? undefined : JSON.parse(text)
        resolve({ status: this.statusCode, headers: this.headers, payload: this.payload })
      },
    }
    route.handler(request, response)
  })
}

/** Read the state file the plugin writes. */
function readState() {
  return JSON.parse(readFileSync(join(process.env.DSH_HOME, 'rea-toggle.json'), 'utf8'))
}

let home
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'rea-toggle-'))
  process.env.DSH_HOME = home
})
afterEach(() => {
  delete process.env.DSH_HOME
  rmSync(home, { recursive: true, force: true })
})

describe('resolveServers', () => {
  it('defaults to rea', () => {
    assert.deepEqual(resolveServers(undefined), ['rea'])
    assert.deepEqual(resolveServers({}), ['rea'])
  })

  it('accepts a single server and a list, without duplicates', () => {
    assert.deepEqual(resolveServers({ server: 'ghidra' }), ['ghidra'])
    assert.deepEqual(resolveServers({ servers: ['rea', 'ghidra'] }), ['rea', 'ghidra'])
    assert.deepEqual(resolveServers({ servers: ['rea'], server: 'rea' }), ['rea'])
  })

  it('ignores junk instead of throwing', () => {
    assert.deepEqual(resolveServers({ server: '  ', servers: [1, null, ''] }), ['rea'])
  })
})

describe('default position', () => {
  it('starts on, so installing the plugin changes nothing by itself', () => {
    const host = makeCtx()
    apply(host.ctx, {})

    assert.ok(host.visibleTools('main').includes('mcp__rea__binary_session'))
    assert.ok(host.assembledPrompt('main').some(entry => entry.name === 'mcp:rea'))
  })

  it('starts off when the remembered position is off', () => {
    writeFileSync(join(home, 'rea-toggle.json'), JSON.stringify({ enabled: false }), 'utf8')
    const host = makeCtx()
    apply(host.ctx, {})

    assert.ok(!host.visibleTools('main').some(name => name.startsWith('mcp__rea__')))
  })
})

describe('turning it off', () => {
  it('removes every governed tool and the prompt block for the live agent', async () => {
    const host = makeCtx()
    apply(host.ctx, {})

    const result = await callRoute(host, 'POST', JSON.stringify({ enabled: false }))
    assert.equal(result.status, 200)
    assert.equal(result.payload.enabled, false)

    const visible = host.visibleTools('main')
    assert.deepEqual(
      visible.filter(name => name.startsWith('mcp__rea__')),
      [],
      'no REA tool may remain visible',
    )
    assert.ok(!host.assembledPrompt('main').some(entry => entry.name === 'mcp:rea'))
  })

  it('leaves other tools, other servers, and run_code alone', async () => {
    const host = makeCtx()
    apply(host.ctx, {})

    await callRoute(host, 'POST', JSON.stringify({ enabled: false }))

    const visible = host.visibleTools('main')
    for (const name of ['read', 'write', 'bash', 'run_code', 'mcp__other__ping']) {
      assert.ok(visible.includes(name), `${name} must survive`)
    }
    assert.ok(host.assembledPrompt('main').some(entry => entry.name === 'mcp:other'))
  })

  it('covers agents created afterwards, before their first step', async () => {
    const host = makeCtx()
    apply(host.ctx, {})
    await callRoute(host, 'POST', JSON.stringify({ enabled: false }))

    host.spawn('subagent-1')

    assert.deepEqual(
      host.visibleTools('subagent-1').filter(name => name.startsWith('mcp__rea__')),
      [],
    )
    assert.deepEqual(host.scopedSectionNames('subagent-1'), ['mcp:rea'])
  })

  it('re-covers when the registry announces a tool set change', async () => {
    const host = makeCtx({ tools: [...GLOBAL_TOOLS] })
    apply(host.ctx, {})
    await callRoute(host, 'POST', JSON.stringify({ enabled: false }))

    // A reconnect registers a tool the earlier deny list could not have known.
    GLOBAL_TOOLS.push('mcp__rea__brand_new_tool')
    try {
      host.emit('tools/change', {})
      assert.ok(
        !host.visibleTools('main').includes('mcp__rea__brand_new_tool'),
        'a tool added by a reconnect must be denied too',
      )
    } finally {
      GLOBAL_TOOLS.pop()
    }
  })

  it('does not recurse on the tools/change its own restriction emits', async () => {
    const host = makeCtx()
    apply(host.ctx, {})
    await callRoute(host, 'POST', JSON.stringify({ enabled: false }))
    assert.deepEqual(host.warnings, [])
  })
})

describe('turning it back on', () => {
  it('restores the exact pre-switch state', async () => {
    const host = makeCtx()
    apply(host.ctx, {})

    const before = host.visibleTools('main')
    const promptBefore = host.assembledPrompt('main')

    await callRoute(host, 'POST', JSON.stringify({ enabled: false }))
    const result = await callRoute(host, 'POST', JSON.stringify({ enabled: true }))

    assert.equal(result.payload.enabled, true)
    assert.deepEqual(host.visibleTools('main'), before)
    assert.deepEqual(host.assembledPrompt('main'), promptBefore)
    assert.deepEqual(host.scopedSectionNames('main'), [])
  })

  it('flips when the body omits enabled', async () => {
    const host = makeCtx()
    apply(host.ctx, {})

    assert.equal((await callRoute(host, 'POST', '{}')).payload.enabled, false)
    assert.equal((await callRoute(host, 'POST', '{}')).payload.enabled, true)
  })
})

describe('persistence', () => {
  it('writes the position, and a fresh apply reads it back', async () => {
    const first = makeCtx()
    apply(first.ctx, {})
    await callRoute(first, 'POST', JSON.stringify({ enabled: false }))

    assert.deepEqual(readState().enabled, false)

    const second = makeCtx()
    apply(second.ctx, {})
    assert.ok(!second.visibleTools('main').some(name => name.startsWith('mcp__rea__')))
  })

  it('survives a corrupt state file by falling back to on', () => {
    writeFileSync(join(home, 'rea-toggle.json'), 'not json at all', 'utf8')
    const host = makeCtx()
    apply(host.ctx, {})
    assert.ok(host.visibleTools('main').includes('mcp__rea__binary_session'))
  })
})

describe('HTTP surface', () => {
  it('answers GET with the full status', async () => {
    const host = makeCtx()
    apply(host.ctx, {})

    const result = await callRoute(host, 'GET')
    assert.equal(result.status, 200)
    assert.equal(result.payload.enabled, true)
    assert.deepEqual(result.payload.servers, ['rea'])
    assert.equal(result.payload.tools, 3)
    assert.equal(result.payload.agents, 0)
    assert.ok(result.payload.statePath.endsWith('rea-toggle.json'))
    assert.match(result.headers['content-type'], /application\/json/)
  })

  it('rejects a non-boolean enabled', async () => {
    const host = makeCtx()
    apply(host.ctx, {})
    const result = await callRoute(host, 'POST', JSON.stringify({ enabled: 'yes' }))
    assert.equal(result.status, 400)
    assert.match(result.payload.error, /boolean/)
  })

  it('rejects a malformed body', async () => {
    const host = makeCtx()
    apply(host.ctx, {})
    const result = await callRoute(host, 'POST', '{oops')
    assert.equal(result.status, 400)
    assert.match(result.payload.error, /JSON/)
  })

  it('refuses other verbs', async () => {
    const host = makeCtx()
    apply(host.ctx, {})
    const result = await callRoute(host, 'DELETE')
    assert.equal(result.status, 405)
    assert.equal(result.headers.allow, 'GET, POST')
  })
})

describe('the /rea command', () => {
  it('moves the switch and reports it', async () => {
    const host = makeCtx()
    apply(host.ctx, {})
    const command = host.commands.find(entry => entry.name === 'rea')
    assert.ok(command, '/rea must be registered')

    const off = await command.handler({ rawInput: 'off' })
    assert.equal(off.kind, 'success')
    assert.match(off.text, /OFF/)
    assert.ok(!host.visibleTools('main').some(name => name.startsWith('mcp__rea__')))

    const on = await command.handler({ rawInput: 'on' })
    assert.match(on.text, /ON/)
    assert.ok(host.visibleTools('main').includes('mcp__rea__binary_session'))
  })

  it('supports status, toggle, and rejects nonsense', async () => {
    const host = makeCtx()
    apply(host.ctx, {})
    const command = host.commands.find(entry => entry.name === 'rea')

    assert.match((await command.handler({ rawInput: 'status' })).text, /ON/)
    assert.match((await command.handler({ rawInput: 'toggle' })).text, /OFF/)
    assert.match((await command.handler({ rawInput: 'toggle' })).text, /ON/)
    assert.equal((await command.handler({ rawInput: 'wat' })).kind, 'error')
  })
})

describe('unload', () => {
  it('lifts every registration so the context comes back', async () => {
    const host = makeCtx()
    apply(host.ctx, {})
    await callRoute(host, 'POST', JSON.stringify({ enabled: false }))
    assert.ok(!host.visibleTools('main').some(name => name.startsWith('mcp__rea__')))

    // Disposing the plugin runs its teardown effect.
    for (const dispose of host.effects.reverse()) {
      if (typeof dispose === 'function') dispose()
    }

    assert.ok(host.visibleTools('main').includes('mcp__rea__binary_session'))
    assert.deepEqual(host.scopedSectionNames('main'), [])
  })

  it('forgets a disposed agent so a resumed id can be covered again', async () => {
    const host = makeCtx()
    apply(host.ctx, {})
    await callRoute(host, 'POST', JSON.stringify({ enabled: false }))

    host.reap('main')
    host.spawn('main')

    assert.ok(!host.visibleTools('main').some(name => name.startsWith('mcp__rea__')))
  })
})
