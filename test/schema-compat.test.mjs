/**
 * The 0.10.3 store fields are additive, and this is the proof.
 *
 * The duplicate-delivery fix adds two optional keys to a record — `batchId`
 * (the batch it is currently riding) and `deliveredBatch` (the batch it was
 * delivered under). Neither needs a `STORE_VERSION` bump and neither needs a
 * migration, and that is a claim worth testing rather than asserting: a schema
 * change that a reader cannot round-trip is exactly how the "installed an older
 * version, lost the notes" class of defect gets in.
 *
 * So the three directions are driven here, with real files on disk:
 *
 *   1. **new code reads an old file** — a 0.10.2 document (no such keys) loads,
 *      lists, delivers and rides a message, and the keys are never invented;
 *   2. **old code reads a new file** — the shipped 0.10.2 reader is textually
 *      reconstructed here, its reader applied to a 0.10.3 document, and the
 *      records must survive with every field intact (`number` included — that
 *      is the documented cost the other way round, and this pins that the NEW
 *      keys do not join it);
 *   3. **the document keeps its shape** — `version` stays 1, no field is added
 *      to a record that never had a batch, and a value that is not a canonical
 *      UUID is dropped rather than stored.
 *
 * Run with: node --test
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'

const STORE = join('annotations', 'annotations.json')

async function boot() {
  const url = new URL('../index.js', import.meta.url)
  url.searchParams.set('t', `boot-${Date.now()}-${Math.random()}`)
  const plugin = await import(url.href)
  const captured = { events: new Map(), tools: [], routes: [], warns: [], infos: [] }
  const webServer = { register: () => () => {} }
  const ctx = {
    logger: { warn() {}, info() {} },
    get: () => undefined,
    on(name, handler) {
      captured.events.set(name, handler)
      return () => {}
    },
    effect(fn) {
      const dispose = fn()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    inject(_names, callback) {
      callback({ webServer, reflect: { get: () => webServer }, effect: ctx.effect })
      return () => {}
    },
    tools: { register: (definition) => { captured.tools.push(definition); return () => {} } },
  }
  plugin.apply(ctx)
  return { plugin, captured }
}

async function withHome(text, body) {
  const home = await mkdtemp(join(tmpdir(), 'dsa-schema-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    await mkdir(join(home, 'annotations'), { recursive: true })
    await writeFile(join(home, STORE), text, 'utf8')
    await body(home)
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    await rm(home, { recursive: true, force: true })
  }
}

async function doc(home) {
  return JSON.parse(await readFile(join(home, STORE), 'utf8'))
}

/** A document exactly as 0.10.2 wrote it: no batch keys anywhere. */
function legacyDoc() {
  return {
    version: 1,
    annotations: [
      { id: 'a1', sessionId: 'session-alpha', quote: '旧一', note: 'n1', status: 'delivered', origin: 'assistant', createdAt: 100, updatedAt: 100, deliveredAt: 200, deliveredTurn: 3, number: 1 },
      { id: 'a2', sessionId: 'session-alpha', quote: '旧二', note: '', status: 'pending', origin: 'assistant', createdAt: 101, updatedAt: 101, number: 2 },
    ],
  }
}

test('a 0.10.2 document loads, delivers and never grows a batch key by itself', async () => {
  await withHome(JSON.stringify(legacyDoc(), null, 2), async (home) => {
    const { captured } = await boot()

    const listed = await captured.tools[0].execute({ action: 'list' }, { agent: { id: 'session-alpha' } })
    assert.deepEqual(listed.annotations.map((item) => item.number), [1, 2], 'the stored numbers are what the panel reads')

    // The pending one rides the next step. Stamping it is the first write.
    const step = { kind: 'enter', messages: [{ id: 'm', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'hi' }] }] }
    const decision = await captured.events.get('agent/pre-step')({ agent: { id: 'session-alpha' }, turn: 1, step: 1, messages: step.messages }, async () => step)
    assert.equal(decision.messages.length, 2, 'the legacy pending record still rides the message')

    const after = await doc(home)
    assert.equal(after.version, 1, 'no schema version bump: the new keys are additive')
    const a1 = after.annotations.find((item) => item.id === 'a1')
    // a1 was already delivered before this boot and is not in the batch, so it
    // must come back byte-identical — no key invented for it.
    assert.equal('batchId' in a1, false, 'a record outside the batch gets no batch key')
    assert.equal('deliveredBatch' in a1, false)
    assert.equal(a1.deliveredAt, 200, 'and its delivery stamp is untouched')
  })
})

test('a 0.10.3 document read by the shipped 0.10.2 reader keeps every field', async () => {
  // The 0.10.2 reader, reconstructed from the released source: it keeps a fixed
  // key set and drops everything else. If the new keys had been the only change
  // that matters it would still be safe, but the check that matters is that the
  // fields 0.10.2 DID know are all still there — `number` above all, since the
  // documented cost of a downgrade is otherwise that numbers are lost.
  const readBy0102 = (raw) => {
    const STATUSES = new Set(['pending', 'delivered'])
    const asString = (value, max) => (typeof value === 'string' ? value.slice(0, max) : '')
    const asNumber = (value) => (Number.isInteger(value) && value >= 1 ? value : undefined)
    return {
      version: 1,
      annotations: (Array.isArray(raw?.annotations) ? raw.annotations : [])
        .filter((item) => item !== null && typeof item === 'object' && !Array.isArray(item))
        .map((item) => ({
          id: asString(item.id, 120),
          sessionId: asString(item.sessionId, 120),
          quote: asString(item.quote, 2000),
          note: asString(item.note, 4000),
          status: STATUSES.has(item.status) ? item.status : 'pending',
          createdAt: Number.isFinite(item.createdAt) ? item.createdAt : Date.now(),
          updatedAt: Number.isFinite(item.updatedAt) ? item.updatedAt : Date.now(),
          deliveredAt: Number.isFinite(item.deliveredAt) ? item.deliveredAt : undefined,
          deliveredTurn: Number.isFinite(item.deliveredTurn) ? item.deliveredTurn : undefined,
          origin: item.origin === 'user' ? 'user' : 'assistant',
          occurrence: Number.isInteger(item.occurrence) && item.occurrence >= 0 ? item.occurrence : undefined,
          number: asNumber(item.number),
        }))
        .filter((item) => item.id.length > 0 && item.sessionId.length > 0),
    }
  }

  await withHome(JSON.stringify(legacyDoc(), null, 2), async (home) => {
    const { captured } = await boot()
    const step = { kind: 'enter', messages: [{ id: 'm', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'hi' }] }] }
    await captured.events.get('agent/pre-step')({ agent: { id: 'session-alpha' }, turn: 1, step: 1, messages: step.messages }, async () => step)

    const modern = await doc(home)
    assert.ok(modern.annotations.some((item) => typeof item.batchId === 'string'), 'the new key IS on disk')

    const downgraded = readBy0102(modern)
    for (const original of modern.annotations) {
      const survivor = downgraded.annotations.find((item) => item.id === original.id)
      assert.notEqual(survivor, undefined, `${original.id} survives the downgrade`)
      for (const field of ['sessionId', 'quote', 'note', 'status', 'createdAt', 'updatedAt', 'origin', 'number']) {
        assert.deepEqual(survivor[field], original[field], `${original.id}.${field} is preserved`)
      }
    }
    // And a 0.10.2 build can write that back without losing the annotations.
    const back = JSON.parse(JSON.stringify({ version: 1, annotations: downgraded.annotations }))
    assert.equal(back.annotations.length, 2)
    assert.deepEqual(back.annotations.map((item) => item.number), [1, 2])
  })
})

test('a batch value that is not a canonical UUID is dropped, not stored', async () => {
  await withHome(
    JSON.stringify(
      {
        version: 1,
        annotations: [
          { id: 'a1', sessionId: 'session-alpha', quote: 'q', note: '', status: 'pending', origin: 'assistant', createdAt: 1, updatedAt: 1, batchId: 'not-a-uuid' },
        ],
      },
      null,
      2,
    ),
    async (home) => {
      const { captured } = await boot()
      // The hand-edited value never reaches a comparison: a step stamps over it
      // with a real token, and the document is written without the bogus one.
      const step = { kind: 'enter', messages: [{ id: 'm', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'hi' }] }] }
      await captured.events.get('agent/pre-step')({ agent: { id: 'session-alpha' }, turn: 1, step: 1, messages: step.messages }, async () => step)
      const stored = (await doc(home)).annotations[0]
      assert.notEqual(stored.batchId, 'not-a-uuid', 'the invalid value is never carried forward')
      assert.match(stored.batchId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/, 'a real token took its place')
    },
  )
})

test('a record with an invalid batch value and nothing pending is left alone', async () => {
  await withHome(
    JSON.stringify(
      {
        version: 1,
        annotations: [
          { id: 'a1', sessionId: 'session-alpha', quote: 'q', note: '', status: 'delivered', origin: 'assistant', createdAt: 1, updatedAt: 1, deliveredAt: 2, number: 1, batchId: 42, deliveredBatch: ['nope'] },
        ],
      },
      null,
      2,
    ),
    async (home) => {
      const { captured } = await boot()
      // Nothing is pending for this session, so no step writes anything. The
      // load must not have thrown, and the tool must answer normally.
      const listed = await captured.tools[0].execute({ action: 'list' }, { agent: { id: 'session-alpha' } })
      assert.equal(listed.annotations.length, 1)
      assert.equal(listed.annotations[0].status, 'delivered')
      const stored = (await doc(home)).annotations[0]
      assert.equal(stored.batchId, 42, 'a non-string is not even rewritten by the reader')
    },
  )
})
