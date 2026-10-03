/**
 * Host-half tests: store, API projection and the `agent/pre-step` delivery.
 *
 * The browser half is verified live through the client Slot inspector; this
 * test covers the part that decides whether an annotation ever reaches the
 * model.
 *
 * Run with: node --test test/
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

test('registers exactly one tool and one pre-step listener', async () => {
  await withPlugin([], async ({ captured }) => {
    assert.equal(captured.tools.length, 1)
    assert.equal(captured.tools[0].name, 'annotation')
    assert.deepEqual(captured.tools[0].parameters.required, ['action'])
    assert.equal(typeof captured.events.get('agent/pre-step'), 'function')
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

    assert.equal(decision.kind, 'enter')
    assert.equal(decision.messages.length, 1)
    const blocks = decision.messages[0].content
    assert.equal(blocks.length, 2, 'the user text plus one annotation block')
    assert.equal(blocks[0].text, '这是我的问题')
    const block = blocks[1].text
    assert.ok(block.startsWith('\n\n'), 'the block starts with a blank line so it never glues to the user text')
    assert.match(block, /—— 批注（共 2 处，编号 1、3）——/)
    assert.ok(block.endsWith('\n'), 'the block ends with a newline')
    assert.match(block, /原文：「第一处原文」/)
    assert.match(block, /批注：第一条批注/)
    assert.match(block, /第三处原文/)
    assert.match(block, /（未填写批注，只标记了原文）/)
    assert.match(block, /「Annotation 1：…」「Annotation 3：…」/)
    assert.doesNotMatch(block, /别的会话/, 'other sessions must not leak in')
    assert.doesNotMatch(block, /第二处原文/, 'delivered annotations are not re-sent')

    const stored = JSON.parse(await readFile(join(home, 'annotations', 'annotations.json'), 'utf8'))
    const byId = new Map(stored.annotations.map((item) => [item.id, item]))
    assert.equal(byId.get('a1').status, 'delivered')
    assert.equal(byId.get('a1').deliveredTurn, 4)
    assert.equal(byId.get('a3').status, 'delivered')
    assert.equal(byId.get('b1').status, 'pending', 'another session stays pending')
  })
})

test('a later step of the same turn carries nothing extra', async () => {
  await withPlugin([record({ id: 'a1', note: '只有一条' })], async ({ captured }) => {
    const handler = captured.events.get('agent/pre-step')
    const payload = { agent: { id: 'session-alpha' }, turn: 7, step: 1, messages: [] }
    const first = await handler(payload, async () => userStep('问题'))
    assert.equal(first.messages[0].content.length, 2)
    const second = await handler({ ...payload, step: 2 }, async () => userStep('问题'))
    assert.equal(second.messages[0].content.length, 1, 'already delivered, no second injection')
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
    assert.equal(decision.messages[0].content.length, 2)
    assert.match(decision.messages[0].content[1].text, /嵌套形态/)
  })
})
