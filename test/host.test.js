/**
 * Behavioural tests for the Host half.
 *
 * There is no DSH runtime to boot here, so this file builds a small model of
 * the contracts the plugin depends on — the tool view, the prompt section
 * merge, and the agent registry with its ownership relation — and drives the
 * real `apply()` against it.
 *
 * The point is not to re-test DSH. It is to pin the plugin's own promises: that
 * the switch is per conversation, that a new conversation starts off, that a
 * subagent inherits its parent's position rather than the default, that turning
 * it on restores the previous state exactly, and that positions survive a
 * restart.
 */

import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply, loadSessions, resolveServers } from '../lib/index.js'

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
 * Build a fake Host context that models the real contracts.
 * @param options - `tools` overrides the global tool set.
 * @returns the context plus the handles assertions read.
 */
function makeCtx({ tools = GLOBAL_TOOLS } = {}) {
  const globalTools = [...tools]

  /** agentId -> Set of tool names still denied in that scope. */
  const denials = new Map()
  /** agentId -> Map of section name -> definition registered in that scope. */
  const scopedSections = new Map()
  /** agentId -> agent object. */
  const agents = new Map()
  /** "childId:parentId" -> true, the ownership relation. */
  const owned = new Set()

  const listeners = new Map()
  const routes = []
  const commands = []
  const warnings = []
  const effects = []

  /** Registration accounting, for the re-entrancy regression test. */
  const tally = { register: 0, dispose: 0, depth: 0, maxDepth: 0 }

  function emit(event, payload) {
    for (const handler of listeners.get(event) ?? []) handler(payload)
  }

  function agentOf(id) {
    return {
      id,
      ctx: {
        tools: {
          restrict({ deny }) {
            tally.register++
            tally.depth++
            tally.maxDepth = Math.max(tally.maxDepth, tally.depth)
            const set = denials.get(id) ?? new Set()
            for (const name of deny) set.add(name)
            denials.set(id, set)
            emit('tools/change', {})
            tally.depth--
            let done = false
            return () => {
              if (done) return
              done = true
              tally.dispose++
              for (const name of deny) set.delete(name)
              if (set.size === 0) denials.delete(id)
              emit('tools/change', {})
            }
          },
        },
        systemPrompt: {
          getSectionOrder: kind => (kind === 'MCP_SERVERS' ? 3100 : 0),
          section(definition) {
            tally.register++
            tally.depth++
            tally.maxDepth = Math.max(tally.maxDepth, tally.depth)
            const map = scopedSections.get(id) ?? new Map()
            map.set(definition.name, definition)
            scopedSections.set(id, map)
            emit('tools/change', {})
            tally.depth--
            let done = false
            return () => {
              if (done) return
              done = true
              tally.dispose++
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
      // `restrictableNames` is the set of names a scope MAY deny, i.e. what it
      // inherits from the global layer — not the post-restriction view. A denied
      // tool still appears here; that is why the plugin can re-derive its deny
      // list while already denying, and why `status.tools` stays a usable "did
      // it find the server at all" signal with the switch off.
      view() {
        return { restrictableNames: [...globalTools] }
      },
    },
    agents: {
      list: () => [...agents.values()],
      get: id => agents.get(id),
      isOwnedBy: (id, owner) => owned.has(`${id}:${owner.id}`),
      currentInitiator: () => undefined,
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

  // The first conversation exists before the plugin is applied, as in a live
  // session that installs the plugin mid-way.
  agents.set('conv-1', agentOf('conv-1'))

  return {
    ctx,
    routes,
    commands,
    warnings,
    effects,
    emit,
    /** Counters for the re-entrancy regression test. */
    counts() {
      return { ...tally }
    },
    /** Tools the model would actually see for one agent. */
    visibleTools(id) {
      const denied = denials.get(id) ?? new Set()
      return globalTools.filter(name => !denied.has(name))
    },
    /** The prompt as `SystemPrompt.assemble` would render it for one agent. */
    assembledPrompt(id) {
      const merged = new Map()
      for (const [name, render] of GLOBAL_SECTIONS) {
        merged.set(name, { text: render(), owner: 'global' })
      }
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
    /** Open a new top-level conversation. */
    open(id) {
      const agent = agentOf(id)
      agents.set(id, agent)
      emit('agent/created', { agent, source: 'startup' })
      return agent
    },
    /** Open a subagent owned by an existing agent. */
    spawn(id, ownerId) {
      const agent = agentOf(id)
      agents.set(id, agent)
      owned.add(`${id}:${ownerId}`)
      emit('agent/created', { agent, source: 'startup' })
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
 * Drive the plugin's HTTP route the way the browser would.
 * @param host - the fake host whose routes to use.
 * @param method - HTTP verb.
 * @param options - `body` serialized text and `query` string.
 * @returns status, headers and parsed payload.
 */
async function callRoute(host, method, { body, query } = {}) {
  const route = host.routes.find(entry => entry.path === '/rea-toggle/state')
  assert.ok(route, 'the state route must be registered')

  return await new Promise(resolve => {
    const request = {
      method,
      url: `/rea-toggle/state${query === undefined ? '' : `?${query}`}`,
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
        resolve({
          status: this.statusCode,
          headers: this.headers,
          payload: text === undefined ? undefined : JSON.parse(text),
        })
      },
    }
    route.handler(request, response)
  })
}

/** Read the state file the plugin writes. */
function readStateFile() {
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

describe('a new conversation', () => {
  it('starts off, so a fresh conversation pays nothing for REA', () => {
    const host = makeCtx()
    apply(host.ctx, {})

    assert.deepEqual(
      host.visibleTools('conv-1').filter(name => name.startsWith('mcp__rea__')),
      [],
    )
    assert.ok(!host.assembledPrompt('conv-1').some(entry => entry.name === 'mcp:rea'))
  })

  it('leaves other tools, other servers, and run_code alone', () => {
    const host = makeCtx()
    apply(host.ctx, {})

    const visible = host.visibleTools('conv-1')
    for (const name of ['read', 'write', 'bash', 'run_code', 'mcp__other__ping']) {
      assert.ok(visible.includes(name), `${name} must survive`)
    }
    assert.ok(host.assembledPrompt('conv-1').some(entry => entry.name === 'mcp:other'))
  })

  it('honours defaultEnabled when the profile asks for it', () => {
    const host = makeCtx()
    apply(host.ctx, { defaultEnabled: true })

    assert.ok(host.visibleTools('conv-1').includes('mcp__rea__binary_session'))
  })
})

describe('per-conversation independence', () => {
  it('does not let one conversation move another', async () => {
    const host = makeCtx()
    apply(host.ctx, {})
    host.open('conv-2')

    const result = await callRoute(host, 'POST', {
      body: JSON.stringify({ session: 'conv-1', enabled: true }),
    })
    assert.equal(result.status, 200)

    assert.ok(host.visibleTools('conv-1').includes('mcp__rea__binary_session'))
    assert.deepEqual(
      host.visibleTools('conv-2').filter(name => name.startsWith('mcp__rea__')),
      [],
      'conv-2 was never switched and must stay off',
    )
  })

  it('remembers each conversation separately across a restart', async () => {
    const first = makeCtx()
    apply(first.ctx, {})
    first.open('conv-2')

    await callRoute(first, 'POST', { body: JSON.stringify({ session: 'conv-1', enabled: true }) })
    await callRoute(first, 'POST', { body: JSON.stringify({ session: 'conv-2', enabled: false }) })

    assert.deepEqual(readStateFile().sessions['conv-1'].enabled, true)
    assert.deepEqual(readStateFile().sessions['conv-2'].enabled, false)

    const second = makeCtx()
    apply(second.ctx, {})
    second.open('conv-2')

    assert.ok(second.visibleTools('conv-1').includes('mcp__rea__binary_session'))
    assert.deepEqual(
      second.visibleTools('conv-2').filter(name => name.startsWith('mcp__rea__')),
      [],
    )
  })

  it('reports the default for a conversation nobody switched', async () => {
    const host = makeCtx()
    apply(host.ctx, {})

    const result = await callRoute(host, 'GET', { query: 'session=conv-9' })
    assert.equal(result.payload.session, 'conv-9')
    assert.equal(result.payload.enabled, false)
    assert.equal(result.payload.known, false)
    assert.equal(result.payload.defaultEnabled, false)
  })
})

describe('subagents', () => {
  it('inherit the position of the conversation that created them', async () => {
    const host = makeCtx()
    apply(host.ctx, {})
    await callRoute(host, 'POST', { body: JSON.stringify({ session: 'conv-1', enabled: true }) })

    host.spawn('sub-1', 'conv-1')

    assert.ok(
      host.visibleTools('sub-1').includes('mcp__rea__binary_session'),
      'a subagent of an on conversation must not be silently stripped',
    )
  })

  it('stay stripped under an off conversation', () => {
    const host = makeCtx()
    apply(host.ctx, {})

    host.spawn('sub-1', 'conv-1')

    assert.deepEqual(
      host.visibleTools('sub-1').filter(name => name.startsWith('mcp__rea__')),
      [],
    )
    assert.deepEqual(host.scopedSectionNames('sub-1'), ['mcp:rea'])
  })

  it('follow the conversation when it is switched later', async () => {
    const host = makeCtx()
    apply(host.ctx, {})
    host.spawn('sub-1', 'conv-1')

    await callRoute(host, 'POST', { body: JSON.stringify({ session: 'conv-1', enabled: true }) })

    assert.ok(host.visibleTools('sub-1').includes('mcp__rea__binary_session'))
    assert.deepEqual(host.scopedSectionNames('sub-1'), [])
  })
})

describe('turning it on and off', () => {
  it('restores the exact pre-switch state', async () => {
    const host = makeCtx()
    apply(host.ctx, {})
    await callRoute(host, 'POST', { body: JSON.stringify({ session: 'conv-1', enabled: true }) })

    const before = host.visibleTools('conv-1')
    const promptBefore = host.assembledPrompt('conv-1')

    await callRoute(host, 'POST', { body: JSON.stringify({ session: 'conv-1', enabled: false }) })
    assert.ok(!host.visibleTools('conv-1').some(name => name.startsWith('mcp__rea__')))

    const result = await callRoute(host, 'POST', {
      body: JSON.stringify({ session: 'conv-1', enabled: true }),
    })
    assert.equal(result.payload.enabled, true)

    assert.deepEqual(host.visibleTools('conv-1'), before)
    assert.deepEqual(host.assembledPrompt('conv-1'), promptBefore)
    assert.deepEqual(host.scopedSectionNames('conv-1'), [])
  })

  it('flips when the body omits enabled', async () => {
    const host = makeCtx()
    apply(host.ctx, {})

    const first = await callRoute(host, 'POST', { body: JSON.stringify({ session: 'conv-1' }) })
    assert.equal(first.payload.enabled, true)
    const second = await callRoute(host, 'POST', { body: JSON.stringify({ session: 'conv-1' }) })
    assert.equal(second.payload.enabled, false)
  })

  it('re-covers when the registry announces a tool set change', async () => {
    const host = makeCtx()
    apply(host.ctx, {})

    GLOBAL_TOOLS.push('mcp__rea__brand_new_tool')
    try {
      host.emit('tools/change', {})
      assert.ok(
        !host.visibleTools('conv-1').includes('mcp__rea__brand_new_tool'),
        'a tool added by a reconnect must be denied too',
      )
    } finally {
      GLOBAL_TOOLS.pop()
    }
  })

  it('answers one registry event with a bounded amount of work', async () => {
    // A regression, kept because it wedged a live profile: lifting restrictions
    // outside the reconcile latch re-enters the tools/change listener with the
    // latch open, and each disposal that follows re-enters again. One external
    // event became ~41,000 register/dispose pairs and the UI stopped responding.
    // Anything super-linear here is a bug, not a slow path.
    const host = makeCtx()
    apply(host.ctx, {})
    for (const id of ['conv-2', 'conv-3', 'conv-4']) host.open(id)

    const before = host.counts()
    host.emit('tools/change', {})
    const after = host.counts()

    const registered = after.register - before.register
    assert.ok(
      registered <= 20,
      `one tools/change must not fan out without bound (registered ${registered} times)`,
    )
    assert.ok(after.maxDepth <= 2, 'the reconcile latch must stay closed to re-entry')
  })
})

describe('HTTP surface', () => {
  it('answers GET with the conversation status', async () => {
    const host = makeCtx()
    apply(host.ctx, {})

    const result = await callRoute(host, 'GET', { query: 'session=conv-1' })
    assert.equal(result.status, 200)
    assert.equal(result.payload.session, 'conv-1')
    assert.equal(result.payload.enabled, false)
    assert.deepEqual(result.payload.servers, ['rea'])
    assert.equal(result.payload.tools, 3)
    assert.match(result.headers['content-type'], /application\/json/)
  })

  it('answers GET without a session with a summary', async () => {
    const host = makeCtx()
    apply(host.ctx, {})

    const result = await callRoute(host, 'GET')
    assert.equal(result.status, 200)
    assert.equal(result.payload.session, null)
    assert.deepEqual(result.payload.conversations, [])
  })

  it('requires a session on POST', async () => {
    const host = makeCtx()
    apply(host.ctx, {})

    const result = await callRoute(host, 'POST', { body: JSON.stringify({ enabled: true }) })
    assert.equal(result.status, 400)
    assert.match(result.payload.error, /session/)
  })

  it('rejects a non-boolean enabled', async () => {
    const host = makeCtx()
    apply(host.ctx, {})

    const result = await callRoute(host, 'POST', {
      body: JSON.stringify({ session: 'conv-1', enabled: 'yes' }),
    })
    assert.equal(result.status, 400)
    assert.match(result.payload.error, /boolean/)
  })

  it('rejects a malformed body', async () => {
    const host = makeCtx()
    apply(host.ctx, {})

    const result = await callRoute(host, 'POST', { body: '{oops' })
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
  it('moves the switch of the conversation it was typed in', async () => {
    const host = makeCtx()
    apply(host.ctx, {})
    host.open('conv-2')
    const command = host.commands.find(entry => entry.name === 'rea')
    assert.ok(command, '/rea must be registered')

    const on = await command.handler({ agent: { id: 'conv-1' }, rawInput: 'on' })
    assert.equal(on.kind, 'success')
    assert.match(on.text, /ON/)
    assert.ok(host.visibleTools('conv-1').includes('mcp__rea__binary_session'))
    assert.deepEqual(
      host.visibleTools('conv-2').filter(name => name.startsWith('mcp__rea__')),
      [],
      'the command must not reach another conversation',
    )
  })

  it('supports status, toggle, and rejects nonsense', async () => {
    const host = makeCtx()
    apply(host.ctx, {})
    const command = host.commands.find(entry => entry.name === 'rea')
    const invocation = { agent: { id: 'conv-1' } }

    assert.match((await command.handler({ ...invocation, rawInput: 'status' })).text, /OFF/)
    assert.match((await command.handler({ ...invocation, rawInput: 'toggle' })).text, /ON/)
    assert.match((await command.handler({ ...invocation, rawInput: 'toggle' })).text, /OFF/)
    const bad = await command.handler({ ...invocation, rawInput: 'wat' })
    assert.equal(bad.kind, 'error')
  })
})

describe('persistence file', () => {
  it('ignores a pre-per-conversation file instead of misreading it', () => {
    writeFileSync(
      join(home, 'rea-toggle.json'),
      JSON.stringify({ enabled: true, servers: ['rea'] }),
      'utf8',
    )
    assert.deepEqual([...loadSessions(join(home, 'rea-toggle.json')).entries()], [])
  })

  it('survives a corrupt file by falling back to the default', () => {
    writeFileSync(join(home, 'rea-toggle.json'), 'not json at all', 'utf8')
    const host = makeCtx()
    apply(host.ctx, {})

    assert.deepEqual(
      host.visibleTools('conv-1').filter(name => name.startsWith('mcp__rea__')),
      [],
      'the default is off',
    )
  })

  it('writes a versioned document', async () => {
    const host = makeCtx()
    apply(host.ctx, {})
    await callRoute(host, 'POST', { body: JSON.stringify({ session: 'conv-1', enabled: true }) })

    const file = readStateFile()
    assert.equal(file.version, 2)
    assert.deepEqual(file.servers, ['rea'])
    assert.equal(typeof file.sessions['conv-1'].updatedAt, 'string')
  })
})

describe('unload', () => {
  it('lifts every registration so the context comes back', async () => {
    const host = makeCtx()
    apply(host.ctx, {})
    await callRoute(host, 'POST', { body: JSON.stringify({ session: 'conv-1', enabled: true }) })
    await callRoute(host, 'POST', { body: JSON.stringify({ session: 'conv-1', enabled: false }) })
    assert.ok(!host.visibleTools('conv-1').some(name => name.startsWith('mcp__rea__')))

    for (const dispose of host.effects.reverse()) {
      if (typeof dispose === 'function') dispose()
    }

    assert.ok(host.visibleTools('conv-1').includes('mcp__rea__binary_session'))
    assert.deepEqual(host.scopedSectionNames('conv-1'), [])
  })

  it('forgets a disposed agent so a resumed id reads its recorded position', async () => {
    const host = makeCtx()
    apply(host.ctx, {})
    await callRoute(host, 'POST', { body: JSON.stringify({ session: 'conv-1', enabled: true }) })
    assert.ok(host.visibleTools('conv-1').includes('mcp__rea__binary_session'))

    host.reap('conv-1')
    host.open('conv-1')

    assert.ok(
      host.visibleTools('conv-1').includes('mcp__rea__binary_session'),
      'the recorded position must survive the agent lifecycle, not the in-memory map',
    )
  })
})
