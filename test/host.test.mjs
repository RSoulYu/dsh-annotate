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

import { chmod, mkdtemp, rm, writeFile, mkdir, readFile, readdir, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { createHash } from 'node:crypto'
import test from 'node:test'
import assert from 'node:assert/strict'

/** The store the plugin reads and writes under `$DSH_HOME`. */
const STORE = join('annotations', 'annotations.json')
/**
 * The one-shot pre-migration copy 0.9.0 leaves next to the store. The name is
 * frozen by the A spec (a timestamped name would pile up one file per retry).
 */
const BACKUP_SUFFIX = '.migrate-0.9.0.bak'

/**
 * Build the fake plugin context, capturing what the plugin registers.
 *
 * `options.infoThrows` makes the injected logger throw from `info()`. The logger
 * is a collaborator the store is HANDED, so this is the only way a test can make
 * an "unexpected throw" escape `backfillNumbers()`: the migration's own errors
 * are all caught inside it, and `node:fs/promises`' named exports cannot be
 * re-bound from here (a filesystem error therefore cannot be made to escape).
 */
function fakeContext(options = {}) {
  const captured = { events: new Map(), tools: [], effects: 0, routes: [], warns: [], infos: [] }
  const webServer = {
    register(route) {
      captured.routes.push(route)
      return () => {}
    },
  }
  // `console`-style logger: the plugin calls `warn(fmt, error)` / `info(fmt, …)`
  // with `%s`/`%d`/`%o` placeholders, exactly like `console.warn` does. The
  // placeholders are substituted here so an assertion can match what the line
  // actually says — and the trailing arguments are appended so a failure reason
  // (an error code, say) is not dropped.
  const joined = (format, ...args) => {
    let index = 0
    const substituted = String(format).replace(/%[sdo]/g, () => {
      const value = args[index]
      index += 1
      return value === undefined ? '(undefined)' : String(value)
    })
    return [substituted, ...args.slice(index)].map((value) => String(value)).join(' ')
  }
  const ctx = {
    logger: {
      warn(...args) {
        captured.warns.push(joined(...args))
      },
      info(...args) {
        if (options.infoThrows === true) throw new Error('the injected logger failed')
        captured.infos.push(joined(...args))
      },
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
async function withPlugin(annotations, run, options = {}) {
  const home = await mkdtemp(join(tmpdir(), 'dsa-test-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    await mkdir(join(home, 'annotations'), { recursive: true })
    await writeFile(join(home, STORE), JSON.stringify({ version: 1, annotations }, null, 2), 'utf8')
    const { ctx, captured } = await bootPlugin(options)
    await run({ home, captured, ctx })
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    await rm(home, { recursive: true, force: true })
  }
}

/**
 * Boot another copy of the host half over whatever `$DSH_HOME` points at, the
 * way a restart does: a fresh module instance plus a fresh context, so the new
 * boot's `load()` runs for the first time. The caller owns the temp home.
 */
async function bootPlugin(options = {}) {
  const url = new URL('../index.js', import.meta.url)
  url.searchParams.set('t', `boot-${Date.now()}-${Math.random()}`)
  const plugin = await import(url.href)
  const { ctx, captured } = fakeContext(options)
  plugin.apply(ctx)
  return { plugin, ctx, captured }
}

function storeOf(home) {
  return join(home, STORE)
}

function backupOf(home) {
  return storeOf(home) + BACKUP_SUFFIX
}

async function sha256Of(file) {
  return createHash('sha256').update(await readFile(file)).digest('hex')
}

/** The `createdAt` → id order of the document, i.e. creation order. */
function idOrderOf(annotations) {
  return annotations
    .slice()
    .sort((a, b) => a.createdAt - b.createdAt)
    .map((item) => item.id)
}

/** id → number of one API payload, in no particular order. */
function numbersOf(payload) {
  return new Map(payload.annotations.map((item) => [item.id, item.number]))
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
  const stored = JSON.parse(await readFile(storeOf(home), 'utf8'))
  return new Map(stored.annotations.map((item) => [item.id, item]))
}

/** The whole persisted document, for the count and the `version` field. */
async function readDoc(home) {
  return JSON.parse(await readFile(storeOf(home), 'utf8'))
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

test('records written before the field existed are backfilled with the pre-0.8.0 1..N output', async () => {
  const createdAt = Date.now() - 5000
  const seeded = [
    record({ id: 'a1', quote: '第一处', createdAt }),
    record({ id: 'a2', quote: '第二处', createdAt: createdAt + 1 }),
    record({ id: 'a3', quote: '第三处', createdAt: createdAt + 2 }),
  ]
  const seededText = JSON.stringify({ version: 1, annotations: seeded }, null, 2)
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

    // 0.9.0 pins those three numbers down instead of leaving them to the
    // read-time fallback: the values written are exactly the ones the block,
    // the API and the tool reported above — the backfill changes no reading. The
    // pre-migration document is kept beside the store, byte for byte.
    await emitSession(captured, 'session-alpha', 'user/message', blockMessageOf(decision))
    const stored = await storedById(home)
    assert.deepEqual(
      ['a1', 'a2', 'a3'].map((id) => stored.get(id).number),
      [1, 2, 3],
      'each legacy record persisted the number it already read',
    )
    assert.equal(await readFile(backupOf(home), 'utf8'), seededText, 'the backup is the document as it was seeded')
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

/* ------------------- the 0.9.0 number backfill (records before 0.8.0) ----- */

test('the backfill writes the numbers the session already reads, and nothing else', async () => {
  const createdAt = Date.now() - 4000
  const seeded = [
    record({
      id: 'old-a',
      quote: '旧一',
      note: '旧批注',
      createdAt,
      status: 'delivered',
      deliveredAt: createdAt + 3,
      deliveredTurn: 7,
    }),
    record({ id: 'kept', quote: '有号', createdAt: createdAt + 1, number: 5 }),
    record({ id: 'old-b', quote: '旧二', createdAt: createdAt + 2 }),
  ]
  // `record()` mirrors the shape the store can actually hold; an occurrence is
  // the one field it leaves out, so it is added here where a record that HAS one
  // is what the backfill must leave alone.
  const withOccurrence = seeded.map((item) => (item.id === 'old-a' ? { ...item, occurrence: 2 } : item))
  await withPlugin(withOccurrence, async ({ home, captured }) => {
    const listed = await callApi(captured, { action: 'list', sessionId: 'session-alpha' })
    const read = numbersOf(listed.payload)

    // The stored values and the order the session reads them in: kept=5,
    // old-a=1, old-b=2. The mapping, not the display order, is what is asserted.
    assert.equal(read.get('kept'), 5, 'a persisted number keeps its value')
    assert.equal(read.get('old-a'), 1)
    assert.equal(read.get('old-b'), 2)

    const stored = await storedById(home)
    assert.deepEqual(
      [...read.keys()].sort().map((id) => [id, stored.get(id).number]),
      [
        ['kept', 5],
        ['old-a', 1],
        ['old-b', 2],
      ],
      'every legacy record persisted exactly the number it already read',
    )
    assert.equal(stored.get('kept').number, 5, 'a record with a stored number is never rewritten')
    assert.equal(stored.get('old-a').note, '旧批注', 'the note is untouched')
    assert.equal(stored.get('old-a').status, 'delivered', 'the status is untouched')
    assert.equal(stored.get('old-a').deliveredAt, createdAt + 3, 'the delivery stamp is untouched')
    assert.equal(stored.get('old-a').deliveredTurn, 7, 'the delivered turn is untouched')
    assert.equal(stored.get('old-a').occurrence, 2, 'the occurrence is untouched')
    assert.equal(stored.get('old-b').quote, '旧二', 'the quote is untouched')
    for (const id of ['old-a', 'kept', 'old-b']) {
      assert.deepEqual(
        [stored.get(id).createdAt, stored.get(id).updatedAt],
        [withOccurrence.find((item) => item.id === id).createdAt, withOccurrence.find((item) => item.id === id).updatedAt],
        `${id}: createdAt/updatedAt are untouched`,
      )
    }
    const doc = await readDoc(home)
    assert.equal(doc.annotations.length, withOccurrence.length, 'no record was added or removed')
    assert.equal(doc.version, 1, 'the document keeps its version')
  })
})

test('the backfill leaves a duplicated stored value alone and keeps one definite reading', async () => {
  const createdAt = Date.now() - 4000
  const seeded = [
    record({ id: 'dup-first', quote: 'A', createdAt, number: 7 }),
    record({ id: 'dup-second', quote: 'B', createdAt: createdAt + 1, number: 7 }),
    record({ id: 'other', quote: 'C', createdAt: createdAt + 2, number: 3 }),
    record({ id: 'late', quote: 'D', createdAt: createdAt + 3 }),
  ]
  const seededText = JSON.stringify({ version: 1, annotations: seeded }, null, 2)
  await withPlugin(seeded, async ({ home, captured }) => {
    const listed = await callApi(captured, { action: 'list', sessionId: 'session-alpha' })
    const read = numbersOf(listed.payload)

    assert.equal(read.get('dup-first'), 7, 'the earliest holder of the value keeps it')
    assert.notEqual(read.get('dup-second'), 7, 'the loser is not given the same number')
    assert.equal(new Set(read.values()).size, 4, 'four records, four different numbers')

    const stored = await storedById(home)
    assert.equal(stored.get('dup-first').number, 7, 'a valid stored value is never rewritten')
    assert.equal(stored.get('dup-second').number, 7, 'nor is the loser of a duplicate rewritten')
    assert.equal(stored.get('other').number, 3, 'nor is an unrelated valid value')
    assert.equal(stored.get('late').number, read.get('late'), 'only the legacy record gains a number')
    // The duplicate loser fell back to the smallest free position, 1, so the
    // legacy record takes the next one — the same value it read before.
    assert.equal(stored.get('late').number, 2, 'the legacy record persists the free position it read')
    assert.equal(await readFile(backupOf(home), 'utf8'), seededText, 'the backup is the pre-migration document')
  })
})

test('invalid stored numbers are replaced by the value the record reads', async () => {
  const createdAt = Date.now() - 4000
  const seeded = [
    record({ id: 'z0', quote: '零', createdAt, number: 0 }),
    record({ id: 'zneg', quote: '负', createdAt: createdAt + 1, number: -3 }),
    record({ id: 'zfrac', quote: '小数', createdAt: createdAt + 2, number: 1.5 }),
    record({ id: 'zstr', quote: '字符串', createdAt: createdAt + 3, number: '3' }),
    record({ id: 'znan', quote: 'NaN', createdAt: createdAt + 4, number: Number.NaN }),
    record({ id: 'znull', quote: 'null', createdAt: createdAt + 5, number: null }),
  ]
  await withPlugin(seeded, async ({ home, captured }) => {
    const listed = await callApi(captured, { action: 'list', sessionId: 'session-alpha' })
    const read = numbersOf(listed.payload)
    assert.deepEqual([...read.values()].sort((a, b) => a - b), [1, 2, 3, 4, 5, 6], 'the readings are 1..6')

    const stored = await storedById(home)
    for (const [id, number] of read) assert.equal(stored.get(id).number, number, `${id} persisted what it read`)
    assert.deepEqual(
      idOrderOf(await readDoc(home).then((doc) => doc.annotations)).map((id) => stored.get(id).number),
      [1, 2, 3, 4, 5, 6],
      'in creation order the stored numbers are 1..6',
    )
  })
})

test('the backfill is idempotent: a second load writes no byte and leaves no new backup', async () => {
  const createdAt = Date.now() - 4000
  await withPlugin(
    [
      record({ id: 'l1', quote: '旧一', createdAt }),
      record({ id: 'l2', quote: '旧二', createdAt: createdAt + 1 }),
      record({ id: 'l3', quote: '旧三', createdAt: createdAt + 2 }),
    ],
    async ({ home, captured }) => {
      const first = await callApi(captured, { action: 'list', sessionId: 'session-alpha' })
      assert.deepEqual(
        [...numbersOf(first.payload).values()].sort((a, b) => a - b),
        [1, 2, 3],
        'the first load backfilled 1..3',
      )
      const storeHash = await sha256Of(storeOf(home))
      const storeStat = await stat(storeOf(home))
      const backupStat = await stat(backupOf(home))
      const backupBytes = await readFile(backupOf(home), 'utf8')

      // Same home, second host half — the restart this has to survive.
      const second = await bootPlugin()
      await callApi(second.captured, { action: 'list', sessionId: 'session-alpha' })

      assert.equal(await sha256Of(storeOf(home)), storeHash, 'the document is byte-identical')
      assert.equal((await stat(storeOf(home))).mtimeMs, storeStat.mtimeMs, 'the second load did not even rewrite it')
      const secondBackup = await stat(backupOf(home))
      assert.equal(secondBackup.ino, backupStat.ino, 'the backup inode is unchanged')
      assert.equal(backupStat.mode & 0o777, 0o600, 'the backup is 0600')
      assert.equal(await readFile(backupOf(home), 'utf8'), backupBytes, 'the backup bytes are unchanged')
      const entries = await readdir(join(home, 'annotations'))
      assert.equal(entries.filter((entry) => entry.endsWith(BACKUP_SUFFIX)).length, 1, 'exactly one backup on disk')
      assert.deepEqual(second.captured.warns, [], 'a completed backfill warns about nothing')
      assert.deepEqual(second.captured.infos, [], 'and it says nothing either')
    },
  )
})

test('the pre-migration store is copied byte for byte at mode 0600', async () => {
  const createdAt = Date.now() - 4000
  const seeded = [record({ id: 'l1', quote: '旧一', createdAt }), record({ id: 'l2', quote: '旧二', createdAt: createdAt + 1 })]
  const seededText = JSON.stringify({ version: 1, annotations: seeded }, null, 2)
  const seedBytes = Buffer.from(seededText, 'utf8')
  await withPlugin(seeded, async ({ home, captured }) => {
    assert.equal((await readdir(join(home, 'annotations'))).length, 1, 'nothing but the store before the first read')
    const seededSize = (await stat(storeOf(home))).size
    const listed = await callApi(captured, { action: 'list', sessionId: 'session-alpha' })
    assert.equal(listed.status, 200)
    const backup = await readFile(backupOf(home))
    assert.ok(
      Buffer.compare(backup, seedBytes) === 0,
      `the backup is the exact pre-migration bytes, got ${backup.length} vs ${seedBytes.length}`,
    )
    assert.equal((await stat(backupOf(home))).mode & 0o777, 0o600, 'the backup is 0600')
    assert.ok(
      (await stat(storeOf(home))).size > seededSize,
      'the migrated store is longer than the seed: the numbers are in it',
    )
    assert.match(captured.infos.join('\n'), /backfilled 2 annotation number/, 'the boot reports what it wrote')
  })
})

test('a pre-existing backup is never overwritten, and the backfill still runs', async () => {
  const createdAt = Date.now() - 4000
  const sentinel = 'an earlier migration backup\n'
  await withPlugin(
    [record({ id: 'l1', quote: '旧一', createdAt }), record({ id: 'l2', quote: '旧二', createdAt: createdAt + 1 })],
    async ({ home, captured }) => {
      await writeFile(backupOf(home), sentinel, 'utf8')
      const listed = await callApi(captured, { action: 'list', sessionId: 'session-alpha' })
      assert.equal(listed.status, 200)
      assert.equal(await readFile(backupOf(home), 'utf8'), sentinel, 'the earliest copy is kept verbatim')
      const stored = await storedById(home)
      assert.equal(stored.get('l1').number, 1, 'the backfill still ran')
      assert.equal(stored.get('l2').number, 2, 'the backfill still ran')
      assert.deepEqual(captured.warns, [], 'an existing backup is not a failure')
    },
  )
})

test('when the backup cannot be written the store is left untouched and the next boot retries', async () => {
  const createdAt = Date.now() - 4000
  const seeded = [record({ id: 'l1', quote: '旧一', createdAt }), record({ id: 'l2', quote: '旧二', createdAt: createdAt + 1 })]
  const seededText = JSON.stringify({ version: 1, annotations: seeded }, null, 2)
  await withPlugin(seeded, async ({ home, captured }) => {
    const dir = join(home, 'annotations')
    const before = await sha256Of(storeOf(home))
    await chmod(dir, 0o500)
    try {
      const listed = await callApi(captured, { action: 'list', sessionId: 'session-alpha' })
      assert.equal(listed.status, 200, 'the plugin still answers when the backfill cannot write')
      assert.equal(await sha256Of(storeOf(home)), before, 'the store keeps its bytes')
      assert.equal(captured.warns.length, 1, `exactly one warning, got ${JSON.stringify(captured.warns)}`)
      assert.match(String(captured.warns[0]), /pre-0.9.0 store backup/, 'the warning names the failed step')
      assert.equal(await readFile(storeOf(home), 'utf8'), seededText, 'nothing was written to the store')
      const readings = numbersOf(listed.payload)
      assert.deepEqual(
        idOrderOf(seeded).map((id) => readings.get(id)),
        [1, 2],
        'the read-time derivation still holds for this boot',
      )
      const entries = await readdir(dir)
      assert.equal(entries.filter((entry) => entry.endsWith(BACKUP_SUFFIX)).length, 0, 'no backup could be created')
    } finally {
      await chmod(dir, 0o700)
    }

    // Reading the API again cannot tell "the legacy records have no number in
    // memory" apart from "they were numbered before the backup failed":
    // `numbering()` derives a position for a record without one, so both
    // readings give 1 and 2. The next FLUSH is what separates them — with the
    // numbers already in memory it would persist them, and the store would carry
    // a backfill whose backup never landed. So the directory being writable
    // again, a `create()` is driven and the file is read back.
    const created = await callApi(captured, {
      action: 'create',
      sessionId: 'session-alpha',
      annotation: { sessionId: 'session-alpha', quote: '新记录' },
    })
    assert.equal(created.status, 200)
    assert.equal(created.payload.annotation.number, 3, 'a new record continues from the derived maximum (1, 2)')
    const flushed = await storedById(home)
    assert.equal(
      'number' in flushed.get('l1'),
      false,
      'a failed backup must leave the legacy records unnumbered in memory, so no later flush can persist them',
    )
    assert.equal(
      'number' in flushed.get('l2'),
      false,
      'a failed backup must leave the legacy records unnumbered in memory, so no later flush can persist them',
    )

    const second = await bootPlugin()
    const retried = await callApi(second.captured, { action: 'list', sessionId: 'session-alpha' })
    assert.equal(retried.status, 200)
    const stored = await storedById(home)
    assert.equal(stored.get('l1').number, 1, 'the next boot completes the backfill')
    assert.equal(stored.get('l2').number, 2, 'the next boot completes the backfill')
    assert.equal(stored.get(created.payload.annotation.id).number, 3, 'and the persisted newcomer is not renumbered')
    assert.deepEqual(second.captured.warns, [], 'and warns about nothing')
  })
})

test('a throw out of the backfill is contained, never treated as a corrupt store', async () => {
  const createdAt = Date.now() - 4000
  const seeded = [
    record({ id: 'l1', quote: '旧一', createdAt }),
    record({ id: 'l2', quote: '旧二', createdAt: createdAt + 1 }),
    record({ id: 'l3', quote: '旧三', createdAt: createdAt + 2 }),
  ]
  const seededText = JSON.stringify({ version: 1, annotations: seeded }, null, 2)
  const sentinel = 'a backup from an earlier run\n'
  await withPlugin(
    seeded,
    async ({ home, captured }) => {
      const dir = join(home, 'annotations')
      // A backup from an earlier run sits beside the store, so the backfill takes
      // its `EEXIST` branch and reports that through `logger.info` — and the
      // injected logger throws (see `fakeContext`). The throw escapes
      // `backfillNumbers()` from a point where nothing has been written yet,
      // which is exactly the "unexpected throw during load" the loader has to
      // contain. The alternative a reader might expect — an fs error — cannot be
      // made to escape: every filesystem failure inside the migration is caught
      // by the migration, so only an injected collaborator can do this.
      await writeFile(backupOf(home), sentinel, 'utf8')

      const listed = await callApi(captured, { action: 'list', sessionId: 'session-alpha' })
      assert.equal(listed.status, 200, 'a throw out of the backfill does not take the plugin down')

      // 1) the store was NOT mistaken for a corrupt document...
      const entries = await readdir(dir)
      assert.equal(
        entries.some((entry) => entry.startsWith('annotations.json.corrupt-')),
        false,
        `the store must not be moved aside as corrupt, got ${JSON.stringify(entries)}`,
      )
      assert.equal(entries.includes('annotations.json'), true, 'the store is still where it was')
      // 2) ...its bytes are untouched, and so is the backup already on disk...
      assert.equal(await readFile(storeOf(home), 'utf8'), seededText, 'nothing was written to the store')
      assert.equal(await readFile(backupOf(home), 'utf8'), sentinel, 'and the existing backup is untouched')
      // 3) ...the failure is reported as a backfill failure...
      assert.equal(captured.warns.length, 1, `exactly one warning, got ${JSON.stringify(captured.warns)}`)
      assert.match(String(captured.warns[0]), /annotation number backfill failed/, 'the warning names the backfill')
      // 4) ...and this boot keeps reading the derived numbers, none of the
      // records having been given one.
      const readings = numbersOf(listed.payload)
      assert.deepEqual(
        idOrderOf(seeded).map((id) => readings.get(id)),
        [1, 2, 3],
        'the read-time derivation still holds for this boot',
      )
    },
    { infoThrows: true },
  )
})

test('when the store cannot be written the memory is rolled back and the next boot retries', async () => {
  const createdAt = Date.now() - 4000
  const seeded = [record({ id: 'l1', quote: '旧一', createdAt }), record({ id: 'l2', quote: '旧二', createdAt: createdAt + 1 })]
  await withPlugin(seeded, async ({ home, captured }) => {
    const store = storeOf(home)
    const before = await sha256Of(store)
    // `writeAtomic` names its temp file `<store>.tmp-<pid>-<Date.now()>`, so with
    // the clock frozen a directory on that exact path makes the temp WRITE fail
    // (EISDIR) while the backup, a different name, still succeeds. This is the
    // one way to fail the store write deterministically.
    const realNow = Date.now
    Date.now = () => createdAt
    const blocker = `${store}.tmp-${process.pid}-${createdAt}`
    try {
      await mkdir(blocker)
      const listed = await callApi(captured, { action: 'list', sessionId: 'session-alpha' })
      assert.equal(listed.status, 200, 'the plugin still answers after a failed store write')
      assert.equal(await sha256Of(store), before, 'the store keeps its bytes')
      await stat(backupOf(home)) // the backup is written before the store is touched
      assert.equal(captured.warns.length, 1, `exactly one warning, got ${JSON.stringify(captured.warns)}`)
      assert.match(String(captured.warns[0]), /backfilled annotation numbers/, 'the warning names the failed write')

      await rm(blocker, { recursive: true, force: true })
      const created = await callApi(captured, {
        action: 'create',
        sessionId: 'session-alpha',
        annotation: { sessionId: 'session-alpha', quote: '新记录' },
      })
      assert.equal(created.status, 200)
      const persisted = await storedById(home)
      assert.equal(
        created.payload.annotation.number,
        3,
        'the new record continues from the derived maximum the session still reads',
      )
      assert.equal(
        persisted.get('l1').number,
        undefined,
        'the rolled-back numbers are not what the created record continued from',
      )
      assert.equal(
        'number' in persisted.get('l1'),
        false,
        'a later flush must not persist the rolled-back numbers',
      )
      assert.equal('number' in persisted.get('l2'), false, 'a later flush must not persist the rolled-back numbers')
    } finally {
      Date.now = realNow
    }

    const second = await bootPlugin()
    await callApi(second.captured, { action: 'list', sessionId: 'session-alpha' })
    const after = await storedById(home)
    assert.equal(after.get('l1').number, 1, 'the next boot completes the backfill')
    assert.equal(after.get('l2').number, 2, 'the next boot completes the backfill')
  })
})

test('the backfill never trims a session over the per-session limit', async () => {
  const MAX_PER_SESSION = 400
  const createdAt = Date.now() - 600000
  const many = []
  for (let index = 0; index < MAX_PER_SESSION + 12; index += 1) {
    many.push(record({ id: `many-${String(index).padStart(4, '0')}`, quote: `第${index}处`, createdAt: createdAt + index }))
  }
  await withPlugin(many, async ({ home, captured }) => {
    const listed = await callApi(captured, { action: 'list', sessionId: 'session-alpha' })
    const read = numbersOf(listed.payload)
    const doc = await readDoc(home)
    assert.equal(doc.annotations.length, many.length, 'the backfill is not a write path and never trims')
    assert.equal(read.size, many.length, 'every record still reads a number')
    assert.equal(new Set(read.values()).size, many.length, 'and no two read the same one')
    for (const item of doc.annotations) assert.ok(Number.isInteger(item.number) && item.number >= 1, 'each has a stored number')
    assert.equal(captured.warns.length, 0, 'nothing to warn about')
  })
})

test('the backfill runs per session, independently', async () => {
  const createdAt = Date.now() - 4000
  const seeded = [
    record({ id: 'a1', sessionId: 'session-alpha', quote: 'A1', createdAt }),
    record({ id: 'a2', sessionId: 'session-alpha', quote: 'A2', createdAt: createdAt + 1 }),
    record({ id: 'b1', sessionId: 'session-beta', quote: 'B1', createdAt, number: 4 }),
    record({ id: 'b2', sessionId: 'session-beta', quote: 'B2', createdAt: createdAt + 1 }),
  ]
  await withPlugin(seeded, async ({ home, captured }) => {
    const alpha = numbersOf((await callApi(captured, { action: 'list', sessionId: 'session-alpha' })).payload)
    const beta = numbersOf((await callApi(captured, { action: 'list', sessionId: 'session-beta' })).payload)
    assert.deepEqual([...alpha.values()].sort((a, b) => a - b), [1, 2], 'the other session never lends a number')
    assert.equal(beta.get('b1'), 4, 'a stored number is kept')
    assert.equal(beta.get('b2'), 1, 'the legacy record takes the smallest free position of its own session')
    const stored = await storedById(home)
    for (const [id, number] of new Map([...alpha, ...beta])) {
      assert.equal(stored.get(id).number, number, `${id} persisted what it read`)
    }
    assert.equal(stored.get('a1').number, 1, 'sessions compute their numbers from their own records only')
  })
})

test('a missing or empty store is neither created nor backed up', async () => {
  await withPlugin([], async ({ home, captured }) => {
    const dir = join(home, 'annotations')
    const listed = await callApi(captured, { action: 'list', sessionId: 'session-alpha' })
    assert.equal(listed.status, 200)
    assert.deepEqual(await readdir(dir), ['annotations.json'], 'an empty document is not rewritten')
    assert.deepEqual(captured.warns, [], 'and nothing is warned about')
  })

  const empty = await mkdtemp(join(tmpdir(), 'dsa-test-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = empty
  try {
    await mkdir(join(empty, 'annotations'), { recursive: true })
    const booted = await bootPlugin()
    const listed = await callApi(booted.captured, { action: 'list', sessionId: 'session-alpha' })
    assert.equal(listed.status, 200)
    assert.deepEqual(await readdir(join(empty, 'annotations')), [], 'a missing store is not created')
    assert.deepEqual(booted.captured.warns, [], 'and nothing is warned about')
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    await rm(empty, { recursive: true, force: true })
  }
})

test('a corrupt store is moved aside and is never backed up', async () => {
  await withPlugin([record({ id: 'a1' })], async ({ home, captured }) => {
    const dir = join(home, 'annotations')
    await writeFile(storeOf(home), '{ 不是 JSON', 'utf8')
    const listed = await callApi(captured, { action: 'list', sessionId: 'session-alpha' })
    assert.equal(listed.status, 200, 'a corrupt document does not take the plugin down')
    const entries = await readdir(dir)
    assert.ok(
      entries.some((entry) => entry.startsWith('annotations.json.corrupt-')),
      `the unparsable document is moved aside, got ${JSON.stringify(entries)}`,
    )
    assert.equal(entries.filter((entry) => entry.endsWith(BACKUP_SUFFIX)).length, 0, 'a document with no records is not backed up')
    assert.deepEqual(captured.warns, [], 'and it is not a backfill failure')
  })
})

test('deleting an earlier backfilled record does not move the survivors', async () => {
  const createdAt = Date.now() - 4000
  await withPlugin(
    [
      record({ id: 'd1', quote: '第一处', createdAt }),
      record({ id: 'd2', quote: '第二处', createdAt: createdAt + 1 }),
      record({ id: 'd3', quote: '第三处', createdAt: createdAt + 2 }),
    ],
    async ({ home, captured }) => {
      const before = numbersOf((await callApi(captured, { action: 'list', sessionId: 'session-alpha' })).payload)
      assert.deepEqual([before.get('d1'), before.get('d2'), before.get('d3')], [1, 2, 3], 'the fixture starts at 1..3')

      const removed = await callApi(captured, { action: 'delete', id: 'd1' })
      assert.equal(removed.status, 200)
      const after = numbersOf(removed.payload)
      assert.equal(after.get('d2'), before.get('d2'), 'deleting the earliest does not slide d2 down')
      assert.equal(after.get('d3'), before.get('d3'), 'nor d3')

      const reread = numbersOf((await callApi(captured, { action: 'list', sessionId: 'session-alpha' })).payload)
      assert.equal(reread.get('d2'), before.get('d2'), 'and a fresh read agrees')
      assert.equal(reread.get('d3'), before.get('d3'), 'and a fresh read agrees')
      const stored = await storedById(home)
      assert.equal(stored.get('d2').number, before.get('d2'), 'the stored value is stable too')
      assert.equal(stored.get('d3').number, before.get('d3'), 'the stored value is stable too')
    },
  )
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
