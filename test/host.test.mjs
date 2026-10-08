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

import { mkdtemp, rm, writeFile, mkdir, readFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import test from 'node:test'
import assert from 'node:assert/strict'

/** Build the fake plugin context, capturing what the plugin registers. */
function fakeContext() {
  const captured = { events: new Map(), tools: [], effects: 0, routes: [], warns: [] }
  const webServer = {
    register(route) {
      captured.routes.push(route)
      return () => {}
    },
  }
  const ctx = {
    logger: {
      warn(message) {
        captured.warns.push(message)
      },
      info() {},
    },
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
      // The browser route is driven directly through `callApi`; the sidebar /
      // webServer services hand back this fake wherever they are read.
      callback({
        webServer,
        reflect: { get: (name) => (name === 'webServer' ? webServer : undefined) },
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

/**
 * One message of a step, with the `source.kind` the loop gives it.
 *
 * `agent/pre-step` fires for every step of a turn, so the gate decides on
 * `source.kind === 'user'`: that is the kind input ATTRIBUTED to the user carries
 * — the human entrypoints (`@deepseek-ai/dsh-api-session-controller`) and the
 * plugins relaying something the user triggered (`/plan <text>` steers with it,
 * `/goal` re-injects its attachments with it, agent-teams replays a slash command
 * with it, and a subagent delegation prompt is 'user' in the child session that
 * receives it). The loop's own additions under their own kinds are not the user:
 * the runtime context is `runtime-context` (`@deepseek-ai/dsh-agent-loop`), an
 * automatic continuation round is `goal` (`@deepseek-ai/dsh-goal-round-driver`),
 * a background job notice is `tool-jobs` (`@deepseek-ai/dsh-tool-jobs`) — and
 * `role === 'user'` cannot tell any of them apart, which is why the gate reads
 * the kind.
 */
function messageOf(kind, text) {
  return {
    id: `msg-${kind}`,
    role: 'user',
    source: { kind },
    content: [{ type: 'text', text }],
  }
}

/** An `enter` decision carrying exactly these messages. */
function stepOf(...messages) {
  return { kind: 'enter', messages }
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

/**
 * Drive the plugin's HTTP route the way the browser half does.
 *
 * The route is registered through `ctx.inject(['webServer'])`, so the fake
 * context captures the handler: the request still goes through the
 * authorization fence and `readJsonBody`, and nothing needs a live server.
 */
async function callApi(captured, body) {
  const route = captured.routes[0]
  assert.equal(typeof route?.handler, 'function', 'the plugin registers the browser API route')
  assert.equal(route.path, '/plugins/dsh-annotate/api')
  const request = Readable.from([Buffer.from(JSON.stringify(body), 'utf8')])
  request.method = 'POST'
  request.headers = { host: '127.0.0.1:3080', 'x-dsh-annotation': '1' }
  const response = {
    status: 0,
    payload: undefined,
    writeHead(status) {
      this.status = status
      return this
    },
    end(text) {
      this.payload = JSON.parse(text)
    },
  }
  await route.handler(request, response)
  return response
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
    deliveredAt: overrides.deliveredAt,
    deliveredTurn: overrides.deliveredTurn,
    // Optional persisted identity (0.8.0); omitted records are the pre-0.8.0
    // shape and must keep the positional path.
    number: overrides.number,
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
      { agent: { id: 'session-alpha' }, turn: 4, step: 1, messages: original.messages },
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
      { agent: { id: 'session-alpha' }, turn: 1, step: 1, messages: userStep('问题').messages },
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
      { agent: { id: 'session-alpha' }, turn: 4, step: 1, messages: userStep('这是我的问题').messages },
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
      { agent: { id: 'session-alpha' }, turn: 4, step: 1, messages: userStep('问题').messages },
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
      { agent: { id: 'session-alpha' }, turn: 4, step: 1, messages: userStep('问题').messages },
      async () => userStep('问题'),
    )
    assert.equal(first.messages.length, 2)

    // While the receipt is unconfirmed nothing else is injected into that
    // session: the block may already be in the log.
    const sameTurn = await handler(
      { agent: { id: 'session-alpha' }, turn: 4, step: 2, messages: userStep('问题').messages },
      async () => userStep('问题'),
    )
    assert.equal(sameTurn.messages.length, 1, 'no duplicate block while one is in flight')

    // This turn ended BEFORE the loop appended the block — the narrow window
    // between `agent/pre-step` returning and the message reaching the log (an
    // abort right there, or a request that fails while `prepareRequest` runs).
    // That is what leaves the record pending. Pressing stop AFTER the block is
    // already in the log is a different case: nothing un-delivers it, which the
    // next test pins.
    emitSession(captured, 'session-alpha', 'turn/end', { turn: 4, reason: { kind: 'aborted' } })
    assert.equal((await storedById(home)).get('a1').status, 'pending', 'an aborted turn delivers nothing')

    const second = await handler(
      { agent: { id: 'session-alpha' }, turn: 5, step: 1, messages: userStep('再问一次').messages },
      async () => userStep('再问一次'),
    )
    assert.equal(second.messages.length, 2, 'the next message carries it again')
    assert.match(blockTextOf(second), /会被丢掉吗/)

    await emitSession(captured, 'session-alpha', 'user/message', blockMessageOf(second))
    assert.equal((await storedById(home)).get('a1').status, 'delivered')
  })
})

test('a delivered annotation stays delivered when the turn is aborted', async () => {
  await withPlugin([record({ id: 'a1', quote: '已经送到的原文' })], async ({ home, captured }) => {
    const handler = captured.events.get('agent/pre-step')
    const decision = await handler(
      { agent: { id: 'session-alpha' }, turn: 4, step: 1, messages: userStep('问题').messages },
      async () => userStep('问题'),
    )
    assert.equal(decision.messages.length, 2)

    // The loop appended the block after `agent/pre-step` returned, so the log
    // carries it and the record is delivered.
    await emitSession(captured, 'session-alpha', 'user/message', blockMessageOf(decision))
    assert.equal((await storedById(home)).get('a1').status, 'delivered')

    // The user then presses stop. `turn/end` only drops an UNCONFIRMED receipt:
    // the retry path exists for a block that never landed, so it must not undo a
    // delivery the log already proves.
    await emitSession(captured, 'session-alpha', 'turn/end', { turn: 4, reason: { kind: 'aborted' } })
    const persisted = (await storedById(home)).get('a1')
    assert.equal(persisted.status, 'delivered', 'an abort after the append must not un-deliver the block')
    assert.equal(persisted.deliveredTurn, 4)

    const next = await handler(
      { agent: { id: 'session-alpha' }, turn: 5, step: 1, messages: userStep('再问一次').messages },
      async () => userStep('再问一次'),
    )
    assert.equal(next.messages.length, 1, 'and it does not ride the next message again')
  })
})

test('a step/end without the block clears the receipt so it can be re-sent', async () => {
  await withPlugin([record({ id: 'a1' })], async ({ captured }) => {
    const handler = captured.events.get('agent/pre-step')
    await handler(
      { agent: { id: 'session-alpha' }, turn: 6, step: 1, messages: userStep('问题').messages },
      async () => userStep('问题'),
    )
    // The step is over (it failed before the append) but the turn continues.
    emitSession(captured, 'session-alpha', 'step/end', { turn: 6, step: 1 })
    const next = await handler(
      { agent: { id: 'session-alpha' }, turn: 6, step: 2, messages: userStep('问题').messages },
      async () => userStep('问题'),
    )
    assert.equal(next.messages.length, 2, 'the receipt was dropped, so the block rides again')
  })
})

test('a later step of the same turn carries nothing extra', async () => {
  await withPlugin([record({ id: 'a1', note: '只有一条' })], async ({ captured }) => {
    const handler = captured.events.get('agent/pre-step')
    const payload = { agent: { id: 'session-alpha' }, turn: 7, step: 1, messages: userStep('问题').messages }
    const first = await handler(payload, async () => userStep('问题'))
    assert.equal(first.messages.length, 2)
    await emitSession(captured, 'session-alpha', 'user/message', blockMessageOf(first))
    const second = await handler({ ...payload, step: 2 }, async () => userStep('问题'))
    assert.equal(second.messages.length, 1, 'already delivered, no second injection')
    const laterTurn = await handler(
      { agent: { id: 'session-alpha' }, turn: 8, step: 1, messages: userStep('新问题').messages },
      async () => userStep('新问题'),
    )
    assert.equal(laterTurn.messages.length, 1, 'and nothing on the messages after that')
  })
})

test('a step that carries no user message consumes nothing', async () => {
  await withPlugin([record({ id: 'a1', quote: '还在等用户消息' })], async ({ home, captured }) => {
    const handler = captured.events.get('agent/pre-step')
    const path = join(home, 'annotations', 'annotations.json')
    const before = await readFile(path, 'utf8')

    // The reported case: the model turn is already running (step 24) when the
    // annotation is added. The loop claims only what arrived for this step
    // (`AgentInbox.claim` → `preStep`), so the step carries the runtime context
    // and nothing attributed to the user — it must not consume the annotation.
    const original = stepOf(messageOf('runtime-context', '运行时上下文'))
    const decision = await handler(
      { agent: { id: 'session-alpha' }, turn: 12, step: 24, messages: [] },
      async () => original,
    )

    assert.equal(decision, original, 'the decision is passed through untouched')
    assert.equal(blockMessageOf(decision), undefined, 'no block is injected')
    assert.equal(await readFile(path, 'utf8'), before, 'the pending record is byte-for-byte unchanged')
    assert.deepEqual(captured.warns, [], 'this is a normal step, not a contract anomaly')
    assert.equal((await storedById(home)).get('a1').status, 'pending', 'and it is not delivered')

    // No receipt was left behind either: the next message the user sends still
    // carries it.
    const user = await handler(
      { agent: { id: 'session-alpha' }, turn: 12, step: 25, messages: [messageOf('user', '用户的新消息')] },
      async () => userStep('用户的新消息'),
    )
    assert.equal(user.messages.length, 2, 'the annotation rides the next user message instead')
  })
})

test('a user-attributed message the step did not claim cannot open delivery', async () => {
  await withPlugin([record({ id: 'a1', quote: '不该被别人的消息带走' })], async ({ home, captured }) => {
    const handler = captured.events.get('agent/pre-step')
    // The verdict is taken from the batch the step CLAIMED (`payload.messages`),
    // which is what the step proposes to send. A later listener appending a
    // `user`-attributed message to the decision must not be able to turn an
    // inner step of a running turn into a delivery step.
    const appended = messageOf('user', '别的监听器塞进决策的消息')
    const decision = await handler(
      { agent: { id: 'session-alpha' }, turn: 4, step: 7, messages: [] },
      async () => stepOf(appended),
    )

    assert.equal(decision.messages.length, 1, 'nothing was claimed, so nothing rides here')
    assert.equal(blockMessageOf(decision), undefined, 'no block is injected')
    assert.deepEqual(captured.warns, [], 'an unclaimed step is normal, not a contract anomaly')
    assert.equal((await storedById(home)).get('a1').status, 'pending', 'the annotation stays pending')
  })
})

test('a step with no user message does not even read the store', async () => {
  await withPlugin([record({ id: 'a1' })], async ({ home, captured }) => {
    const handler = captured.events.get('agent/pre-step')
    const dir = join(home, 'annotations')
    const path = join(dir, 'annotations.json')

    // `load()` moves a document it cannot parse aside (`annotations.json.
    // corrupt-<stamp>`), which makes "did this step read the store at all?" a
    // question the filesystem answers without instrumentation.
    await writeFile(path, '{ 不是 JSON', 'utf8')

    const decision = await handler(
      { agent: { id: 'session-alpha' }, turn: 2, step: 5, messages: [] },
      async () => stepOf(messageOf('runtime-context', '运行时上下文')),
    )
    assert.deepEqual(decision, stepOf(messageOf('runtime-context', '运行时上下文')))
    assert.deepEqual(await readdir(dir), ['annotations.json'], 'the store was never read, so nothing was moved aside')

    // The contrast that makes the assertion above meaningful: a step carrying a
    // user message does read it, and the corrupt document is moved aside.
    await handler(
      { agent: { id: 'session-alpha' }, turn: 3, step: 1, messages: [messageOf('user', '用户消息')] },
      async () => userStep('用户消息'),
    )
    const after = await readdir(dir)
    assert.equal(after.includes('annotations.json'), false, 'the user step reads the store')
    assert.ok(
      after.some((entry) => entry.startsWith('annotations.json.corrupt-')),
      'and moves the document it could not parse aside',
    )
  })
})

test('an automatic goal round does not consume annotations', async () => {
  await withPlugin([record({ id: 'a1', quote: '不该被续跑带走' })], async ({ home, captured }) => {
    const handler = captured.events.get('agent/pre-step')
    // `dsh-goal-round-driver` starts a continuation round with
    // `agent.followup(createUserMessage({ source: { kind: 'goal', … } }))`, and
    // that appended message also lands on a step 1 — so a step 1 is no proof of
    // user input; the kind is.
    const continuation = messageOf('goal', '自动续跑轮次')
    const decision = await handler(
      { agent: { id: 'session-alpha' }, turn: 5, step: 1, messages: [continuation] },
      async () => stepOf(continuation),
    )

    assert.equal(decision.messages.length, 1, 'the continuation round carries no annotation block')
    assert.equal((await storedById(home)).get('a1').status, 'pending', 'and consumes nothing')

    const user = await handler(
      { agent: { id: 'session-alpha' }, turn: 6, step: 1, messages: [messageOf('user', '用户的消息')] },
      async () => userStep('用户的消息'),
    )
    assert.equal(user.messages.length, 2, 'the annotation waits for the user')
  })
})

test('a user message still carries the block, and the receipt delivers it', async () => {
  await withPlugin([record({ id: 'a1', quote: '随用户消息投递' })], async ({ home, captured }) => {
    const handler = captured.events.get('agent/pre-step')
    const user = {
      id: 'msg-rpc',
      role: 'user',
      source: { kind: 'user', rpcId: 'rpc-1' },
      content: [{ type: 'text', text: '用户的消息' }],
    }
    // The block can follow the user message anywhere in the turn; it is the
    // message, not the step number, that decides.
    const decision = await handler(
      { agent: { id: 'session-alpha' }, turn: 9, step: 3, messages: [user] },
      async () => stepOf(user),
    )

    assert.equal(decision.messages.length, 2, 'the user message plus one block message')
    assert.deepEqual(decision.messages[0], user, 'the user message is returned verbatim')
    assert.match(blockTextOf(decision), /随用户消息投递/)
    assert.equal((await storedById(home)).get('a1').status, 'pending', 'injection alone is not delivery')

    await emitSession(captured, 'session-alpha', 'user/message', blockMessageOf(decision))
    const delivered = (await storedById(home)).get('a1')
    assert.equal(delivered.status, 'delivered')
    assert.equal(delivered.deliveredTurn, 9)
  })
})

test('a user message arriving while a receipt is in flight gets no second block', async () => {
  await withPlugin([record({ id: 'a1', quote: '第一条' })], async ({ home, captured }) => {
    const handler = captured.events.get('agent/pre-step')
    const first = await handler(
      { agent: { id: 'session-alpha' }, turn: 4, step: 1, messages: [messageOf('user', '第一条消息')] },
      async () => userStep('第一条消息'),
    )
    assert.equal(first.messages.length, 2, 'the first user message carries the block')

    // A second annotation arrives while the first block is unconfirmed. The
    // receipt gate still wins: injecting now could duplicate the first block.
    const created = await callApi(captured, {
      action: 'create',
      sessionId: 'session-alpha',
      annotation: { sessionId: 'session-alpha', quote: '第二条', note: '', origin: 'assistant' },
    })
    assert.equal(created.status, 200)

    const second = await handler(
      { agent: { id: 'session-alpha' }, turn: 4, step: 2, messages: [messageOf('user', '第二条消息')] },
      async () => userStep('第二条消息'),
    )
    assert.equal(second.messages.length, 1, 'no duplicate block while one is in flight')
    assert.equal((await storedById(home)).get(created.payload.annotation.id).status, 'pending')

    // The receipt confirms the first block; the second annotation is still
    // unsent and rides the user's next message.
    await emitSession(captured, 'session-alpha', 'user/message', blockMessageOf(first))
    assert.equal((await storedById(home)).get('a1').status, 'delivered')
    assert.equal((await storedById(home)).get(created.payload.annotation.id).status, 'pending')

    const third = await handler(
      { agent: { id: 'session-alpha' }, turn: 5, step: 1, messages: [messageOf('user', '第三条消息')] },
      async () => userStep('第三条消息'),
    )
    assert.equal(third.messages.length, 2, 'the still-pending annotation rides the next user message')
    assert.match(blockTextOf(third), /第二条/)
  })
})

test('a non-array message list refuses delivery and says so', async () => {
  await withPlugin([record({ id: 'a1' })], async ({ home, captured }) => {
    const handler = captured.events.get('agent/pre-step')

    // A broken payload contract must not be read as "no user message": that
    // would switch delivery off without a trace.
    const brokenPayload = await handler(
      { agent: { id: 'session-alpha' }, turn: 3, step: 1, messages: { oops: true } },
      async () => ({ kind: 'enter', messages: { oops: true } }),
    )
    assert.deepEqual(brokenPayload, { kind: 'enter', messages: { oops: true } }, 'the decision is untouched')
    assert.equal(captured.warns.length, 1, 'the anomaly is logged exactly once')

    const brokenDecision = await handler(
      { agent: { id: 'session-alpha' }, turn: 3, step: 2, messages: [] },
      async () => ({ kind: 'enter' }),
    )
    assert.deepEqual(brokenDecision, { kind: 'enter' })
    assert.equal(captured.warns.length, 2, 'an enter decision with no message list is logged too')
    for (const warning of captured.warns) {
      assert.match(String(warning), /not an array/)
    }
    assert.equal((await storedById(home)).get('a1').status, 'pending', 'and nothing is consumed')
  })
})

test('a wire list with no user-attributed message is never given the block', async () => {
  await withPlugin([record({ id: 'a1', quote: '不能被挂到别处' })], async ({ home, captured }) => {
    const handler = captured.events.get('agent/pre-step')
    // The step claims user input, but the list it will send no longer carries
    // that message — only the runtime context is left. Its `role` is `user`
    // (that is the role `createUserMessage` gives the loop's own additions), so
    // a role-based fallback would quietly hang the block on it and report the
    // annotation as delivered with no message from the user. Nothing may host it.
    const context = messageOf('runtime-context', '运行时上下文')
    const decision = await handler(
      { agent: { id: 'session-alpha' }, turn: 4, step: 1, messages: [messageOf('user', '用户消息')] },
      async () => stepOf(context),
    )

    assert.deepEqual(decision, stepOf(context), 'the decision is passed through untouched')
    assert.equal(blockMessageOf(decision), undefined, 'no block is injected')
    assert.equal(captured.warns.length, 1, 'and it is said out loud instead of silently consumed')
    assert.match(String(captured.warns[0]), /no user-attributed message/)
    assert.equal((await storedById(home)).get('a1').status, 'pending', 'the annotation stays pending')
  })
})

test('no annotations leaves the step untouched', async () => {
  await withPlugin([], async ({ captured }) => {
    const handler = captured.events.get('agent/pre-step')
    const original = userStep('普通消息')
    const decision = await handler(
      { agent: { id: 'session-alpha' }, turn: 1, step: 1, messages: original.messages },
      async () => original,
    )
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
      { agent: { session: { id: 'session-alpha' } }, turn: 2, step: 1, messages: userStep('问题').messages },
      async () => userStep('问题'),
    )
    assert.equal(decision.messages.length, 2)
    assert.match(blockTextOf(decision), /嵌套形态/)
  })
})

test('redeliver puts a delivered annotation back in the pending queue', async () => {
  const createdAt = Date.now() - 5000
  await withPlugin(
    [
      record({ id: 'a1', quote: '已经送过', status: 'delivered', createdAt, deliveredAt: createdAt + 1, deliveredTurn: 3 }),
      record({ id: 'a2', quote: '还是新的', createdAt: createdAt + 2 }),
    ],
    async ({ home, captured }) => {
      assert.deepEqual(
        (await storedById(home)).get('a1').deliveredTurn,
        3,
        'the seeded record carries a delivery receipt',
      )

      const response = await callApi(captured, { action: 'redeliver', id: 'a1' })
      assert.equal(response.status, 200)
      assert.equal(response.payload.ok, true)
      const back = response.payload.annotations.find((item) => item.id === 'a1')
      assert.equal(back.status, 'pending')
      assert.equal(back.deliveredAt, undefined, 'the delivery receipt is cleared, not just hidden')
      assert.equal(
        response.payload.annotations.find((item) => item.id === 'a2').status,
        'pending',
        'the whole session list comes back, like update does',
      )

      const persisted = (await storedById(home)).get('a1')
      assert.equal(persisted.status, 'pending')
      assert.equal('deliveredAt' in persisted, false)
      assert.equal('deliveredTurn' in persisted, false)
      assert.ok(persisted.updatedAt >= persisted.createdAt)

      // Idempotent: an already pending id comes back pending instead of failing.
      const again = await callApi(captured, { action: 'redeliver', id: 'a1' })
      assert.equal(again.status, 200)
      assert.equal(again.payload.annotations.find((item) => item.id === 'a1').status, 'pending')

      // Unknown ids are reported the way the other actions report them.
      const missing = await callApi(captured, { action: 'redeliver', id: 'nope' })
      assert.equal(missing.status, 400)
      assert.equal(missing.payload.ok, false)
      assert.equal(missing.payload.error, 'unknown annotation: nope')
    },
  )
})

test('a redelivered annotation rides the next message again', async () => {
  await withPlugin(
    [record({ id: 'a1', quote: '再送一次', note: '重投', status: 'delivered', deliveredAt: Date.now(), deliveredTurn: 2 })],
    async ({ home, captured }) => {
      const handler = captured.events.get('agent/pre-step')

      // Delivered: it stays out of the way on its own.
      const quiet = await handler(
        { agent: { id: 'session-alpha' }, turn: 8, step: 1, messages: userStep('先问一句').messages },
        async () => userStep('先问一句'),
      )
      assert.equal(quiet.messages.length, 1, 'a delivered annotation is not re-sent by itself')
      assert.equal((await storedById(home)).get('a1').status, 'delivered')

      const response = await callApi(captured, { action: 'redeliver', id: 'a1' })
      assert.equal(response.status, 200)
      assert.equal(response.payload.annotations.find((item) => item.id === 'a1').status, 'pending')

      const decision = await handler(
        { agent: { id: 'session-alpha' }, turn: 9, step: 1, messages: userStep('再问一句').messages },
        async () => userStep('再问一句'),
      )
      assert.equal(decision.messages.length, 2, 'the redelivered annotation rides the next message')
      assert.match(blockTextOf(decision), /再送一次/)
      assert.match(blockTextOf(decision), /重投/)
      assert.equal(
        (await storedById(home)).get('a1').status,
        'pending',
        'injection alone is still not delivery',
      )

      await emitSession(captured, 'session-alpha', 'user/message', blockMessageOf(decision))
      const final = (await storedById(home)).get('a1')
      assert.equal(final.status, 'delivered', 'the receipt flips it back to delivered')
      assert.equal(final.deliveredTurn, 9)
    },
  )
})

test('create persists the occurrence the browser captured', async () => {
  await withPlugin([], async ({ home, captured }) => {
    const create = (note) =>
      callApi(captured, {
        action: 'create',
        sessionId: 'session-alpha',
        annotation: { sessionId: 'session-alpha', quote: '同一处原文', note, origin: 'assistant', occurrence: 0 },
      })

    const first = await create('第一条')
    assert.equal(first.status, 200)
    assert.equal(first.payload.ok, true)
    assert.equal(first.payload.annotation.occurrence, 0, 'toClient hands the value back with the new record')

    // The reported case: the quote appears once and the user annotates that one
    // spot twice. Both records carry 0, so both anchor to it.
    const second = await create('第二条')
    assert.equal(second.payload.annotation.occurrence, 0, 'the same spot stays occurrence 0')
    assert.equal((await storedById(home)).get(second.payload.annotation.id).occurrence, 0, 'and it is persisted')

    const listed = await callApi(captured, { action: 'list', sessionId: 'session-alpha' })
    assert.deepEqual(
      listed.payload.annotations.map((item) => item.occurrence),
      [0, 0],
      'the list projection carries it, so a reload re-anchors from the captured value',
    )
  })
})

test('only a finite non-negative integer occurrence is kept', async () => {
  await withPlugin([], async ({ home, captured }) => {
    // JSON cannot carry NaN/Infinity, so those two arrive as null; the point of
    // the list is that no malformed value is trusted or makes the request fail.
    const cases = [
      ['string', '1'],
      ['fraction', 1.5],
      ['negative', -1],
      ['nan', Number.NaN],
      ['infinite', Number.POSITIVE_INFINITY],
      ['null', null],
      ['object', { at: 0 }],
      ['array', [0]],
      ['boolean', true],
    ]
    for (const [label, occurrence] of cases) {
      const response = await callApi(captured, {
        action: 'create',
        sessionId: 'session-alpha',
        annotation: { sessionId: 'session-alpha', quote: label, occurrence },
      })
      assert.equal(response.status, 200, `${label} must not fail the request`)
      assert.equal(response.payload.annotation.occurrence, undefined, `${label} is dropped`)
      assert.equal(
        'occurrence' in (await storedById(home)).get(response.payload.annotation.id),
        false,
        `${label} is not persisted`,
      )
    }

    const good = await callApi(captured, {
      action: 'create',
      sessionId: 'session-alpha',
      annotation: { sessionId: 'session-alpha', quote: '合法值', occurrence: 3 },
    })
    assert.equal(good.payload.annotation.occurrence, 3, 'a real ordinal still round-trips')
  })
})

test('a record written before the field existed loads, lists and delivers as before', async () => {
  // This fixture is a 0.5.0 file: no `occurrence` key anywhere.
  await withPlugin([record({ id: 'a1', quote: '老记录' })], async ({ home, captured }) => {
    const listed = await callApi(captured, { action: 'list', sessionId: 'session-alpha' })
    assert.equal(listed.payload.annotations.length, 1)
    assert.equal('occurrence' in listed.payload.annotations[0], false, 'no invented field in the projection')
    assert.equal('occurrence' in (await storedById(home)).get('a1'), false, 'and none written to disk')

    const tool = captured.tools[0]
    const read = await tool.execute({ action: 'list' }, { agent: { id: 'session-alpha' } })
    assert.equal(read.annotations.length, 1)
    assert.equal(read.annotations[0].quote, '老记录')

    const handler = captured.events.get('agent/pre-step')
    const decision = await handler(
      { agent: { id: 'session-alpha' }, turn: 1, step: 1, messages: userStep('问题').messages },
      async () => userStep('问题'),
    )
    assert.equal(decision.messages.length, 2, 'an old record still rides the next message')
    assert.match(blockTextOf(decision), /老记录/)
    await emitSession(captured, 'session-alpha', 'user/message', blockMessageOf(decision))
    assert.equal((await storedById(home)).get('a1').status, 'delivered')
  })
})

/* -------------------------------- session-stable numbering (0.8.0) --------- */

test('the first annotation of an empty session is number 1, the next is 2', async () => {
  await withPlugin([], async ({ home, captured }) => {
    const create = (quote, extra) =>
      callApi(captured, {
        action: 'create',
        sessionId: 'session-alpha',
        annotation: { sessionId: 'session-alpha', quote, origin: 'assistant', ...extra },
      })

    // A client-supplied number is ignored: assigning it is the host's call, so
    // the browser half cannot relabel itself or collide with a stored value.
    const first = await create('甲', { number: 999 })
    assert.equal(first.status, 200)
    assert.equal(first.payload.annotation.number, 1, 'an empty session starts at 1')
    assert.equal(
      (await storedById(home)).get(first.payload.annotation.id).number,
      1,
      'the number is written with the record, not recomputed on every read',
    )

    const second = await create('乙')
    assert.equal(second.payload.annotation.number, 2)
    // The ORDER of this list is deliberately not asserted. `store.list()` sorts
    // by `createdAt` descending and `create` stamps with `Date.now()`, so two
    // creations that land in the same millisecond tie; a stable sort then keeps
    // insertion order and `[甲, 乙]` is as correct an answer as `[乙, 甲]`. What
    // is contractual here is the quote → number mapping, so that is what is
    // compared — with the length pinned first, so a collapsed or short
    // projection cannot slip through.
    assert.equal(second.payload.annotations.length, 2, 'the whole session list comes back')
    assert.deepEqual(
      Object.fromEntries(second.payload.annotations.map((item) => [item.quote, item.number])),
      { '甲': 1, '乙': 2 },
      'the whole session list comes back carrying the persisted numbers',
    )
  })
})

test('a new annotation takes one more than the highest number the session reads', async () => {
  // `numbered` carries a persisted 5 (so the session reads 5), `legacy` has no
  // field at all (so it is derived at the smallest free position, 1). The next
  // number must clear both: max(1, 5) + 1 = 6. Taking only the persisted values,
  // or counting the records, would hand out 2 or 3 and collide.
  const seeded = [
    record({ id: 'legacy', quote: '老记录', createdAt: 1000 }),
    record({ id: 'numbered', quote: '已编号', createdAt: 2000, number: 5 }),
  ]
  await withPlugin(seeded, async ({ home, captured }) => {
    const created = await callApi(captured, {
      action: 'create',
      sessionId: 'session-alpha',
      annotation: { sessionId: 'session-alpha', quote: '新记录' },
    })
    assert.equal(created.payload.annotation.number, 6, 'max(1 derived, 5 persisted) + 1')
    assert.equal((await storedById(home)).get(created.payload.annotation.id).number, 6)

    const listed = await callApi(captured, { action: 'list', sessionId: 'session-alpha' })
    assert.deepEqual(
      listed.payload.annotations.map((item) => item.id),
      [created.payload.annotation.id, 'numbered', 'legacy'],
      'newest first, like every other projection',
    )
    assert.deepEqual(
      listed.payload.annotations.map((item) => item.number),
      [6, 5, 1],
      'the older records were not re-labelled by the newcomer',
    )
  })
})

test('only an integer of at least 1 is kept as a stored number', async () => {
  // JSON cannot carry NaN/Infinity, so those two arrive as null; the point is
  // that no malformed value is trusted as an identity and none fails the load.
  const cases = [
    ['string', '1'],
    ['fraction', 1.5],
    ['zero', 0],
    ['negative', -2],
    ['boolean', true],
    ['null', null],
  ]
  const seeded = cases.map(([label, number], index) =>
    record({ id: `bad-${label}`, quote: label, createdAt: 1000 + index, number }),
  )
  seeded.push(record({ id: 'good', quote: '合法', createdAt: 2000, number: 9 }))

  await withPlugin(seeded, async ({ captured }) => {
    const listed = await callApi(captured, { action: 'list', sessionId: 'session-alpha' })
    const numbers = new Map(listed.payload.annotations.map((item) => [item.id, item.number]))
    assert.equal(numbers.get('good'), 9, 'a real number is kept verbatim')
    cases.forEach(([label], index) => {
      assert.equal(
        numbers.get(`bad-${label}`),
        index + 1,
        `${label} is not an identity: it takes the next free position instead`,
      )
    })
  })
})

test('a duplicated stored number does not give two records the same number', async () => {
  // A hand-edited store file can repeat a value. The number is an identity, so
  // two records reading the same one would be worse than a gap: the first record
  // in creation order keeps the value and the later one takes a free position.
  const createdAt = Date.now() - 9000
  await withPlugin(
    [
      record({ id: 'first', quote: '甲', createdAt, number: 7 }),
      record({ id: 'second', quote: '乙', createdAt: createdAt + 1, number: 7 }),
      record({ id: 'third', quote: '丙', createdAt: createdAt + 2, number: 3 }),
    ],
    async ({ captured }) => {
      const listed = await callApi(captured, { action: 'list', sessionId: 'session-alpha' })
      const numbers = new Map(listed.payload.annotations.map((item) => [item.id, item.number]))
      assert.equal(numbers.get('first'), 7, 'the earliest record keeps the value')
      assert.equal(numbers.get('second'), 1, 'the duplicate falls back to the smallest free position')
      assert.equal(numbers.get('third'), 3, 'an unrelated stored number is untouched')
      assert.equal(new Set(numbers.values()).size, 3, 'three records, three different numbers')

      const created = await callApi(captured, {
        action: 'create',
        sessionId: 'session-alpha',
        annotation: { sessionId: 'session-alpha', quote: '丁' },
      })
      assert.equal(created.payload.annotation.number, 8, 'and the newcomer clears the highest value')
    },
  )
})

test('records without a number take distinct positions and never collide with a stored one', async () => {
  // The derivation runs in creation order and reserves what it hands out, so the
  // legacy records of a mixed session get different numbers and step around the
  // stored ones instead of landing on them.
  const createdAt = Date.now() - 11000
  await withPlugin(
    [
      record({ id: 'stored', quote: '持久化', createdAt, number: 2 }),
      record({ id: 'l1', quote: '旧一', createdAt: createdAt + 1 }),
      record({ id: 'l2', quote: '旧二', createdAt: createdAt + 2 }),
      record({ id: 'l3', quote: '旧三', createdAt: createdAt + 3 }),
    ],
    async ({ captured }) => {
      const listed = await callApi(captured, { action: 'list', sessionId: 'session-alpha' })
      const numbers = Object.fromEntries(listed.payload.annotations.map((item) => [item.id, item.number]))
      assert.deepEqual(numbers, { l3: 4, l2: 3, l1: 1, stored: 2 })
      assert.equal(new Set(Object.values(numbers)).size, 4, 'four records, four different numbers')
    },
  )
})

test('every API projection carries a positive integer number, never undefined', async () => {
  const createdAt = Date.now() - 10000
  await withPlugin(
    [
      record({ id: 'a1', quote: '持久化编号', createdAt, number: 5 }),
      record({ id: 'a2', quote: '旧记录一', createdAt: createdAt + 1 }),
      record({ id: 'a3', quote: '已送达', createdAt: createdAt + 2, status: 'delivered', deliveredAt: createdAt + 3 }),
    ],
    async ({ captured }) => {
      // The projection invariant the browser half leans on: `allNumbers()`
      // prefers `item.number`, and its own fallback is only a safety net. A
      // projection that omitted the field would make the panel show a different
      // number than the delivered block — the exact promise this iteration is
      // restoring — so every case is checked, not just `list`.
      const exercised = []
      const check = (label, payload) => {
        assert.ok(Array.isArray(payload.annotations), `${label}: returns an annotations list`)
        const values = payload.annotations.map((item) => item.number)
        for (const item of payload.annotations) {
          assert.ok(
            Number.isInteger(item.number) && item.number > 0,
            `${label}: ${item.id} must read a positive integer, got ${String(item.number)}`,
          )
        }
        assert.equal(values.filter((value) => value === undefined).length, 0, `${label}: no undefined number`)
        assert.equal(new Set(values).size, values.length, `${label}: the numbers are distinct`)
        exercised.push(label)
      }

      check('list', (await callApi(captured, { action: 'list', sessionId: 'session-alpha' })).payload)
      check(
        'create',
        (
          await callApi(captured, {
            action: 'create',
            sessionId: 'session-alpha',
            annotation: { sessionId: 'session-alpha', quote: '新记录' },
          })
        ).payload,
      )
      check('update', (await callApi(captured, { action: 'update', id: 'a1', patch: { note: '改过' } })).payload)
      check('redeliver', (await callApi(captured, { action: 'redeliver', id: 'a3' })).payload)
      check('delete', (await callApi(captured, { action: 'delete', id: 'a2' })).payload)
      check(
        'clear-delivered',
        (await callApi(captured, { action: 'clear-delivered', sessionId: 'session-alpha' })).payload,
      )
      assert.deepEqual(
        exercised,
        ['list', 'create', 'update', 'redeliver', 'delete', 'clear-delivered'],
        'all six browser-facing cases were exercised',
      )
    },
  )
})

test('deleting an earlier annotation does not move the numbers of the survivors', async () => {
  const createdAt = Date.now() - 3000
  await withPlugin(
    [
      record({ id: 'a1', quote: '甲', createdAt, number: 1 }),
      record({ id: 'a2', quote: '乙', createdAt: createdAt + 1, number: 2 }),
      record({ id: 'a3', quote: '丙', createdAt: createdAt + 2, number: 3 }),
    ],
    async ({ home, captured }) => {
      const before = await callApi(captured, { action: 'list', sessionId: 'session-alpha' })
      assert.deepEqual(
        before.payload.annotations.map((item) => [item.id, item.number]),
        [
          ['a3', 3],
          ['a2', 2],
          ['a1', 1],
        ],
      )

      const removed = await callApi(captured, { action: 'delete', id: 'a1' })
      assert.equal(removed.status, 200)
      assert.deepEqual(
        removed.payload.annotations.map((item) => [item.id, item.number]),
        [
          ['a3', 3],
          ['a2', 2],
        ],
        'the delete response itself proves the survivors were not renumbered',
      )
      assert.equal((await storedById(home)).get('a2').number, 2, 'and the stored values are untouched')

      // The point of the whole iteration: the next block the model reads says the
      // same numbers the panel shows — 2 and 3, not a recomputed 1 and 2.
      const handler = captured.events.get('agent/pre-step')
      const decision = await handler(
        { agent: { id: 'session-alpha' }, turn: 1, step: 1, messages: userStep('问题').messages },
        async () => userStep('问题'),
      )
      assert.match(blockTextOf(decision), /—— 批注（共 2 处，编号 2、3）——/)
      assert.match(blockTextOf(decision), /「Annotation 2：…」「Annotation 3：…」/)
    },
  )
})

test('clearing the delivered annotations does not move the pending numbers', async () => {
  const createdAt = Date.now() - 4000
  await withPlugin(
    [
      record({ id: 'a1', quote: '甲', createdAt, status: 'delivered', number: 1, deliveredAt: createdAt + 1 }),
      record({ id: 'a2', quote: '乙', createdAt: createdAt + 1, status: 'delivered', number: 2, deliveredAt: createdAt + 2 }),
      record({ id: 'a3', quote: '丙', createdAt: createdAt + 2, number: 3 }),
      record({ id: 'a4', quote: '丁', createdAt: createdAt + 3, number: 4 }),
    ],
    async ({ home, captured }) => {
      const cleared = await callApi(captured, { action: 'clear-delivered', sessionId: 'session-alpha' })
      assert.equal(cleared.status, 200)
      assert.equal(cleared.payload.removed, 2, 'both delivered records are gone')
      assert.deepEqual(
        cleared.payload.annotations.map((item) => [item.id, item.number]),
        [
          ['a4', 4],
          ['a3', 3],
        ],
        'the ones that are left keep 3 and 4 instead of sliding down to 1 and 2',
      )
      assert.equal(cleared.payload.annotations.some((item) => item.id === 'a1'), false)

      const handler = captured.events.get('agent/pre-step')
      const decision = await handler(
        { agent: { id: 'session-alpha' }, turn: 1, step: 1, messages: userStep('问题').messages },
        async () => userStep('问题'),
      )
      assert.match(blockTextOf(decision), /—— 批注（共 2 处，编号 3、4）——/)

      // Nothing was renumbered on disk either, and no number was written for a
      // record that never had one.
      const stored = await storedById(home)
      assert.deepEqual(
        [...stored.keys()].sort(),
        ['a3', 'a4'],
      )
      assert.equal(stored.get('a4').number, 4)
    },
  )
})

test('records written before the field existed keep the pre-0.8.0 1..N output', async () => {
  const createdAt = Date.now() - 5000
  const seeded = [
    record({ id: 'a1', quote: '第一处', createdAt }),
    record({ id: 'a2', quote: '第二处', createdAt: createdAt + 1 }),
    record({ id: 'a3', quote: '第三处', createdAt: createdAt + 2 }),
  ]
  await withPlugin(seeded, async ({ home, captured }) => {
    const listed = await callApi(captured, { action: 'list', sessionId: 'session-alpha' })
    assert.deepEqual(
      listed.payload.annotations.map((item) => item.number),
      [3, 2, 1],
      'the fallback is still creation order, listed newest first like 0.7.0',
    )

    const tool = captured.tools[0]
    const read = await tool.execute({ action: 'list' }, { agent: { id: 'session-alpha' } })
    assert.deepEqual(read.annotations.map((item) => item.number), [1, 2, 3])

    const handler = captured.events.get('agent/pre-step')
    const decision = await handler(
      { agent: { id: 'session-alpha' }, turn: 1, step: 1, messages: userStep('问题').messages },
      async () => userStep('问题'),
    )
    assert.match(blockTextOf(decision), /—— 批注（共 3 处，编号 1、2、3）——/)

    // A flush does not invent an identity for a legacy record: the derived
    // numbers stay a read-time fallback, which is what keeps their known cost
    // (they still move when an earlier legacy record is deleted) visible.
    await emitSession(captured, 'session-alpha', 'user/message', blockMessageOf(decision))
    const stored = await storedById(home)
    for (const id of ['a1', 'a2', 'a3']) {
      assert.equal('number' in stored.get(id), false, `${id} must not gain a number on disk`)
    }
  })
})

test('only the number a deleted maximum freed can come back', async () => {
  // The rule is `max(what the session still reads) + 1`, so a new annotation never
  // takes a number a SURVIVING record still reads. Deleting the current maximum is
  // the one case where a historical number returns; the CHANGELOG documents that
  // as a cost rather than hiding it, and this pins the two halves together.
  const createdAt = Date.now() - 6000
  await withPlugin(
    [
      record({ id: 'a1', quote: '甲', createdAt, number: 1 }),
      record({ id: 'a2', quote: '乙', createdAt: createdAt + 1, number: 2 }),
      record({ id: 'a3', quote: '丙', createdAt: createdAt + 2, number: 3 }),
    ],
    async ({ captured }) => {
      const create = (quote) =>
        callApi(captured, {
          action: 'create',
          sessionId: 'session-alpha',
          annotation: { sessionId: 'session-alpha', quote },
        })

      // A freed MIDDLE number is skipped: 3 still reads 3, so the next is 4.
      assert.equal((await callApi(captured, { action: 'delete', id: 'a2' })).status, 200)
      const afterMiddle = await create('新一')
      assert.equal(afterMiddle.payload.annotation.number, 4, 'the freed 2 is not reused')

      // The freed MAXIMUM is the one exception: nothing reads 4 any more, so the
      // next annotation takes it back.
      assert.equal((await callApi(captured, { action: 'delete', id: afterMiddle.payload.annotation.id })).status, 200)
      const afterTop = await create('新二')
      assert.equal(afterTop.payload.annotation.number, 4, 'the freed maximum can come back')
    },
  )
})

test('a number survives a reload and the next annotation continues from it', async () => {
  await withPlugin([], async ({ home, captured }) => {
    const create = (quote) =>
      callApi(captured, {
        action: 'create',
        sessionId: 'session-alpha',
        annotation: { sessionId: 'session-alpha', quote },
      })
    await create('甲')
    await create('乙')

    const stored = JSON.parse(await readFile(join(home, 'annotations', 'annotations.json'), 'utf8'))
    // The document itself: both records are there and each one carries its own
    // number. The file keeps them in creation order, so this is a quote → number
    // mapping either way — no sort is involved.
    assert.equal(stored.annotations.length, 2, 'both records are in the document')
    assert.deepEqual(
      Object.fromEntries(stored.annotations.map((item) => [item.quote, item.number])),
      { '甲': 1, '乙': 2 },
      'the numbers are in the document, next to the records they belong to',
    )

    // Boot a second host half over the same store, the way a restart does.
    const url = new URL('../index.js', import.meta.url)
    url.searchParams.set('t', `reload-${Date.now()}-${Math.random()}`)
    const reloaded = await import(url.href)
    const again = fakeContext()
    reloaded.apply(again.ctx)

    const listed = await callApi(again.captured, { action: 'list', sessionId: 'session-alpha' })
    // The ORDER of this list is deliberately not asserted, and neither is the
    // order of the file above. `store.list()` sorts by `createdAt` descending,
    // and the two creations above are stamped with `Date.now()`: when both land
    // in the same millisecond they tie, a stable sort keeps insertion order, and
    // `[甲, 乙]` is as correct an answer as `[乙, 甲]`. Asserting the array made
    // this case a coin flip — measured on this machine it failed in 5 of 60
    // rounds, the tie rate. What a reload must preserve is the quote → number
    // mapping, so that is what is compared; the length is pinned first, so a
    // collapsed or short projection cannot pass.
    assert.equal(listed.payload.annotations.length, 2, 'both records came back')
    assert.deepEqual(
      Object.fromEntries(listed.payload.annotations.map((item) => [item.quote, item.number])),
      { '甲': 1, '乙': 2 },
      'after a reload the records read exactly the numbers they had before',
    )

    const third = await callApi(again.captured, {
      action: 'create',
      sessionId: 'session-alpha',
      annotation: { sessionId: 'session-alpha', quote: '丙' },
    })
    assert.equal(third.payload.annotation.number, 3, 'and the session continues, it does not start over')
  })
})

/* ---------------------------- delivery gate coverage (gaps closed here) ---- */

test('a payload with no messages array at all is refused, logged and injects nothing', async () => {
  await withPlugin([record({ id: 'a1', quote: '不该被无字段的载荷带走' })], async ({ home, captured }) => {
    const handler = captured.events.get('agent/pre-step')
    const entering = userStep('问题')

    // The shape the code has to survive: a payload with nothing to read
    // `messages` off at all. Reading it unguarded would throw a TypeError out of
    // an `agent/pre-step` listener, which is worse than skipping one delivery.
    const missing = await handler({ agent: { id: 'session-alpha' }, turn: 3, step: 1 }, async () => entering)
    assert.equal(missing, entering, 'the enter decision is handed back untouched')
    assert.equal(blockMessageOf(missing), undefined, 'no block is injected')
    assert.equal(captured.warns.length, 1, 'the anomaly is logged')
    assert.match(String(captured.warns[0]), /not an array/)

    const nulled = await handler(
      { agent: { id: 'session-alpha' }, turn: 3, step: 2, messages: null },
      async () => entering,
    )
    assert.equal(blockMessageOf(nulled), undefined)
    assert.equal(captured.warns.length, 2, 'null is not an array either')
    assert.match(String(captured.warns[1]), /not an array/)

    assert.equal((await storedById(home)).get('a1').status, 'pending', 'and nothing is consumed')
  })
})

test('the reported incident shape: a tool-jobs notice takes no annotations', async () => {
  await withPlugin([record({ id: 'a1', quote: '不该被作业通知带走' })], async ({ home, captured }) => {
    const handler = captured.events.get('agent/pre-step')
    const dir = join(home, 'annotations')
    const path = join(dir, 'annotations.json')
    const before = await readFile(path, 'utf8')

    // A background job notice carries `role === 'user'` — `createUserMessage`
    // gives that role to every plugin notice — but it is not input attributed to
    // the user: its kind is `tool-jobs`. A role-based gate would send the block
    // with it (and the block would land on a message the user never sent), so
    // this is the exact batch the `source.kind` test exists for.
    const notice = messageOf('tool-jobs', '后台作业完成')
    const original = stepOf(notice)
    const decision = await handler(
      { agent: { id: 'session-alpha' }, turn: 3, step: 1, messages: [notice] },
      async () => original,
    )
    assert.equal(decision, original, 'the decision is passed through untouched')
    assert.equal(blockMessageOf(decision), undefined, 'no block is injected')
    assert.deepEqual(captured.warns, [], 'a notice-only step is normal, not a contract anomaly')
    assert.equal(await readFile(path, 'utf8'), before, 'nothing is written')
    assert.equal((await storedById(home)).get('a1').status, 'pending', 'and it is not delivered')

    // The above proves "not written"; it does not prove "not read" — a read with
    // no write looks identical. `load()` moves a document it cannot parse aside,
    // which is what makes that question answerable from the filesystem.
    await writeFile(path, '{ 不是 JSON', 'utf8')
    const second = await handler(
      { agent: { id: 'session-alpha' }, turn: 4, step: 1, messages: [notice] },
      async () => stepOf(notice),
    )
    assert.equal(second.messages.length, 1)
    assert.deepEqual(await readdir(dir), ['annotations.json'], 'the store was never read')
  })
})
