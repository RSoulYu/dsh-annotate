/**
 * Host-half tests: store, API projection and the `agent/pre-step` delivery.
 *
 * The browser half is verified live through the client Slot inspector; this
 * test covers the part that decides whether an annotation ever reaches the
 * model — including the shape of the message that carries it, because the chat
 * only keeps the block out of the user's bubble when that message's
 * `source.kind` is not `user`.
 *
 * Run with: node --test
 */

import { mkdtemp, rm, writeFile, mkdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'

/** Build the fake plugin context, capturing what the plugin registers. */
function fakeContext() {
  const captured = { events: new Map(), tools: [], effects: 0 }
  const ctx = {
    logger: { warn() {}, info() {} },
    on(name, handler) {
      captured.events.set(name, handler)
      return () => {}
    },
    effect(fn) {
      captured.effects += 1
      const dispose = fn()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    inject(_names, callback) {
      // The webServer route is exercised over real HTTP elsewhere.
      callback({
        reflect: { get: () => undefined },
        effect: ctx.effect,
      })
      return () => {}
    },
    tools: {
      register(definition) {
        captured.tools.push(definition)
        return () => {}
      },
    },
  }
  return { ctx, captured }
}

/** Seed a store file and load a fresh copy of the plugin against it. */
async function withPlugin(annotations, run) {
  const home = await mkdtemp(join(tmpdir(), 'dsa-test-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    await mkdir(join(home, 'annotations'), { recursive: true })
    await writeFile(
      join(home, 'annotations', 'annotations.json'),
      JSON.stringify({ version: 1, annotations }, null, 2),
      'utf8',
    )
    const url = new URL('../index.js', import.meta.url)
    url.searchParams.set('t', String(Date.now()) + Math.random())
    const plugin = await import(url.href)
    const { ctx, captured } = fakeContext()
    plugin.apply(ctx)
    await run({ home, captured, plugin })
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    await rm(home, { recursive: true, force: true })
  }
}

function userStep(text) {
  return {
    kind: 'enter',
    messages: [
      {
        id: 'msg-1',
        role: 'user',
        source: { kind: 'user' },
        content: [{ type: 'text', text }],
      },
    ],
  }
}

/** The injected block message of one decision, or undefined when there is none. */
function blockMessageOf(decision) {
  return decision.messages.find((message) => message?.source?.kind === 'dsh-annotate')
}

/** The rendered block text of one decision. */
function blockTextOf(decision) {
  const message = blockMessageOf(decision)
  return message === undefined ? '' : message.content[0].text
}

/**
 * Publish one session event the way `Session.append` does. Delivery is
 * confirmed off this stream, so the tests have to drive it.
 *
 * Awaiting the handler awaits the persisted delivery itself — no sleeping and
 * guessing that the store's asynchronous flush has landed.
 */
async function emitSession(captured, sessionId, type, data) {
  const handler = captured.events.get('session/event')
  assert.equal(typeof handler, 'function', 'the plugin observes session/event')
  await handler({ id: sessionId }, { type, data })
}

/** Read the persisted store back as a map by id. */
async function storedById(home) {
  const stored = JSON.parse(await readFile(join(home, 'annotations', 'annotations.json'), 'utf8'))
  return new Map(stored.annotations.map((item) => [item.id, item]))
}

function record(overrides) {
  return {
    id: overrides.id,
    sessionId: overrides.sessionId ?? 'session-alpha',
    quote: overrides.quote ?? '被批注的原文',
    note: overrides.note ?? '',
    status: overrides.status ?? 'pending',
    origin: 'assistant',
    createdAt: overrides.createdAt ?? Date.now(),
    updatedAt: overrides.createdAt ?? Date.now(),
  }
}

test('registers exactly one tool, a pre-step listener and the receipt listener', async () => {
  await withPlugin([], async ({ captured }) => {
    assert.equal(captured.tools.length, 1)
    assert.equal(captured.tools[0].name, 'annotation')
    assert.deepEqual(captured.tools[0].parameters.required, ['action'])
    assert.equal(typeof captured.events.get('agent/pre-step'), 'function')
    assert.equal(typeof captured.events.get('session/event'), 'function')
  })
})

test("the user's own message is left untouched; the block travels as its own message", async () => {
  await withPlugin([record({ id: 'a1', quote: '第一处原文', note: '第一条批注' })], async ({ captured }) => {
    const handler = captured.events.get('agent/pre-step')
    const original = userStep('这是我的问题')
    const decision = await handler(
      { agent: { id: 'session-alpha' }, turn: 4, step: 1, messages: [] },
      async () => original,
    )

    assert.equal(decision.kind, 'enter')
    assert.equal(decision.messages.length, 2, 'the user message plus one block message')
    assert.deepEqual(decision.messages[0], original.messages[0], 'the message the user sent is returned verbatim')
    assert.equal(decision.messages[0].content.length, 1, 'no block is appended to the user text')

    const injected = decision.messages[1]
    assert.equal(injected.role, 'user', 'a user/message event must carry the user role')
    assert.equal(injected.source.kind, 'dsh-annotate', 'any kind but `user` keeps this row out of the bubble')
    assert.notEqual(injected.id, 'msg-1', 'the injected message needs its own identity')
    assert.match(blockTextOf(decision), /第一处原文/, 'the block content still quotes the source')
  })
})

test('the injected message satisfies the session user/message contract', async () => {
  await withPlugin([record({ id: 'a1' })], async ({ captured }) => {
    const handler = captured.events.get('agent/pre-step')
    const decision = await handler(
      { agent: { id: 'session-alpha' }, turn: 1, step: 1, messages: [] },
      async () => userStep('问题'),
    )
    // Mirrors the store's `assertMessageEventShape`: an identified message, the
    // role the event type implies, a non-empty source kind, and a content array.
    const injected = blockMessageOf(decision)
    assert.equal(typeof injected.id, 'string')
    assert.ok(injected.id.length > 0, 'the event must carry an identified message')
    assert.equal(injected.role, 'user')
    assert.equal(typeof injected.source.kind, 'string')
    assert.ok(injected.source.kind.length > 0, 'the source kind must not be empty')
    assert.ok(Array.isArray(injected.content))
    assert.deepEqual(injected.content.map((part) => part.type), ['text'])
    assert.equal(typeof injected.content[0].text, 'string')
  })
})

test('delivers pending annotations with the next user message', async () => {
  const created = Date.now() - 1000
  const records = [
    record({ id: 'a1', quote: '第一处原文', note: '第一条批注', createdAt: created }),
    record({ id: 'a2', quote: '第二处原文', note: '', createdAt: created + 1, status: 'delivered' }),
    record({ id: 'a3', quote: '第三处原文', note: '', createdAt: created + 2 }),
    record({ id: 'b1', sessionId: 'session-beta', quote: '别的会话', note: '不该出现' }),
  ]
  await withPlugin(records, async ({ home, captured }) => {
    const handler = captured.events.get('agent/pre-step')
    const decision = await handler(
      { agent: { id: 'session-alpha' }, turn: 4, step: 1, messages: [] },
      async () => userStep('这是我的问题'),
    )

    const block = blockTextOf(decision)
    assert.ok(block.startsWith('—— 批注（共 2 处，编号 1、3）——'), 'the block opens with its own header line')
    assert.ok(block.endsWith('\n'), 'the block ends with a newline')
    assert.match(block, /原文：「第一处原文」/)
    assert.match(block, /批注：第一条批注/)
    assert.match(block, /第三处原文/)
    assert.match(block, /（未填写批注，只标记了原文）/)
    assert.match(block, /「Annotation 1：…」「Annotation 3：…」/)
    assert.doesNotMatch(block, /别的会话/, 'other sessions must not leak in')
    assert.doesNotMatch(block, /第二处原文/, 'delivered annotations are not re-sent')

    // Injecting is not delivering: until the log publishes the message that
    // carries the block, the annotations must still read as unsent.
    let byId = await storedById(home)
    assert.equal(byId.get('a1').status, 'pending', 'injection alone must not mark anything delivered')
    assert.equal(byId.get('a3').status, 'pending')

    await emitSession(captured, 'session-alpha', 'user/message', blockMessageOf(decision))
    byId = await storedById(home)
    assert.equal(byId.get('a1').status, 'delivered')
    assert.equal(byId.get('a1').deliveredTurn, 4)
    assert.equal(byId.get('a3').status, 'delivered')
    assert.equal(byId.get('b1').status, 'pending', 'another session stays pending')
  })
})

test('a block the log never carries is not delivered', async () => {
  await withPlugin([record({ id: 'a1', note: '别丢' })], async ({ home, captured }) => {
    const handler = captured.events.get('agent/pre-step')
    await handler(
      { agent: { id: 'session-alpha' }, turn: 4, step: 1, messages: [] },
      async () => userStep('问题'),
    )

    // Another session's append, and a message that does not carry the block.
    await emitSession(captured, 'session-beta', 'user/message', { content: [{ type: 'text', text: '别的会话' }] })
    await emitSession(captured, 'session-alpha', 'user/message', { content: [{ type: 'text', text: '没有块的消息' }] })

    const byId = await storedById(home)
    assert.equal(byId.get('a1').status, 'pending', 'only the block itself may confirm a delivery')
  })
})

test('a turn that ends without the block re-delivers it on the next message', async () => {
  await withPlugin([record({ id: 'a1', quote: '会被丢掉吗' })], async ({ home, captured }) => {
    const handler = captured.events.get('agent/pre-step')
    const first = await handler(
      { agent: { id: 'session-alpha' }, turn: 4, step: 1, messages: [] },
      async () => userStep('问题'),
    )
    assert.equal(first.messages.length, 2)

    // While the receipt is unconfirmed nothing else is injected into that
    // session: the block may already be in the log.
    const sameTurn = await handler(
      { agent: { id: 'session-alpha' }, turn: 4, step: 2, messages: [] },
      async () => userStep('问题'),
    )
    assert.equal(sameTurn.messages.length, 1, 'no duplicate block while one is in flight')

    // The stop button aborted the turn before the loop appended the message.
    emitSession(captured, 'session-alpha', 'turn/end', { turn: 4, reason: { kind: 'aborted' } })
    assert.equal((await storedById(home)).get('a1').status, 'pending', 'an aborted turn delivers nothing')

    const second = await handler(
      { agent: { id: 'session-alpha' }, turn: 5, step: 1, messages: [] },
      async () => userStep('再问一次'),
    )
    assert.equal(second.messages.length, 2, 'the next message carries it again')
    assert.match(blockTextOf(second), /会被丢掉吗/)

    await emitSession(captured, 'session-alpha', 'user/message', blockMessageOf(second))
    assert.equal((await storedById(home)).get('a1').status, 'delivered')
  })
})

test('a step/end without the block clears the receipt so it can be re-sent', async () => {
  await withPlugin([record({ id: 'a1' })], async ({ captured }) => {
    const handler = captured.events.get('agent/pre-step')
    await handler(
      { agent: { id: 'session-alpha' }, turn: 6, step: 1, messages: [] },
      async () => userStep('问题'),
    )
    // The step is over (it failed before the append) but the turn continues.
    emitSession(captured, 'session-alpha', 'step/end', { turn: 6, step: 1 })
    const next = await handler(
      { agent: { id: 'session-alpha' }, turn: 6, step: 2, messages: [] },
      async () => userStep('问题'),
    )
    assert.equal(next.messages.length, 2, 'the receipt was dropped, so the block rides again')
  })
})

test('a later step of the same turn carries nothing extra', async () => {
  await withPlugin([record({ id: 'a1', note: '只有一条' })], async ({ captured }) => {
    const handler = captured.events.get('agent/pre-step')
    const payload = { agent: { id: 'session-alpha' }, turn: 7, step: 1, messages: [] }
    const first = await handler(payload, async () => userStep('问题'))
    assert.equal(first.messages.length, 2)
    await emitSession(captured, 'session-alpha', 'user/message', blockMessageOf(first))
    const second = await handler({ ...payload, step: 2 }, async () => userStep('问题'))
    assert.equal(second.messages.length, 1, 'already delivered, no second injection')
    const laterTurn = await handler(
      { agent: { id: 'session-alpha' }, turn: 8, step: 1, messages: [] },
      async () => userStep('新问题'),
    )
    assert.equal(laterTurn.messages.length, 1, 'and nothing on the messages after that')
  })
})

test('no annotations leaves the step untouched', async () => {
  await withPlugin([], async ({ captured }) => {
    const handler = captured.events.get('agent/pre-step')
    const original = userStep('普通消息')
    const decision = await handler({ agent: { id: 'session-alpha' }, turn: 1, step: 1 }, async () => original)
    assert.equal(decision, original, 'the decision object is passed through unchanged')
  })
})

test('a rejected step is never rewritten', async () => {
  await withPlugin([record({ id: 'a1' })], async ({ captured }) => {
    const handler = captured.events.get('agent/pre-step')
    const decision = await handler({ agent: { id: 'session-alpha' }, turn: 1, step: 1 }, async () => ({ kind: 'reject' }))
    assert.deepEqual(decision, { kind: 'reject' })
  })
})

test('the annotation tool lists and resolves this session only', async () => {
  await withPlugin(
    [
      record({ id: 'a1', quote: '甲', note: '笔记一' }),
      record({ id: 'a2', quote: '乙', note: '笔记二', createdAt: Date.now() + 1 }),
      record({ id: 'b1', sessionId: 'session-beta', quote: '丙', note: '笔记三' }),
    ],
    async ({ captured }) => {
      const tool = captured.tools[0]
      const listed = await tool.execute({ action: 'list' }, { agent: { id: 'session-alpha' } })
      assert.equal(listed.pending, 2)
      assert.deepEqual(
        listed.annotations.map((item) => item.number),
        [1, 2],
        'chronological order, numbered the same way the delivery block numbers them',
      )
      assert.equal(listed.annotations.length, 2)

      const resolved = await tool.execute({ action: 'resolve' }, { agent: { id: 'session-alpha' } })
      assert.equal(resolved.resolved.length, 2)

      const after = await tool.execute({ action: 'list', includeDelivered: false }, { agent: { id: 'session-alpha' } })
      assert.equal(after.pending, 0)
      assert.equal(after.annotations.length, 0)

      const other = await tool.execute({ action: 'list' }, { agent: { id: 'session-beta' } })
      assert.equal(other.annotations.length, 1)
      assert.equal(other.annotations[0].quote, '丙')
    },
  )
})

test('session ids resolve through either agent shape', async () => {
  await withPlugin([record({ id: 'a1', quote: '嵌套形态' })], async ({ captured }) => {
    const handler = captured.events.get('agent/pre-step')
    const decision = await handler(
      { agent: { session: { id: 'session-alpha' } }, turn: 2, step: 1 },
      async () => userStep('问题'),
    )
    assert.equal(decision.messages.length, 2)
    assert.match(blockTextOf(decision), /嵌套形态/)
  })
})
