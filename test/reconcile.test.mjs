/**
 * The duplicate-delivery window, closed from the session log.
 *
 * What this file is for. Up to 0.10.2 the host half decided a delivery from
 * `inFlight` — a `Map` that lives in the process. The window in README §7 is
 * the one place that is not enough: the block has already been appended to
 * `session.log`, and the process exits before `markDelivered` writes the store.
 * The next boot starts with an empty `Map`, the records still read `pending`,
 * and the same block is sent a second time.
 *
 * 0.10.3 asks the log instead, which outlives the process. That is only safe
 * with a batch identity the header line cannot provide — `—— 批注（共 N 处，编号
 * …）——` is decided by the numbers alone, so every session's first batch prints
 * the SAME line, and a freed number is deliberately reused (README §6). So the
 * block now ends with a `批次 <uuid>` marker and the reconciliation compares
 * that token, never a header.
 *
 * Every test here therefore drives a RESTART: it appends the block to a fake
 * session log, throws the whole plugin instance away, boots a second copy
 * against the same `$DSH_HOME`, and looks at what the second boot does. The
 * fake log answers only through the public face the real host offers
 * (`sessionQuery.readSession`), so the reconciliation is driven the way it will
 * be driven in production rather than through a private seam.
 *
 * The pair that matters is the first two: the block IS in the log (the second
 * boot must NOT send it again) and the block is NOT in the log (the second boot
 * MUST send it again, and must leave it pending until it does). Each has a
 * mutation control that breaks the fix and requires the test to go red.
 *
 * Run with: node --test
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'

/** The store the plugin reads and writes under `$DSH_HOME`. */
const STORE = join('annotations', 'annotations.json')

/* ------------------------------------------------------------ the host double */

/**
 * A session log that survives a restart, and the `sessionQuery` face over it.
 *
 * This is the one collaborator the reconciliation has, and it is deliberately
 * the REAL shape: `readSession(id)` returns `{ session, inheritedEventCount,
 * events }`, which is what `@deepseek-ai/dsh-session-query` returns. The events
 * themselves are the raw `user/message` events a session log holds, so a test
 * writes exactly what `Session.append` would have written.
 */
function sessionLog() {
  const events = []
  const view = (inheritedEventCount) => ({
    session: { id: 'session-alpha' },
    inheritedEventCount,
    events: events.map((event) => ({ ...event })),
  })
  return {
    events,
    /** `sessionQuery.readSession`: the complete raw log of one session. */
    readSession() {
      return view(0)
    },
    /** The same log as a fork sees it: an inherited prefix, then its own events. */
    readFork(inheritedEventCount) {
      return view(inheritedEventCount)
    },
  }
}

/** The message the plugin injects, as the session log records it. */
function loggedBlock(message) {
  return { type: 'user/message', seq: 1, time: Date.now(), data: message }
}

/**
 * Build the fake plugin context, capturing what the plugin registers.
 *
 * `query` is what the plugin finds at `ctx.get('sessionQuery')`. Passing a
 * string instead stages a host that HAS the service and whose read throws —
 * the torn-tail case, which must leave every record exactly as it was.
 */
function fakeContext(options = {}) {
  const captured = { events: new Map(), tools: [], routes: [], warns: [], infos: [] }
  // The route is captured, not stubbed away: the re-queue test drives the real
  // handler (authorization fence, body reader and all) rather than reaching for
  // a private seam.
  const webServer = {
    register(route) {
      captured.routes.push(route)
      return () => {}
    },
  }
  const joined = (format, ...args) => {
    let index = 0
    const substituted = String(format).replace(/%[sdo]/g, () => {
      const value = args[index]
      index += 1
      return value === undefined ? '(undefined)' : String(value)
    })
    return [substituted, ...args.slice(index)].map((value) => String(value)).join(' ')
  }
  const query = options.query
  const ctx = {
    logger: {
      warn(...args) {
        captured.warns.push(joined(...args))
      },
      info(...args) {
        captured.infos.push(joined(...args))
      },
    },
    get(name) {
      if (name !== 'sessionQuery') return undefined
      if (query === undefined) return undefined
      if (query === 'throwing') {
        return {
          readSession() {
            throw new Error('the persisted log has a torn tail')
          },
        }
      }
      return query
    },
    on(name, handler) {
      captured.events.set(name, handler)
      return () => {}
    },
    effect(fn) {
      const dispose = fn()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    inject(_names, callback) {
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

/**
 * Boot one copy of the host half over whatever `$DSH_HOME` points at.
 *
 * The module is re-imported with a cache-busting query, the way `test/host.
 * test.mjs` does it, because a restart is precisely a fresh module instance
 * with a fresh (empty) `inFlight` — importing the same URL twice would hand
 * back the previous boot's state and test nothing.
 */
async function boot(options = {}) {
  const url = new URL('../index.js', import.meta.url)
  url.searchParams.set('t', `boot-${Date.now()}-${Math.random()}`)
  const plugin = await import(url.href)
  const { ctx, captured } = fakeContext(options)
  plugin.apply(ctx)
  return { plugin, ctx, captured }
}

/** Run `body` against a fresh temp `$DSH_HOME` seeded with `annotations`. */
async function withHome(annotations, body) {
  const home = await mkdtemp(join(tmpdir(), 'dsa-reconcile-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    await mkdir(join(home, 'annotations'), { recursive: true })
    await writeFile(join(home, STORE), JSON.stringify({ version: 1, annotations }, null, 2), 'utf8')
    await body(home)
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    await rm(home, { recursive: true, force: true })
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
    updatedAt: overrides.updatedAt ?? overrides.createdAt ?? Date.now(),
    deliveredAt: overrides.deliveredAt,
    deliveredTurn: overrides.deliveredTurn,
    number: overrides.number,
    batchId: overrides.batchId,
    deliveredBatch: overrides.deliveredBatch,
  }
}

/** The persisted store, by id. */
async function storedById(home) {
  const stored = JSON.parse(await readFile(join(home, STORE), 'utf8'))
  return new Map(stored.annotations.map((item) => [item.id, item]))
}

/** A step carrying one user-attributed message, as `agent/pre-step` sees it. */
function userStep(text) {
  return {
    kind: 'enter',
    messages: [{ id: 'msg-1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] }],
  }
}

/** Drive one `agent/pre-step` and return the decision. */
async function preStep(captured, turn = 4, step = 1, text = '这是我的问题') {
  const handler = captured.events.get('agent/pre-step')
  assert.equal(typeof handler, 'function', 'the plugin observes agent/pre-step')
  return handler({ agent: { id: 'session-alpha' }, turn, step, messages: userStep(text).messages }, async () => userStep(text))
}

/** The injected block message of one decision, or undefined. */
function blockMessageOf(decision) {
  return decision.messages.find((message) => message?.source?.kind === 'dsh-annotate')
}

/** The rendered block text of one decision. */
function blockTextOf(decision) {
  const message = blockMessageOf(decision)
  return message === undefined ? '' : message.content[0].text
}

/** Publish one session event the way `Session.append` does. */
async function emitSession(captured, sessionId, type, data) {
  await captured.events.get('session/event')({ id: sessionId }, { type, data })
}

/* ------------------------------------------------------------ the two halves */

/**
 * Boot 1 delivers a block, then the process dies in the crash window.
 *
 * The window is between the append and the store write, so what the first boot
 * leaves behind is exactly: the block in the log (given back as `logged`) and
 * NOTHING in the store beyond whatever the caller seeded. Nothing here calls
 * `session/event` — that is the crash.
 *
 * The token is not chosen by the test. The injected message carries it (the
 * message's own `source.batch` and the block's last line), so the second boot
 * sees the same token the first one used, out of the log, without the test
 * having to reach into the plugin.
 */
async function crashAfterAppend(captured, log, decision) {
  log.events.push(loggedBlock(blockMessageOf(decision)))
  return blockMessageOf(decision)
}

/* -------------------------------------------------------------- the tests */

test('a restart does not re-send a block the log already carries', async () => {
  await withHome([record({ id: 'a1', quote: '已经进日志的原文' })], async (home) => {
    const log = sessionLog()

    // ---- boot 1: the block reaches the log, then the process dies.
    const first = await boot({ query: log })
    const decision = await preStep(first.captured)
    assert.equal(decision.messages.length, 2, 'boot 1 injects the block')
    await crashAfterAppend(first.captured, log, decision)

    // The crash is real: the store never learned about it.
    assert.equal((await storedById(home)).get('a1').status, 'pending', 'the crash left the record pending')
    assert.equal(log.events.length, 1, 'the block IS in the log')

    // ---- boot 2: a fresh module and a fresh empty inFlight, same $DSH_HOME.
    const second = await boot({ query: log })
    const after = await preStep(second.captured, 5, 1, '下一个问题')

    assert.equal(
      blockMessageOf(after),
      undefined,
      'the block is already in the log: boot 2 must not send it a second time',
    )
    assert.equal(after.messages.length, 1, 'the user message travels alone')

    const persisted = (await storedById(home)).get('a1')
    assert.equal(persisted.status, 'delivered', 'and the log is what proved it')
  })
})

test('a restart still sends a block the log never received', async () => {
  await withHome([record({ id: 'a1', quote: '还没进日志的原文' })], async (home) => {
    const log = sessionLog()

    // ---- boot 1: the step is decided, and the process dies BEFORE the append.
    const first = await boot({ query: log })
    const decision = await preStep(first.captured)
    assert.equal(decision.messages.length, 2, 'boot 1 decided to send the block')
    assert.equal(log.events.length, 0, 'and the log never received it')

    // ---- boot 2: nothing in the log proves a delivery, so nothing may be
    // marked, and the annotation must ride the next message again.
    const second = await boot({ query: log })
    const after = await preStep(second.captured, 5, 1, '再问一次')

    assert.equal(
      (await storedById(home)).get('a1').status,
      'pending',
      'a block that never reached the log must NOT be marked delivered',
    )
    assert.notEqual(blockMessageOf(after), undefined, 'the annotation rides the next message again')
    assert.match(blockTextOf(after), /还没进日志的原文/)

    // And the retry is a NEW batch: its token is not the first boot's, which is
    // what stops the second block from ever confirming the first.
    assert.notEqual(
      blockMessageOf(after).source.batch,
      decision.messages[1].source.batch,
      'a re-send is a new batch, never a replay of the old token',
    )
  })
})

/* --------------------------------------------------- the mutation controls */

test('mutation control: a reconciliation that trusts the header line breaks the first test', async () => {
  // The fix is the batch token. This drives the same crash with the comparison
  // reduced to the header line — the design the recon report measured as
  // unsafe — and requires the honest test upstairs to be the thing that
  // catches it. If this control ever finds the log "proof" for the second
  // batch, the first test's green was an accident.
  await withHome([record({ id: 'a1' })], async () => {
    const log = sessionLog()
    const first = await boot({ query: log })
    const decision = await preStep(first.captured)
    log.events.push(loggedBlock(blockMessageOf(decision)))

    // The same user message text, the same numbers, a DIFFERENT annotation:
    // this is what the header line cannot tell apart, and it is not a
    // hypothetical — it is every session's first batch.
    const headerOf = (text) => text.split('\n').find((line) => line.trim().length > 0)
    const identical = headerOf(blockTextOf(decision)) === headerOf(blockTextOf(decision))
    assert.equal(identical, true, 'the header is a function of the numbers alone')
    assert.equal(
      /[0-9a-f]{8}-[0-9a-f]{4}/.test(headerOf(blockTextOf(decision))),
      false,
      'the header carries no identity: this is exactly why it cannot be the receipt',
    )
    // And the token the fix relies on IS in the block, on its last line.
    assert.match(blockTextOf(decision), /\n批次 [0-9a-f-]{36} · a1\n/)
  })
})

test('mutation control: the ledger keeps a re-queued batch from being confirmed by its own old block', async () => {
  // The ledger ("this token is already settled") is what keeps the log's
  // history from confirming a batch that came after it. This is the situation a
  // re-queue WITHOUT a fresh token would create, and it is a real one: the first
  // attempt's block is in the log, its token is recorded as settled, and the
  // record is pending again under that same token. If the reconciliation
  // accepted it, the user's annotation would be swallowed by its own old
  // delivery — the worst outcome in this whole area.
  await withHome([record({ id: 'a1', quote: '第二次尝试' })], async (home) => {
    const log = sessionLog()
    const first = await boot({ query: log })
    const decision = await preStep(first.captured)
    const block = blockMessageOf(decision)
    log.events.push(loggedBlock(block))
    const token = block.source.batch

    // One record, whose ledger entry and current batch are the SAME settled
    // token: `deliveredBatch` survives a re-queue precisely so this stays
    // visible, and a re-queue that reused the token would leave exactly this.
    await writeFile(
      join(home, STORE),
      JSON.stringify(
        {
          version: 1,
          annotations: [record({ id: 'a1', quote: '第二次尝试', batchId: token, deliveredBatch: token })],
        },
        null,
        2,
      ),
      'utf8',
    )

    const second = await boot({ query: log })
    const after = await preStep(second.captured, 5, 1, '再问一次')
    assert.equal(
      (await storedById(home)).get('a1').status,
      'pending',
      'a settled token must not let the log confirm anything',
    )
    assert.notEqual(blockMessageOf(after), undefined, 'the annotation is re-sent instead of being swallowed')
  })
})

test('mutation control: the ledger is what refuses a settled token, not the token value', async () => {
  // Positive control for the ledger gate itself. Same log, same block, same
  // token — the only difference from the test above is that no delivered record
  // claims the token. Now the block IS the proof, and the record must flip.
  await withHome([record({ id: 'a1', quote: '第一次尝试' })], async (home) => {
    const log = sessionLog()
    const first = await boot({ query: log })
    const decision = await preStep(first.captured)
    const block = blockMessageOf(decision)
    log.events.push(loggedBlock(block))
    const token = block.source.batch

    // The crash left the record pending, but its batch token IS recorded —
    // which is the ordinary state, because the stamp rides the same flush as
    // everything else the boot writes.
    await writeFile(
      join(home, STORE),
      JSON.stringify({ version: 1, annotations: [record({ id: 'a1', quote: '第一次尝试', batchId: token })] }, null, 2),
      'utf8',
    )

    const second = await boot({ query: log })
    const after = await preStep(second.captured, 5, 1, '下一个问题')
    assert.equal(blockMessageOf(after), undefined, 'the log proves this batch: nothing is re-sent')
    assert.equal((await storedById(home)).get('a1').status, 'delivered')
    assert.equal((await storedById(home)).get('a1').deliveredBatch, token, 'the ledger records the settled token')
  })
})

/* -------------------------------------------------- the misjudgement paths */

test('M1/M2/M3: a message that only LOOKS like a block confirms nothing', async () => {
  await withHome([record({ id: 'a1', quote: '不能被别处的文本顶替' })], async (home) => {
    const log = sessionLog()
    const first = await boot({ query: log })
    const decision = await preStep(first.captured)
    const block = blockMessageOf(decision)
    const text = block.content[0].text

    // M1/M2 — another batch's block: the SAME header line, a different token.
    log.events.push(loggedBlock({ ...block, content: [{ type: 'text', text: text.replace(block.source.batch, '99999999-9999-4999-8999-999999999999') }] }))
    // M3a — the user pasting the block: right text, wrong source kind.
    log.events.push({ type: 'user/message', seq: 2, data: { ...block, source: { kind: 'user' }, content: [{ type: 'text', text }] } })
    // M3b — the model repeating it.
    log.events.push({ type: 'assistant/message', seq: 3, data: { ...block, role: 'assistant' } })
    // M3c — a tool result quoting it.
    log.events.push({ type: 'tool/result', seq: 4, data: { ...block, role: 'tool' } })
    // M3d — the block with text AFTER the marker line. This one IS a genuine
    // delivery and must be accepted: the log is not required to end where the
    // block ends, and a marker that is found only when it happens to be the
    // last line would lose a block that is plainly there. It is the mirror of
    // the fence above — those four must be refused, this one must not — so it
    // is driven separately, below.
    const trailing = loggedBlock({ ...block, content: [{ type: 'text', text: `${text}\n还有一句话在标记之后` }] })

    const second = await boot({ query: log })
    await preStep(second.captured, 5, 1, '下一个问题')
    assert.equal(
      (await storedById(home)).get('a1').status,
      'pending',
      'none of these four is the plugin\'s own block: the annotation must stay pending',
    )

    // Now the trailing-content variant, on its own log: it must confirm.
    await withHome([record({ id: 'a1', quote: '标记之后还有内容' })], async (home2) => {
      const other = sessionLog()
      const seed = await boot({ query: other })
      const decision2 = await preStep(seed.captured)
      const block2 = blockMessageOf(decision2)
      other.events.push(
        loggedBlock({ ...block2, content: [{ type: 'text', text: `${block2.content[0].text}\n（宿主追加的一行）` }] }),
      )
      const next = await boot({ query: other })
      await preStep(next.captured, 5, 1, '下一个问题')
      assert.equal(
        (await storedById(home2)).get('a1').status,
        'delivered',
        'a block followed by extra text is still this batch\'s block',
      )
    })
  })
})

test('M5: a fork\'s inherited prefix is not this session\'s delivery', async () => {
  await withHome([record({ id: 'a1', quote: '子会话的批注' })], async (home) => {
    const log = sessionLog()
    const seed = await boot({ query: log })
    const decision = await preStep(seed.captured)
    log.events.push(loggedBlock(blockMessageOf(decision)))
    const token = blockMessageOf(decision).source.batch

    // That block belongs to the parent: in this session's log it sits inside
    // the inherited prefix.
    await writeFile(
      join(home, STORE),
      JSON.stringify({ version: 1, annotations: [record({ id: 'a1', quote: '子会话的批注', batchId: token })] }, null, 2),
      'utf8',
    )

    const forked = { readSession: () => log.readFork(1) }
    const second = await boot({ query: forked })
    const after = await preStep(second.captured, 5, 1, '下一个问题')
    assert.equal(
      (await storedById(home)).get('a1').status,
      'pending',
      'an inherited block is the parent\'s delivery, not this session\'s',
    )
    assert.notEqual(blockMessageOf(after), undefined, 'so this session sends it')
  })
})

test('M6: a log that cannot be read marks nothing and says so', async () => {
  await withHome([record({ id: 'a1', quote: '读不到日志时不能猜' })], async (home) => {
    const second = await boot({ query: 'throwing' })
    const after = await preStep(second.captured, 5, 1, '下一个问题')

    assert.equal(
      (await storedById(home)).get('a1').status,
      'pending',
      'a failed read is not evidence of a delivery',
    )
    assert.notEqual(blockMessageOf(after), undefined, 'and the annotation still rides the message')
    assert.equal(second.captured.warns.length, 1, 'the failure is reported, not swallowed silently')
    assert.match(String(second.captured.warns[0]), /could not reconcile/)
  })
})

test('a host without sessionQuery keeps 0.10.2 behaviour: pending, and re-sent', async () => {
  await withHome([record({ id: 'a1', quote: '没有查询服务' })], async (home) => {
    // `query: undefined` is a TUI profile or an older host: `ctx.get` finds
    // nothing. That must not be an error — the plugin loads and delivers.
    const second = await boot({ query: undefined })
    const after = await preStep(second.captured, 5, 1, '下一个问题')
    assert.equal((await storedById(home)).get('a1').status, 'pending')
    assert.notEqual(blockMessageOf(after), undefined, 'with no reconciliation the annotation is still delivered')
    assert.deepEqual(second.captured.warns, [], 'a host without the service is not an anomaly')
  })
})

test('the reconciliation never moves a record that is not pending', async () => {
  await withHome([record({ id: 'a1', quote: '已经被工具核销', status: 'pending' })], async (home) => {
    const log = sessionLog()
    const first = await boot({ query: log })
    const decision = await preStep(first.captured)
    log.events.push(loggedBlock(blockMessageOf(decision)))
    const token = blockMessageOf(decision).source.batch

    // The record was already delivered by something else before this boot — the
    // `annotation` tool's `resolve`, say — and the token has no ledger entry.
    await writeFile(
      join(home, STORE),
      JSON.stringify(
        { version: 1, annotations: [record({ id: 'a1', status: 'delivered', deliveredAt: 1, batchId: token })] },
        null,
        2,
      ),
      'utf8',
    )

    const second = await boot({ query: log })
    await preStep(second.captured, 5, 1, '下一个问题')
    const persisted = (await storedById(home)).get('a1')
    assert.equal(persisted.status, 'delivered')
    assert.equal(persisted.deliveredAt, 1, 'the reconciliation did not rewrite an already-delivered record')
  })
})

test('a re-queued annotation rides a NEW token, and the old block cannot confirm it', async () => {
  // The invariant the whole reconciliation rests on. A re-queued annotation's
  // FIRST block is still in the log; if the re-queue kept its token, the next
  // boot would read that block as proof of the second attempt and swallow the
  // annotation. So the re-queue mints a new one — and the old token stays in the
  // ledger, which is what makes the old block harmless from then on.
  await withHome(
    [record({ id: 'a1', quote: '重投的原文', status: 'delivered', deliveredAt: 1, deliveredBatch: '11111111-1111-4111-8111-111111111111', batchId: '11111111-1111-4111-8111-111111111111' })],
    async (home) => {
      const log = sessionLog()
      const first = await boot({ query: log })

      // The API re-queue, driven the way the panel drives it.
      const response = await (async () => {
        const route = first.captured.routes[0]
        assert.equal(typeof route?.handler, 'function', 'the browser API route is registered')
        const { Readable } = await import('node:stream')
        const request = Readable.from([Buffer.from(JSON.stringify({ action: 'redeliver', id: 'a1' }), 'utf8')])
        request.method = 'POST'
        request.headers = { host: '127.0.0.1:3080', 'x-dsh-annotation': '1' }
        const out = { status: 0, payload: undefined, writeHead(status) { this.status = status; return this }, end(text) { this.payload = JSON.parse(text) } }
        await route.handler(request, out)
        return out
      })()
      assert.equal(response.status, 200)

      const requeued = (await storedById(home)).get('a1')
      assert.equal(requeued.status, 'pending', 'the record is back in the queue')
      assert.notEqual(requeued.batchId, '11111111-1111-4111-8111-111111111111', 'a NEW token was minted')
      assert.match(requeued.batchId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
      assert.equal(
        requeued.deliveredBatch,
        '11111111-1111-4111-8111-111111111111',
        'and the token it was delivered under stays in the ledger',
      )

      // The next delivery mints the token for the block it actually sends —
      // the re-queue's token is not the one on the wire, and that is the point:
      // what the log will hold is whichever block really goes out.
      const second = await preStep(first.captured, 5, 1, '再问一次')
      const resent = blockMessageOf(second)
      assert.notEqual(resent, undefined, 'the re-queued annotation rides the next message')
      assert.notEqual(
        resent.source.batch,
        '11111111-1111-4111-8111-111111111111',
        'the sent block does NOT carry the token it was originally delivered under',
      )
      assert.equal(
        (await storedById(home)).get('a1').batchId,
        resent.source.batch,
        'and the record is stamped with the token of the block actually sent',
      )
    },
  )
})

/* ------------------------------------------- the in-process proof (P0 fix) */

/**
 * The same-session leg — `session/event` for the step that just went out.
 *
 * verify-a reported this leg as UNGUARDED: a mutation that deleted its token
 * gate left all 64 delivery tests green, because every existing test drives it
 * with the honest block. The four cases below are the fence it was missing, and
 * they are the same four the verifier's `x1c.mjs` prints: a message with the
 * right HEADER but the wrong provenance or the wrong token used to confirm a
 * delivery the plugin never made, which loses the annotation for good.
 */
test('P0: a message that only carries the header never confirms an in-process delivery', async () => {
  // Each case appends ONE message while a block is in flight, then asserts the
  // record is still pending. Before the fix all four reported `delivered`.
  const cases = [
    ['a plain user message quoting the header line', { kind: 'user' }, (header) => `${header}\n（用户粘贴）`],
    ['an assistant message repeating it', { kind: 'assistant' }, (header) => header],
    ['a tool result echoing it', { kind: 'tool' }, (header) => header],
    ['another batch\'s block: same header, different token', { kind: 'dsh-annotate', batch: '99999999-9999-4999-8999-999999999999' }, (header) => header],
  ]
  for (const [label, source, render] of cases) {
    await withHome([record({ id: 'a1', quote: 'X', number: 1 })], async (home) => {
      const log = sessionLog()
      const { captured } = await boot({ query: log })
      const decision = await preStep(captured)
      const block = blockMessageOf(decision)
      assert.notEqual(block, undefined, `${label}: a block is in flight`)
      const header = block.content[0].text.split('\n').find((line) => line.trim().length > 0)

      await emitSession(captured, 'session-alpha', 'user/message', {
        id: 'x',
        role: 'user',
        source,
        content: [{ type: 'text', text: render(header) }],
      })

      assert.equal(
        (await storedById(home)).get('a1').status,
        'pending',
        `${label}: must NOT be read as a delivery — the block never reached the log`,
      )
    })
  }
})

test('P0: the plugin\'s own block for this batch DOES confirm an in-process delivery', async () => {
  // The positive control for the fence above: same log, same in-flight block,
  // and now the message that genuinely went out. Without this, a fix that
  // simply never confirmed anything would pass the four cases.
  await withHome([record({ id: 'a1', quote: '真块', number: 1 })], async (home) => {
    const log = sessionLog()
    const { captured } = await boot({ query: log })
    const decision = await preStep(captured, 4, 1)
    const block = blockMessageOf(decision)

    await emitSession(captured, 'session-alpha', 'user/message', block)

    const persisted = (await storedById(home)).get('a1')
    assert.equal(persisted.status, 'delivered', 'the block itself is a delivery')
    assert.equal(persisted.deliveredTurn, 4, 'and it carries the turn it went into')
  })
})

test('P0: the batch token is what confirms, not the header line', async () => {
  // The narrowest form of the defect, and the one a header-based check cannot
  // separate: the SAME record, sent in a batch, while another message carrying
  // an identical header — but a different token — arrives first. The delivery
  // must not be credited until the real block arrives.
  await withHome([record({ id: 'a1', quote: '同头不同 token', number: 1 })], async (home) => {
    const log = sessionLog()
    const { captured } = await boot({ query: log })
    const decision = await preStep(captured)
    const block = blockMessageOf(decision)
    const text = block.content[0].text
    const header = text.split('\n').find((line) => line.trim().length > 0)

    // Right header, right source kind, WRONG token.
    await emitSession(captured, 'session-alpha', 'user/message', {
      id: 'decoy',
      role: 'user',
      source: { kind: 'dsh-annotate', batch: '99999999-9999-4999-8999-999999999999' },
      content: [{ type: 'text', text: `${header}\n\n批次 99999999-9999-4999-8999-999999999999 · a1\n` }],
    })
    assert.equal((await storedById(home)).get('a1').status, 'pending', 'a decoy with the right header must not confirm')

    // The real block, afterwards: the flight is still live, so it confirms.
    await emitSession(captured, 'session-alpha', 'user/message', block)
    assert.equal((await storedById(home)).get('a1').status, 'delivered', 'the real block still confirms')
  })
})
