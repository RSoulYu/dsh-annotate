/**
 * Jump-to-source: the step table, the driver's counting rules and the failure
 * contract.
 *
 * The core lives inside `client.js` (a ModuleLoader bundle, not a module), so
 * this suite evaluates the shipped source twice, the same way
 * `anchor.test.mjs` does: once for the whole `@pure-anchor` slice (the step
 * function and the driver) and once for the jump helpers below it (the session
 * lookup, the terminal state). Nothing here is a copy that could drift — the
 * browser half is what runs.
 *
 * The failure path is the point of the feature: an unroutable jump must leave a
 * persistent, reason-specific, retryable state with `data-dsa-jump` on the row,
 * never a lone toast. Those guarantees are asserted against the shipped source
 * and dictionaries in the last section.
 *
 * Run with: node --test
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const source = await readFile(new URL('../client.js', import.meta.url), 'utf8')

/** The one `@pure-anchor` slice, which now carries the anchoring core and the jump core. */
const CORE_HEAD = '    /* @pure-anchor\n     *\n     * Jump-to-source core.\n'
const anchorFrom = source.indexOf(CORE_HEAD)
const anchorTo = source.indexOf('/* @pure-anchor-end */')
assert.ok(anchorFrom !== -1 && anchorTo > anchorFrom, 'client.js must carry the jump core and @pure-anchor markers')
const anchorSlice = source.slice(anchorFrom, anchorTo)

/** The helpers below the pure slice: session lookup, terminal state, source contract. */
const tailFrom = source.indexOf('function sessionLookup()')
// Stop at the last helper's end, before the (incomplete) comment that precedes
// the next section: a half-open block comment does not compile.
const tailEnd = source.indexOf('    /**\n     * Render-error boundary:')
assert.ok(tailFrom !== -1 && tailEnd > tailFrom, 'client.js must carry the jump helpers')
const tailSlice = source.slice(tailFrom, tailEnd)

const EXPORTS = [
  'normalizeQuote',
  'buildAnchorIndex',
  'locateQuote',
  'quoteOccurrences',
  'occurrenceAt',
  'storedOccurrence',
  'wantedOccurrences',
  'badgeBox',
  'badgeBand',
  'badgeVisibleIn',
  'BADGE_SIDE',
  'JUMP_MAX_PAGES',
  'JUMP_MAX_STALLS',
  'JUMP_TICKS_PER_PAGE',
  'JUMP_REVEAL_TRIES',
  'JUMP_ACTIONS',
  'JUMP_REASONS',
  'JUMP_REASON_KEYS',
  'jumpStep',
  'jumpSlot',
  'jumpStateLabelKey',
  'jumpBusy',
  'runJump',
]

const core = new Function(`${anchorSlice}\nreturn { ${EXPORTS.join(', ')} }`)()
const {
  JUMP_MAX_PAGES,
  JUMP_MAX_STALLS,
  JUMP_TICKS_PER_PAGE,
  JUMP_REVEAL_TRIES,
  JUMP_ACTIONS,
  JUMP_REASONS,
  jumpStep,
  jumpSlot,
  jumpStateLabelKey,
  jumpBusy,
  runJump,
} = core

/* ------------------------------------------------------------------ frozen */

/**
 * The two UI dictionaries, read off the shipped source.
 *
 * They sit above the `@pure-anchor` slice, so they are lifted out by their own
 * initializer instead of by the slice.
 */
function dictionaries() {
  const grab = (name) => {
    const match = new RegExp(`var ${name} = \\{[\\s\\S]*?\\n    \\}`).exec(source)
    assert.ok(match !== null, `client.js must define ${name}`)
    return new Function(`${match[0]}\nreturn ${name}`)()
  }
  return { ZH: grab('ZH'), EN: grab('EN') }
}

test('the frozen constants keep their values', () => {
  assert.equal(JUMP_MAX_PAGES, 60)
  assert.equal(JUMP_MAX_STALLS, 3)
  assert.equal(JUMP_TICKS_PER_PAGE, 60)
  assert.deepEqual(JUMP_ACTIONS, ['land', 'reveal', 'page', 'wait', 'fail'])
  assert.deepEqual(JUMP_REASONS, ['no-session', 'absent', 'stalled', 'budget', 'folded'])
})

test('the jump core reads no wall clock', () => {
  // The budget is pages / stalls / frames on purpose: a frozen Date.now() must
  // change nothing, so the frozen run is evidence instead of luck. Comments may
  // name the clock they avoid; the code may not call it.
  const code = anchorSlice
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '')
  assert.equal(code.includes('Date.now'), false, 'the jump core must not read Date.now')
  assert.equal(code.includes('performance.now'), false, 'the jump core must not read performance.now')
})

/* ------------------------------------------------------------- the table */

/** Merge defaults so each case reads as the one field it is about. */
function step(overrides) {
  return jumpStep({
    hit: false,
    visible: false,
    revealed: false,
    binding: true,
    open: true,
    hasMore: true,
    loadingOlder: false,
    pages: 0,
    stalls: 0,
    ...overrides,
  })
}

test('a located, drawn quote lands — before session health is consulted', () => {
  assert.deepEqual(step({ hit: true, visible: true }), { action: 'land' })
  // Even with no session at all: something already in the DOM needs no host.
  assert.deepEqual(step({ hit: true, visible: true, binding: false, open: false, hasMore: false }), { action: 'land' })
})

test('a located but undrawn quote asks for one reveal, then fails folded', () => {
  assert.deepEqual(step({ hit: true, visible: false, revealed: false }), { action: 'reveal' })
  assert.deepEqual(step({ hit: true, visible: false, revealed: true }), { action: 'fail', reason: 'folded' })
})

test('no session and a window that is not open are the same failure', () => {
  assert.deepEqual(step({ binding: false }), { action: 'fail', reason: 'no-session' })
  assert.deepEqual(step({ open: false }), { action: 'fail', reason: 'no-session' })
  assert.deepEqual(jumpSlot({ binding: false, open: false }), { action: 'fail', reason: 'no-session' })
  assert.deepEqual(jumpSlot(null), { action: 'fail', reason: 'no-session' })
})

test('an in-flight page is waited for, never re-requested', () => {
  // This is the host's silent no-op: loadOlder() returns immediately while
  // loadingOlder is true, so 'page' here would spin at full speed.
  assert.deepEqual(step({ loadingOlder: true }), { action: 'wait' })
  // The guard sits before exhaustion and the budget: a busy window is waited
  // for even when it also reports no more history.
  assert.deepEqual(step({ loadingOlder: true, hasMore: false }), { action: 'wait' })
  assert.deepEqual(step({ loadingOlder: true, pages: JUMP_MAX_PAGES, stalls: JUMP_MAX_STALLS }), { action: 'wait' })
})

test('exhausted history fails absent when nothing is left to page', () => {
  assert.deepEqual(step({ hasMore: false }), { action: 'fail', reason: 'absent' })
})

test('three requests without a window change fail stalled', () => {
  assert.deepEqual(step({ stalls: JUMP_MAX_STALLS - 1 }), { action: 'page' })
  assert.deepEqual(step({ stalls: JUMP_MAX_STALLS }), { action: 'fail', reason: 'stalled' })
})

test('the page budget is the last word, and it survives a retry', () => {
  assert.deepEqual(step({ pages: JUMP_MAX_PAGES - 1 }), { action: 'page' })
  assert.deepEqual(step({ pages: JUMP_MAX_PAGES }), { action: 'fail', reason: 'budget' })
  // The window stays where the last attempt left it, so the retry starts from
  // the widened window: a budget failure is progress, not a dead end.
  assert.deepEqual(step({ pages: JUMP_MAX_PAGES + 40 }), { action: 'fail', reason: 'budget' })
})

test('the decision order is part of the contract', () => {
  // A hit wins over everything; loadingOlder wins over exhaustion and budget;
  // exhaustion wins over the stall counter; stalls win over the budget.
  assert.deepEqual(step({ hit: true, visible: true, loadingOlder: true, pages: 999 }), { action: 'land' })
  assert.deepEqual(step({ hasMore: false, stalls: 9 }), { action: 'fail', reason: 'absent' })
  assert.deepEqual(step({ stalls: 9, pages: 999 }), { action: 'fail', reason: 'stalled' })
  assert.deepEqual(step({ pages: 999 }), { action: 'fail', reason: 'budget' })
})

test('only the five frozen reasons ever come out', () => {
  const inputs = [
    { binding: false },
    { open: false },
    { hasMore: false },
    { stalls: JUMP_MAX_STALLS },
    { pages: JUMP_MAX_PAGES },
    { hit: true, visible: false, revealed: true },
  ]
  for (const input of inputs) {
    const output = step(input)
    assert.equal(output.action, 'fail')
    assert.ok(JUMP_REASONS.includes(output.reason), `${output.reason} is not a frozen reason`)
  }
})

/* ------------------------------------------------------------ the driver */

/**
 * A fake page that answers like the host does: `loadOlder()` appends one page,
 * the quote becomes locatable after `hitsAfter` requests, and every page moves
 * the window revision unless `stallFrom` says the host stopped returning data.
 * Call counters are recorded so the tests can assert what the driver did, not
 * only where it ended. The located element keeps its identity across calls,
 * exactly like a Range that a re-render did not replace.
 */
function driver(options = {}) {
  const state = {
    binding: options.binding !== false,
    open: options.open !== false,
    hasMore: 'hasMore' in options ? options.hasMore : true,
    loadingOlder: options.busyUntil === undefined ? false : true,
  }
  const record = {
    loads: 0,
    pages: 0,
    revision: 0,
    ticks: 0,
    reveals: 0,
    gen: 0,
    calls: [],
    hits: [],
    hitsAfter: options.hitsAfter === undefined ? 0 : options.hitsAfter,
    visible: options.visible !== false,
    visibleOnlyAfterReveal: options.visibleOnlyAfterReveal === true,
    revisionChanges: options.revisionChanges !== false,
    stallFrom: options.stallFrom,
    revealed: false,
    pageLimit: options.pageLimit,
    busyUntil: options.busyUntil === undefined ? 0 : options.busyUntil,
  }
  record.lastRevision = record.revision
  const deps = {
    gen: 0,
    current: () => record.gen,
    locate: () => {
      if (record.pages < record.hitsAfter) return null
      const index = record.pages - record.hitsAfter
      if (record.hits[index] === undefined) record.hits[index] = { id: 'page-' + record.pages }
      return record.hits[index]
    },
    visible: () => record.visible === true && !(record.visibleOnlyAfterReveal && record.revealed !== true),
    revealed: () => record.revealed,
    reveal: () => {
      record.reveals += 1
      record.revealed = true
    },
    tick: async () => {
      record.ticks += 1
      // A page in flight settles after `busyUntil` waits, like the host's.
      if (state.loadingOlder) {
        record.busyTicks = (record.busyTicks || 0) + 1
        if (record.busyTicks >= record.busyUntil) state.loadingOlder = false
      }
    },
    state: () => ({
      binding: state.binding,
      open: state.open,
      hasMore: state.hasMore,
      loadingOlder: state.loadingOlder,
    }),
    loadOlder: async () => {
      if (state.loadingOlder) return
      record.loads += 1
      record.calls.push('loadOlder')
      state.loadingOlder = true
      record.pages += 1
      if (record.pageLimit !== undefined && record.pages >= record.pageLimit) state.hasMore = false
      if (record.stallFrom === undefined || record.pages < record.stallFrom) record.revision += 1
    },
    revision: () => record.revision,
    get lastRevision() { return record.lastRevision },
    set lastRevision(value) { record.lastRevision = value },
  }
  return { deps, record, state }
}

test('path 1: a quote already in the loaded window lands with no page request', async () => {
  const d = driver()
  const out = await runJump(d.deps)
  assert.deepEqual(out, { action: 'land', reason: null, pages: 0, stalls: 0 })
  assert.equal(d.record.loads, 0, 'landing must not page the host history')
})

test('path 2: the driver pages history in until the quote appears, then lands', async () => {
  const d = driver({ hitsAfter: 3 })
  const out = await runJump(d.deps)
  assert.equal(out.action, 'land')
  assert.equal(out.pages, 3)
  assert.equal(d.record.loads, 3, 'exactly one loadOlder per page step')
  assert.equal(out.stalls, 0)
})

test('path 3: exhausted history fails absent after exactly one request', async () => {
  const d = driver({ hitsAfter: 1e9, hasMore: false })
  const out = await runJump(d.deps)
  assert.deepEqual(out, { action: 'fail', reason: 'absent', pages: 0, stalls: 0 })
  assert.equal(d.record.loads, 0, 'nothing is left to load, so nothing is requested')
})

test('loadingOlder === true waits: the driver must not call loadOlder while a page is in flight', async () => {
  const d = driver({ hitsAfter: 1e9, hasMore: false })
  d.state.loadingOlder = true
  // The page settles as soon as the driver waits for it, which is the real
  // shape: the host's own promise clears loadingOlder on the next frames.
  d.deps.tick = async (frames) => {
    assert.equal(frames, JUMP_TICKS_PER_PAGE)
    d.record.ticks += 1
    d.state.loadingOlder = false
  }
  const out = await runJump(d.deps)
  assert.equal(out.action, 'fail')
  assert.equal(out.reason, 'absent')
  assert.equal(d.record.loads, 0, 'a busy window must never be re-requested')
  assert.equal(d.record.ticks, 1, 'waiting spends frames, not pages')
})

test('a page that lands during the wait clears the busy state and resumes paging', async () => {
  const d = driver({ hitsAfter: 2 })
  d.state.loadingOlder = true
  let waits = 0
  const settled = d.deps.tick
  d.deps.tick = async (frames) => {
    if (frames === JUMP_TICKS_PER_PAGE) {
      waits += 1
      d.record.ticks += 1
      // The host applies the page while the driver waits for it.
      d.state.loadingOlder = false
      d.record.revision += 1
      return
    }
    return settled(frames)
  }
  const out = await runJump(d.deps)
  assert.equal(out.action, 'land')
  assert.equal(out.pages, 2, 'the wait did not consume the page budget, and paging then continued')
  assert.equal(waits, 1, 'exactly one wait for the in-flight page')
  assert.equal(d.record.loads, 2)
})

test('a busy window that never settles stops waiting and fails stalled', async () => {
  const d = driver({ hitsAfter: 1e9, busyUntil: 1e9 })
  d.state.loadingOlder = true
  // One pass spends JUMP_TICKS_PER_PAGE frames; the test answers that wait
  // immediately instead of scheduling real frames.
  d.deps.tick = async (frames) => {
    assert.equal(frames, JUMP_TICKS_PER_PAGE)
    d.record.ticks += 1
  }
  const out = await runJump(d.deps)
  assert.equal(out.action, 'fail')
  assert.equal(out.reason, 'stalled')
  assert.equal(d.record.loads, 0, 'stalls grow from waiting, never from re-requesting')
  assert.equal(out.pages, 0)
  assert.equal(d.record.ticks, 2, 'two wait budgets in a row are what ends it')
})

test('revision silence for three requests fails stalled', async () => {
  const d = driver({ hitsAfter: 1e9, stallFrom: 4 })
  const out = await runJump(d.deps)
  assert.equal(out.action, 'fail')
  assert.equal(out.reason, 'stalled')
  assert.equal(out.pages, 6, 'three advancing requests, then three silent ones')
  assert.equal(out.stalls, JUMP_MAX_STALLS, 'the three silent requests are what stopped it')
  assert.equal(d.record.loads, 6)
})

test('a page that does change the window clears the stall counter', async () => {
  const d = driver({ hitsAfter: 1e9, stallFrom: 3 })
  const out = await runJump(d.deps)
  assert.equal(out.action, 'fail')
  assert.equal(out.reason, 'stalled')
  assert.equal(out.pages, 5, 'pages 1-2 advanced, pages 3-5 were silent')
})

test('the 60-page budget stops an endless search with budget, not a hang', async () => {
  const d = driver({ hitsAfter: 1e9 })
  const out = await runJump(d.deps)
  assert.equal(out.action, 'fail')
  assert.equal(out.reason, 'budget')
  assert.equal(out.pages, JUMP_MAX_PAGES)
  assert.equal(d.record.loads, JUMP_MAX_PAGES)
})

test('a located quote with no box asks for one reveal, then reports folded', async () => {
  const d = driver({ visible: false })
  const out = await runJump(d.deps)
  assert.deepEqual(out, { action: 'fail', reason: 'folded', pages: 0, stalls: 0 })
  assert.equal(d.record.reveals, 1, 'the reveal is attempted exactly once')
})

test('a quote the reveal does not draw also reports folded', async () => {
  const d = driver({ visible: false, visibleOnlyAfterReveal: false })
  const out = await runJump(d.deps)
  assert.equal(out.reason, 'folded')
  assert.equal(d.record.reveals, 1)
  assert.equal(d.record.loads, 0)
})

test('a reveal that does draw the quote lands instead', async () => {
  const d = driver({ visible: false, visibleOnlyAfterReveal: true })
  // The fake becomes drawn once `reveal()` ran, the outcome the 1c branch aims at.
  d.deps.visible = () => d.record.revealed === true
  const out = await runJump(d.deps)
  assert.equal(out.action, 'land')
  assert.equal(d.record.reveals, 1)
})

test('a session switch mid-jump abandons it: the driver stops on a stale generation', async () => {
  const d = driver({ hitsAfter: 2 })
  d.deps.tick = async () => { d.record.ticks += 1; d.record.gen = 7 }
  const out = await runJump(d.deps)
  assert.equal(out.action, 'abandoned')
  assert.equal(d.record.loads, 1, 'the loop stops at the first page it notices is stale')
})

/* --------------------------------- path 3: the persistent, retryable failure */

test('every frozen reason has its own persistent label, and both dictionaries carry it', () => {
  const { ZH, EN } = dictionaries()
  const keys = []
  for (const reason of JUMP_REASONS) {
    const key = jumpStateLabelKey('failed', reason)
    assert.equal(typeof key, 'string')
    assert.notEqual(key, 'toast.jumpFailed', `${reason} must not fall back to the toast key`)
    assert.ok(keys.indexOf(key) === -1, `${key} is shared by two reasons`)
    keys.push(key)
    assert.equal(typeof ZH[key], 'string', `zh is missing ${key}`)
    assert.equal(typeof EN[key], 'string', `en is missing ${key}`)
    assert.ok(ZH[key].length > 0 && EN[key].length > 0)
  }
  assert.equal(keys.length, JUMP_REASONS.length)
})

test('a working jump shows a persistent busy label, and a settled jump shows none', () => {
  assert.equal(jumpStateLabelKey('locating', null), 'panel.jump.loading')
  assert.equal(jumpStateLabelKey('paging', null), 'panel.jump.loading')
  assert.equal(jumpStateLabelKey(null, null), null)
})

test('the busy phases disable the button, the failed phase does not', () => {
  assert.equal(jumpBusy('locating'), true)
  assert.equal(jumpBusy('paging'), true)
  assert.equal(jumpBusy('failed'), false, 'a failed jump must stay retryable')
  assert.equal(jumpBusy(null), false)
})

test('the browser half keeps the diagnosis and retry affordances, and stops faking a success', () => {
  const row = source.slice(source.indexOf('function JumpStatus'), source.indexOf('function redeliverAnnotation'))
  assert.ok(row.includes("'data-dsa-jump'"), 'the row must carry the diagnostic attribute')
  assert.ok(row.includes("'data-dsa-jump-pages'"), 'the row must carry the page budget it burned')
  assert.ok(row.includes("'failed:' + jump.reason"), 'the attribute must name the reason')
  assert.ok(source.includes('h(JumpStatus, { jump: jump })'), 'the panel row must render it')
  assert.ok(source.includes('h(JumpStatus, { jump: jumpOf(annotation.id) })'), 'the popover must render it')
  assert.ok(source.includes('smallButton(tr(\'panel.jump\'), guard(\'jump to source\', function () { jumpTo(annotation) }), undefined, jumpBusy('))

  const jumpTo = source.slice(source.indexOf('function jumpTo(annotation)'), source.indexOf('function clearJump()'))
  assert.equal(jumpTo.includes('showToast'), false, 'jumpTo must not end in a toast alone')
  assert.ok(jumpTo.includes('store.jump = { id: annotation.id'), 'a jump must be visible while it runs')
  assert.ok(jumpTo.includes('phase: \'locating\''))
  assert.ok(jumpTo.includes('executeJump(wanted, gen)'))

  const finish = source.slice(source.indexOf('function finishJump('), source.indexOf('function jumpTo(annotation)'))
  assert.ok(finish.includes("phase: 'failed'"), 'a failed jump must reach the failed phase')
  assert.ok(finish.includes('store.jump = { id: id'), 'the failed state is persistent, not a toast')
  assert.ok(finish.includes("showToast(tr(jumpStateLabelKey('failed', reason)))"), 'the toast echoes the persistent line, it is not the only signal')
  assert.ok(finish.includes('landJump'), 'landing must go through the shared landing step')

  const land = source.slice(source.indexOf('function landJump('), source.indexOf('async function executeJump'))
  assert.ok(land.includes('scrollIntoViewCentered'), 'landing must actually move the view')
  assert.ok(land.includes('syncHighlights'), 'landing must repaint the highlight')
})

test('the panel mark-up shows the reason and the view hint instead of the disproved scroll advice', () => {
  assert.ok(source.includes("children.push(h('div'"), 'the failure line must be able to carry the view hint')
  assert.ok(source.includes("tr('panel.jump.failed.viewHint')"))
  const { ZH, EN } = dictionaries()
  assert.equal(typeof ZH['panel.jump.failed.viewHint'], 'string')
  assert.equal(typeof EN['panel.jump.failed.viewHint'], 'string')
})

/* ------------------------------------------- session lookup and the export */

/**
 * Evaluate the browser half's jump helpers below the pure slice.
 *
 * The stub pair handed in is exactly what those functions read: the module
 * store and the `runtime` object the injected services land in.
 */
function tail(stub) {
  const body = new Function(
    'store',
    'runtime',
    'emit',
    'tr',
    'showToast',
    'jumpStateLabelKey',
    'syncHighlights',
    `${tailSlice}\nreturn { sessionLookup, windowRevision, sessionSnapshot, jumpStateOf, clearJump, jumpOf, finishJump }`,
  )
  return body(
    stub.store,
    stub.runtime,
    () => {
      stub.store.listeners.forEach((listener) => listener())
    },
    (key) => key,
    (message) => {
      stub.store.toast = message
    },
    jumpStateLabelKey,
    () => {},
  )
}

function stubStore(overrides = {}) {
  return {
    sessionId: 'session-00000000',
    ranges: Object.create(null),
    jump: null,
    jumpGen: 0,
    listeners: new Set(),
    toasts: [],
    ...overrides,
  }
}

test('a missing sessions service degrades to no-session and never throws', () => {
  const store = stubStore()
  const jump = tail({ store, runtime: { sessions: null } })
  assert.deepEqual(jump.sessionLookup(), { ok: false, binding: null, why: 'the host provides no sessions service' })
  // No session bound yet is the same answer, not an error.
  assert.equal(tail({ store: stubStore({ sessionId: null }), runtime: { sessions: null } }).sessionLookup().ok, false)
})

test('a host sessions service that throws is reported, not propagated', () => {
  const store = stubStore()
  const runtime = {
    sessions: {
      binding() {
        throw new Error('binding exploded')
      },
    },
  }
  const jump = tail({ store, runtime })
  const lookup = jump.sessionLookup()
  assert.equal(lookup.ok, false)
  assert.equal(lookup.why, 'binding exploded')
})

test('an unknown session id answers with no binding', () => {
  const jump = tail({ store: stubStore(), runtime: { sessions: { binding: () => undefined } } })
  assert.deepEqual(jump.sessionLookup(), { ok: false, binding: null, why: 'the host has no binding for this session' })
})

test('the snapshot is read defensively and mapped to the frozen step inputs', () => {
  const binding = {
    session: { getSnapshot: () => ({ openState: 'open', hasMore: true, loadingOlder: false }) },
    eventSource: { getSnapshot: () => ({ revision: 41 }) },
  }
  const store = stubStore()
  const jump = tail({ store, runtime: { sessions: { binding: () => binding } } })
  const lookup = jump.sessionLookup()
  assert.equal(lookup.ok, true)
  assert.equal(jump.windowRevision(lookup.binding), 41)
  assert.deepEqual(jump.jumpStateOf(lookup.binding), { binding: true, open: true, hasMore: true, loadingOlder: false })
  // A broken face yields nulls, which the table turns into no-session — a
  // failure, never an exception and never a false "loaded".
  const broken = { session: {}, eventSource: {} }
  assert.equal(jump.windowRevision(broken), null)
  assert.deepEqual(jump.jumpStateOf(broken), { binding: true, open: false, hasMore: false, loadingOlder: false })
})

test('a settled failure keeps the reason and the page count for the row', () => {
  const store = stubStore()
  const jump = tail({ store, runtime: { sessions: null } })
  jump.finishJump('a1', store.jumpGen, { action: 'fail', reason: 'budget', pages: 60 }, null)
  assert.deepEqual(store.jump, { id: 'a1', gen: 0, phase: 'failed', reason: 'budget', pages: 60 })
  assert.equal(jump.jumpOf('a1').reason, 'budget')
  assert.equal(jump.jumpOf('other'), null)
  // A stale generation (the session switched, the row unmounted) must not
  // resurrect the state.
  store.jumpGen += 1
  jump.finishJump('a1', 0, { action: 'fail', reason: 'absent', pages: 1 }, null)
  assert.equal(store.jump.reason, 'budget')
})

test('clearJump abandons the run: the state goes away and the generation moves', () => {
  const store = stubStore({ jump: { id: 'a1', gen: 0, phase: 'paging', reason: null, pages: 2 } })
  const jump = tail({ store, runtime: { sessions: null } })
  jump.clearJump()
  assert.equal(store.jump, null)
  assert.equal(store.jumpGen, 1)
})

test('the tested slice carries the exported core, byte for byte', () => {
  // The module publishes `coreExports`, built from the declarations the suite
  // evaluates. Evaluating the shipped export block INSIDE the slice scope is
  // what catches an export that silently points somewhere else: the object the
  // module hands back and the one the tests run must be the same functions.
  const exportFrom = source.indexOf('var coreExports = {')
  const exportTo = source.indexOf('\n    }', exportFrom)
  assert.ok(exportFrom !== -1 && exportTo > exportFrom, 'client.js must publish coreExports')
  const exportBlock = source.slice(exportFrom, exportTo + '\n    }'.length)
  const published = new Function(`${anchorSlice}\n${exportBlock}\nreturn coreExports`)()
  const names = Object.keys(published).sort()
  assert.deepEqual(names, [
    'JUMP_ACTIONS',
    'JUMP_MAX_PAGES',
    'JUMP_MAX_STALLS',
    'JUMP_REASONS',
    'JUMP_REASON_KEYS',
    'JUMP_REVEAL_TRIES',
    'JUMP_TICKS_PER_PAGE',
    'jumpBusy',
    'jumpSlot',
    'jumpStateLabelKey',
    'jumpStep',
    'runJump',
  ])
  // And the suite's own destructuring is that object, not a parallel copy.
  assert.equal(String(core.jumpStep), String(published.jumpStep))
  assert.equal(String(core.runJump), String(published.runJump))
  assert.equal(String(core.jumpStateLabelKey), String(published.jumpStateLabelKey))
  assert.equal(core.JUMP_MAX_PAGES, published.JUMP_MAX_PAGES)
  assert.equal(core.JUMP_MAX_STALLS, published.JUMP_MAX_STALLS)
  assert.equal(core.JUMP_TICKS_PER_PAGE, published.JUMP_TICKS_PER_PAGE)
  assert.deepEqual(core.JUMP_ACTIONS, published.JUMP_ACTIONS)
  assert.deepEqual(core.JUMP_REASONS, published.JUMP_REASONS)
  assert.deepEqual(core.JUMP_REASON_KEYS, published.JUMP_REASON_KEYS)
  // The export block sits after the slice, so the slice markers cannot be
  // widened to swallow it and hide a second definition.
  assert.ok(source.indexOf('var coreExports = {') > source.indexOf('/* @pure-anchor-end */'))
  for (const name of ['jumpStep', 'jumpSlot', 'jumpStateLabelKey', 'jumpBusy', 'runJump']) {
    assert.ok(names.includes(name), `${name} must be exported for the suite`)
  }
  assert.ok(source.includes('core: coreExports'), 'the module must publish the core it tests')
})
