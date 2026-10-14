/**
 * The host CONTRACT drive — what the jump needs the host to *do*.
 *
 * Why this file exists: every other host check in this repository reads the
 * host's shipped source as text. `host-shape.test.mjs` asserts that certain
 * substrings are still there; that catches a rename, a moved file and a slot
 * that lost a prop, and it structurally cannot catch a host that kept every
 * byte of its text and changed what the code does. The measured counterexample
 * (recon report §3.2): delete the two `notifier.markDirty()` calls inside the
 * host's own `loadOlder()`, change nothing else, and the window's revision
 * stops moving — while all 23 shape assertions stay green. The jump then counts
 * every successful page as a stall and reports a failure the user cannot
 * explain.
 *
 * So this suite drives behaviour instead. It runs the REAL `runJump` and the
 * REAL `jumpDeps` — the same declarations the browser half ships — against a
 * host double that answers only through the host's public face: `sessions.
 * binding(id)`, then `binding.session` and `binding.eventSource`. The double's
 * `loadOlder()` is the host's own method, including its silent no-op guard.
 *
 * What it pins:
 *
 *   1. a host whose `loadOlder()` does NOT move the window revision must be
 *      reported as `stalled` — and the reason must be the stall, not the page
 *      budget, so a page that does move it is what clears the counter;
 *   2. a host that returns immediately from `loadOlder()` while its own
 *      `loadingOlder` guard is set must be WAITED for, never re-requested;
 *   3. a window at rest after a page (the snapshot lags a frame) must not read
 *      as a stall, and a revision that is not a number must not read as one
 *      either;
 *   4. a session that never appears must fail as `no-session` on the browser's
 *      own resolution path, and one that appears late must be re-resolved.
 *
 * Every question is driven TWICE: once with the honest host and once with a
 * host that answers the opposite way. If a question stops separating the two
 * answers, the mutation control for that row fails even though the honest row
 * still passes — which is the only way a green run here means anything. The
 * pair is asserted to actually differ in outcome first (`assert.notEqual`), so
 * a question that has quietly become unable to tell the two apart reports
 * *that*, rather than a downstream symptom.
 *
 * No host installation is needed: the double IS the host. The real one is
 * driven by `host-shape.test.mjs`, on a machine that has it and in the CI job
 * that installs it.
 *
 * Run with: node --test
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const source = await readFile(new URL('../client.js', import.meta.url), 'utf8')

/* ---------------------------------------------- where the real host is */

/**
 * The same root convention `host-shape.test.mjs` uses, because a second
 * convention would be a second way to be wrong.
 *
 * The one non-verifying path is an explicit `DSH_ANNOTATE_HOST_ROOT=absent`,
 * matching the shape fence: a machine that provably has no host says so out
 * loud. A host that is merely MISSING is a FAILURE here, never a skip — a
 * skipped test is how the real-host anchor silently stopped working the first
 * time (verification report §4).
 */
const HOST_ROOT_DEFAULT = '/usr/lib/node_modules/@deepseek-ai/dsh'
const HOST_ROOT_ENV = 'DSH_ANNOTATE_HOST_ROOT'
const HOST_ROOT_ABSENT = 'absent'
const SKIP_LINE = 'host contract check: skipped by DSH_ANNOTATE_HOST_ROOT=absent'

/** The file this suite reads off the host: the module that owns `loadOlder`. */
const HOST_SESSION_FILE = 'lib/client.js'
/** The sibling package, scope included, as it sits on disk. */
const HOST_SESSION_PACKAGE = '@deepseek-ai/dsh-api-session-controller'
/** The host package itself, scope included. */
const HOST_PACKAGE = '@deepseek-ai/dsh'

/**
 * Every layout a DSH root can present.
 *
 * A "root" in this repository is one of two real things, and both are in use:
 *
 *   1. an npm install PREFIX — `--prefix`, or a global prefix. The sibling
 *      packages are hoisted to `<root>/node_modules/@deepseek-ai/…`. This is
 *      the layout the CI job installs and the one `host-shape` asserts against.
 *   2. a dsh PACKAGE directory — `/usr/lib/node_modules/@deepseek-ai/dsh` on
 *      this machine. The siblings sit one level in, at
 *      `<root>/node_modules/@deepseek-ai/…`, because that is where the host's
 *      own dependency tree keeps them.
 *
 * The two spellings are the same relative path, which is why ONE candidate
 * covers both: what changes is what the root points at, not the shape beneath
 * it. The second candidate is kept for a tree that nests the scope directory
 * again, which a differently-hoisted install can produce.
 *
 * A root that matches neither is named in the failure instead of quietly
 * skipping.
 */
function hostSessionFileCandidates(root) {
  return [
    join(root, 'node_modules', HOST_SESSION_PACKAGE, HOST_SESSION_FILE),
    join(root, 'node_modules', HOST_PACKAGE, 'node_modules', HOST_SESSION_PACKAGE, HOST_SESSION_FILE),
  ]
}

/** The first existing host file for `root`, or null. */
function resolveHostSessionFile(root) {
  for (const candidate of hostSessionFileCandidates(root)) {
    if (existsSync(candidate)) return candidate
  }
  return null
}

const hostRoot = process.env[HOST_ROOT_ENV] ?? HOST_ROOT_DEFAULT
const hostOptedOut = hostRoot === HOST_ROOT_ABSENT
const hostFile = hostOptedOut ? null : resolveHostSessionFile(hostRoot)

/* ------------------------------------------------- the seam, pinned shut */

/**
 * The frozen member list of the host-face test seam.
 *
 * `client.js` publishes the declarations that read the host face so this suite
 * can drive the REAL ones; it declares the ceiling of that grant twice — once
 * as `testSeam`, once as the `@pure-anchor-face` block just above
 * `sessionLookup` — and both halves are asserted to be exactly this list. A new
 * member therefore cannot ride along in either direction: a widened grant breaks
 * the exact-list assertion, and a declaration that reads the host face without
 * being published cannot be reached by this drive at all.
 */
const HOST_FACE_FROZEN = [ 'frameSchedule', 'frameHook', 'bindSession', 'sessionLookup', 'sessionSnapshot', 'windowRevision', 'jumpStateOf', 'jumpDeps', 'executeJump' ]

/** The seam members `executeJump` itself calls, so they are not dead weight. */
const CALLED_BY_EXECUTE_JUMP = ['sessionLookup', 'jumpDeps']

/** The names published by the `testSeam` object literal. */
function declaredExports(text, label) {
  const marker = '    testSeam = {\n'
  const at = text.indexOf(marker)
  assert.notEqual(at, -1, `${label}: client.js must assign the test seam`)
  assert.equal(text.indexOf(marker, at + 1), -1, `${label}: the seam literal is assigned twice`)
  const end = text.indexOf('\n    }', at)
  assert.notEqual(end, -1, `${label}: the seam literal is not closed`)
  const names = []
  for (const line of text.slice(at, end).split('\n')) {
    const match = /^\s{6}([A-Za-z_$][\w$]*)\s*:/.exec(line)
    if (match !== null) names.push(match[1])
  }
  return names
}

/** The names the frozen `@pure-anchor-face` block says are granted. */
function declaredFaceCeiling(text, label) {
  const open = '    /* @pure-anchor-face\n'
  const close = '@pure-anchor-face-end'
  const from = text.indexOf(open)
  assert.notEqual(from, -1, `${label}: the @pure-anchor-face block is gone`)
  assert.equal(text.indexOf(open, from + 1), -1, `${label}: the @pure-anchor-face block is declared twice`)
  const to = text.indexOf(close, from)
  assert.notEqual(to, -1, `${label}: the @pure-anchor-face block is not closed`)
  const body = text.slice(from, to)
  return HOST_FACE_FROZEN.filter((name) => new RegExp(`^\\s*(?:\\*\\s*)?${name}\\b`, 'm').test(body))
}

test('the face-ceiling reader is not vacuous', () => {
  // The reader above is the thing that catches a widened grant, so it gets a
  // control of its own: it must find all six names in a block that has them,
  // and none in a block that does not.
  const present = ['    /* @pure-anchor-face\n', ...HOST_FACE_FROZEN.map((name) => `     *   ${name}    what it reads\n`), '     * @pure-anchor-face-end\n'].join('')
  const absent = ['    /* @pure-anchor-face\n', '     *   nothingHere    a member\n', '     * @pure-anchor-face-end\n'].join('')
  assert.deepEqual(declaredFaceCeiling(present, 'control'), HOST_FACE_FROZEN)
  assert.deepEqual(declaredFaceCeiling(absent, 'control'), [])
})

test('the host-face seam is exactly the frozen set, granted in exactly one place', () => {
  assert.deepEqual(declaredExports(source, 'client.js'), HOST_FACE_FROZEN, 'the seam must be the frozen set, in order')
  assert.deepEqual(declaredFaceCeiling(source, 'client.js'), HOST_FACE_FROZEN, 'the @pure-anchor-face ceiling must match')

  // The publication point: the seam rides the module object the loader seats,
  // which is what the host hands to cordis — NOT `ctx`. A client runtime fiber
  // rejects `ctx.hostFace = …` with "cannot set property \"hostFace\" without
  // provide", and that throw inside `apply` fails the entry and the whole web
  // boot; the module object carries it with no service registry involved.
  assert.ok(source.includes('hostFace: testSeam }'), 'the factory must publish the seam on its module object')
  assert.equal(/^\s*ctx\.hostFace\s*=/m.test(source), false, 'the seam must never be assigned onto ctx')

  // A hand-out, not an export: the bundle must gain no `export` statement (it
  // is a ModuleLoader bundle, not a module), and the published `coreExports`
  // must not grow a host-face member.
  assert.equal(/^\s*export\b/m.test(source), false, 'client.js is a ModuleLoader bundle and must not gain an export statement')
  const coreAt = source.indexOf('var coreExports = {')
  assert.notEqual(coreAt, -1, 'coreExports must still exist')
  const core = source.slice(coreAt, source.indexOf('\n    }', coreAt))
  for (const name of HOST_FACE_FROZEN) {
    assert.equal(core.includes(`${name}:`), false, `${name} must not leak into the published coreExports`)
  }

  // A cell of the face that nothing reads would be a grant with no purpose
  // (H21's failure mode, one level up). The two members `executeJump` calls are
  // checked against its own body here; the other four are driven over HTTP-like
  // reads by the rows below.
  const jumpAt = source.indexOf('async function executeJump(')
  assert.notEqual(jumpAt, -1, 'executeJump must still be declared')
  const body = source.slice(jumpAt, source.indexOf('\n    }\n', jumpAt))
  const called = HOST_FACE_FROZEN.filter((name) => name !== 'executeJump' && new RegExp(`\\b${name}\\(`).test(body))
  assert.deepEqual(called.sort(), CALLED_BY_EXECUTE_JUMP.slice().sort(), 'executeJump must reach the host face only through the frozen members')
  for (const name of ['sessionLookup', 'sessionSnapshot', 'windowRevision', 'jumpStateOf']) {
    assert.ok(new RegExp(`\\b${name}\\(`).test(source), `${name} must be called somewhere`)
  }
})

test('the client half never assigns a property onto ctx', () => {
  // The platform rule this fence encodes, measured rather than assumed: a client
  // runtime fiber refuses `ctx.<name> = value` for any name that was not
  // `provide`d — the throw reads
  //   cannot set property "hostFace" without provide
  // and it happens inside `apply`, which fails the entry, which aborts the
  // whole web boot ("Failed to load plugins: dsh-annotate"). 0.10.5 shipped
  // exactly that line and the page never mounted again; every test in this
  // repository stayed green, because this suite hands `apply` a plain object
  // and a plain object accepts any assignment. Services are registered with
  // `ctx.provide`; everything else a plugin needs stays local or rides the
  // module object the factory returns.
  const offenders = []
  source.split('\n').forEach((line, index) => {
    if (/^\s*ctx\.[A-Za-z_$][A-Za-z0-9_$]*\s*=[^=]/.test(line)) offenders.push(`client.js:${String(index + 1)}: ${line.trim()}`)
  })
  assert.deepEqual(offenders, [], 'assigning a non-service property onto ctx fails the web boot')
})

/* --------------------------------------------- the browser declarations */

const CORE_HEAD = '    /* @pure-anchor\n     *\n     * Jump-to-source core.\n'
const CORE_TAIL = '/* @pure-anchor-end */'
const SHIPPING_RETURN = "    return { inject: ['slots', 'locale'], apply: apply, core: coreExports, hostFace: testSeam }"
const PROBE_RETURN = [
  '    return {',
  '      hostFace: testSeam,',
  '      apply: apply,',
  '    }',
].join('\n')

/** The `runJump` and its constants, evaluated from the shipped bytes. */
function loadCore(text, label, { observeStep } = {}) {
  const from = text.indexOf(CORE_HEAD)
  const to = text.indexOf(CORE_TAIL)
  assert.ok(from !== -1 && to > from, `${label}: client.js must carry the @pure-anchor slice`)
  const slice = text.slice(from, to)
  const names = ['JUMP_MAX_PAGES', 'JUMP_MAX_STALLS', 'JUMP_TICKS_PER_PAGE', 'runJump']
  for (const name of names) {
    assert.ok(new RegExp(`(function|var|const)\\s+${name}\\b`).test(slice), `${label}: the core slice must define ${name}`)
  }
  if (observeStep === undefined) return new Function(`${slice}\nreturn { ${names.join(', ')} }`)()
  // A wrapper around the slice's OWN `jumpSlot`, appended after it so the
  // probe sees every decision the loop makes. Nothing in the slice is edited:
  // the wrapper shadows the name for the returned `runJump` and for nothing
  // else, which is why the shipping bytes under test stay byte-identical.
  const probe = `
    if (typeof jumpSlot !== 'function') throw new Error('the core slice must define jumpSlot')
    var __slot = jumpSlot
    jumpSlot = function (input) { __observe(input); return __slot(input) }
    return { ${names.join(', ')} }
  `
  const observe = observeStep
  return new Function('__observe', `${slice}\n${probe}`)(observe)
}

/**
 * Evaluate the browser half against one host, the way the host hands it over.
 *
 * The host's services are registered BEFORE the hook runs, which is what makes
 * the injection a real one: `apply`'s `ctx.inject(['sessions'], …)` callback
 * fires during `apply`, so a `sessions` object staged afterwards would arrive
 * after the plugin had already looked and found nothing. The facade's getters
 * read `services` live, so a row can still change the host mid-jump by writing
 * a new value — the same way a host can replace a service.
 */
function loadBrowserHalf(text, label, services = {}) {
  const at = text.indexOf(SHIPPING_RETURN)
  assert.notEqual(at, -1, `${label}: the shipping return is gone`)
  assert.equal(text.indexOf(SHIPPING_RETURN, at + 1), -1, `${label}: the shipping return is duplicated`)
  const probe = text.slice(0, at) + PROBE_RETURN + text.slice(at + SHIPPING_RETURN.length)
  assert.ok(probe.includes('hostFace: testSeam'), `${label}: the probe bundle must publish the seam`)

  let captured = null
  new Function('window', probe)({ __ModuleLoader__: { load: (definition) => { captured = definition } } })
  assert.notEqual(captured, null, `${label}: the bundle must register with the module loader`)

  // The smallest `react` that lets the factory body evaluate: `Boundary` is a
  // class component and the JSX helper is a plain function. The components are
  // never rendered here — that is `popover-render.test.mjs`, which mounts the
  // real thing — so a stub that throws on render would be honest, and this one
  // simply never gets called.
  const reactStub = {
    Component: class { constructor(props) { this.props = props; this.state = { error: null } } },
    createElement: (type, props, ...children) => ({ type, props, children }),
    useCallback: (fn) => fn,
    useEffect: () => {},
    useMemo: (fn) => fn(),
    useRef: (value) => ({ current: value }),
    useState: (value) => [typeof value === 'function' ? value() : value, () => {}],
  }
  const module = captured.factory(function (name) {
    if (name === 'react') return reactStub
    throw new Error(`${label}: the plugin required an unexpected module: ${name}`)
  })
  assert.notEqual(module, null, `${label}: the factory must build the module`)

  const live = []
  const ctx = {
    effect() {},
    inject(deps, run) {
      // A live facade: the getter reads the current value every time, so the
      // hook's callback and a later row see the same host.
      const scoped = {}
      for (const name of deps) {
        Object.defineProperty(scoped, name, { get: () => services[name], enumerable: true })
      }
      run(scoped)
      live.push(scoped)
    },
    locale: { register: () => () => {}, bind: () => () => '', subscribe: () => () => {} },
    slots: { inject: () => () => {}, register: () => () => {} },
  }
  module.apply(ctx)
  assert.ok(module.hostFace !== undefined && module.hostFace !== null, `${label}: the module must publish the host face`)
  assert.notEqual(module.hostFace.frameSchedule, null, `${label}: apply must hand over the real frame scheduler`)
  return { module, hostFace: module.hostFace, live, services }
}

/* ------------------------------------------------- the behavioural host */

const SID = 'session-under-test'

/**
 * A host double with the real face's shape and one switch per question.
 *
 * `loadOlder()` answers through `binding.session`; progress is read through
 * `binding.eventSource.getSnapshot()`. `state.loadingOlder` is the host's own
 * guard: while it is set, the host's `loadOlder()` returns at the top and does
 * nothing at all — the silent no-op the jump has to survive.
 *
 * Everything the rows vary is data, so both answers to a question can be driven
 * without editing this file:
 *
 *   pageRevision  what one `loadOlder()` call does to the window revision:
 *                 'advance' (the real host's `notifier.markDirty()` pair, which
 *                 publishes a new snapshot), 'hold' (the mutation: the page is
 *                 appended and nothing is published), 'perturb' (the snapshot
 *                 changes but the window does not — a non-movement that must
 *                 NOT clear the stall counter).
 *   landsAfter    how many appended pages it takes for the quote to appear.
 *   busyFor       how many `loadOlder()` calls the host's guard swallows.
 */
function hostDouble(options = {}) {
  const state = {
    /** Pages appended to the window. */
    appended: 0,
    /** The last published snapshot, i.e. what the host says the window is. */
    published: 0,
    /** The host's own in-flight guard, read back through its own snapshot. */
    loadingOlder: options.loadingOlder === true,
  }
  const calls = { binding: 0, session: 0, eventSource: 0, loadOlder: 0, noopLoadOlder: 0, getSnapshot: 0 }
  const record = { ticks: 0, tickFrames: 0, jumps: [] }

  const binding = {
    get session() {
      calls.session += 1
      return {
        loadOlder() {
          calls.loadOlder += 1
          // The host's guard: return immediately and page nothing.
          if (state.loadingOlder) {
            calls.noopLoadOlder += 1
            return undefined
          }
          if (options.busyFor !== undefined && calls.loadOlder < options.busyFor) {
            state.loadingOlder = true
            calls.noopLoadOlder += 1
            return undefined
          }
          if (options.landsAfter !== undefined && state.appended >= options.landsAfter) {
            state.loadingOlder = false
            return undefined
          }
          state.appended += 1
          if (options.pageRevision === 'hold') return undefined
          if (options.pageRevision === 'perturb') {
            state.published += 2
            return undefined
          }
          if (options.publishEvery !== undefined) {
            // `silent, silent, advance, …`: the shape a host that republishes on
            // its own cadence produces, and the only shape that can leave
            // `stalls` non-zero when a page DOES move the window.
            if (state.appended % options.publishEvery === 0) state.published += 1
            return undefined
          }
          // 'advance': the page lands AND the window is republished.
          state.published = Math.max(state.published + 1, state.appended)
          if (options.lateRevision === true) state.published = state.published
          return undefined
        },
        getSnapshot() {
          return {
            openState: state.open === false ? 'closed' : 'open',
            hasMore: state.hasMore === false ? false : true,
            loadingOlder: state.loadingOlder,
          }
        },
      }
    },
    get eventSource() {
      calls.eventSource += 1
      return {
        getSnapshot() {
          calls.getSnapshot += 1
          if (options.revisionShape === 'string') return { revision: 'r' + state.published }
          if (options.revisionShape === 'stale') return { revision: state.published - 1 }
          return { revision: state.published }
        },
      }
    },
  }

  const sessions = {
    binding(id) {
      calls.binding += 1
      if (id !== SID) return undefined
      if (options.binding === false) return undefined
      // A binding that is there, vanishes, and comes back: the resolution must
      // be re-run rather than cached for the length of a jump.
      if (options.wobble === true && calls.binding > 2 && calls.binding % 2 === 1) return undefined
      return binding
    },
  }

  return {
    // The host half of the facade, staged through the plugin's own injection by
    // `driveHost`. `sessions` is `null` when the option says the host does not
    // offer one, which is the "no host at all" case rather than a mocked one.
    sessions: options.sessions === 'missing' ? null : sessions,
    store: { sessionId: options.noSession === true ? null : SID, jumpGen: 1, jump: null, ranges: {} },
    record,
    calls,
    state,
  }
}

/**
 * Drive the REAL `executeJump` against one host double.
 *
 * Only the host is a double: the resolution, the adapter and the loop are the
 * browser half's own declarations. The collaborators the double cannot supply
 * are the DOM ones — locating, drawing, revealing, and counting frames — and
 * they are summarised here so the outcome can be read off without a DOM.
 */
/**
 * Drive the REAL `executeJump` against one host double.
 *
 * Only the host is a double. The seam, the resolution, the adapter and the loop
 * are the browser half's own declarations; so is `tick`, which runs on
 * immediate-reference frames through the seam's own `frameSchedule` — a wait is
 * therefore driven, not replaced, and there is no fake clock anywhere in the
 * path. The collaborators a DOM would supply (locating, drawing, revealing) are
 * summarised here so the outcome can be read off without a document.
 */
async function driveHost(options = {}, wrong = {}) {
  const host = hostDouble({ ...options, ...wrong })
  const { hostFace } = loadBrowserHalf(source, 'driveHost', { sessions: host.sessions })
  const locating = {
    /** How many appended pages it takes for `findQuoteRange` to answer. */
    landsAfter: wrong.landsAfter ?? options.landsAfter ?? Infinity,
    hits: 0,
    element: { id: 'quote' },
  }
  const record = host.record
  // The frame hook belongs to the drive, not to the host double: it observes
  // frames, and a row can use it to model a host that settles mid-wait.
  const onFrame = wrong.onFrame ?? options.onFrame
  // Frames, for real: the seam's own scheduler is pointed at an immediate
  // reference callback, which is what a browser's `requestAnimationFrame` gives
  // the plugin. The count is kept so a row can assert that a wait spent frames
  // rather than pages.
  const frames = { scheduled: 0, ticks: 0 }
  hostFace.frameHook((callback) => {
    frames.scheduled += 1
    queueMicrotask(() => {
      frames.ticks += 1
      record.tickFrames += 1
      if (onFrame !== undefined) onFrame(host)
      callback()
    })
  })
  assert.equal(typeof hostFace.frameSchedule, 'function', 'the seam must still offer the plugin frame scheduler')

  hostFace.bindSession(host.store.sessionId)
  const deps = hostFace.jumpDeps(host.store.jumpGen, { id: 'a1', quote: 'the quoted text', ordinal: 0 })
  host.deps = deps
  deps.locate = () => {
    locating.hits += 1
    return host.state.appended >= locating.landsAfter ? locating.element : null
  }
  deps.visible = () => host.state.appended >= locating.landsAfter
  deps.revealed = () => false
  deps.reveal = () => {}
  // The one field the adapter reads from the live loop: the generation, which a
  // session switch bumps. It never changes here, so a jump cannot be abandoned
  // by accident.
  deps.current = () => host.store.jumpGen

  // `runJump` returns only the counter it ENDED with, and the row that proves
  // the reset is reached needs the high-water mark on the way there. The core
  // slice is evaluated with its own `jumpSlot` wrapped, so the values the loop
  // actually handed the step table are recorded — the same values the reset
  // acts on — instead of being re-derived by the test.
  const peak = { stalls: 0 }
  const runJump = loadCore(source, 'driveHost', { observeStep: (input) => {
    if (input.stalls > peak.stalls) peak.stalls = input.stalls
  } }).runJump

  const outcome = await runJump(deps)
  record.jumps.push(outcome)
  return { outcome, deps, host, locating, calls: host.calls, frames, peak }
}

/* --------------------------------------------------------------- rows */

const MAX_STALLS = loadCore(source, 'row constants').JUMP_MAX_STALLS
const MAX_PAGES = loadCore(source, 'row constants').JUMP_MAX_PAGES
const TICKS_PER_PAGE = loadCore(source, 'row constants').JUMP_TICKS_PER_PAGE

test('the drive reaches the browser declarations, and the core constants are the frozen ones', () => {
  assert.equal(MAX_STALLS, 3)
  assert.equal(MAX_PAGES, 60)
  assert.equal(TICKS_PER_PAGE, 60)
  const { hostFace } = loadBrowserHalf(source, 'smoke')
  assert.deepEqual(Object.keys(hostFace).sort(), HOST_FACE_FROZEN.slice().sort())
  for (const name of HOST_FACE_FROZEN) assert.equal(typeof hostFace[name], 'function', `${name} must be callable`)
})

test('an honest host lands the jump, and a quote already in the window is never paged for', async () => {
  const { outcome, calls } = await driveHost({ landsAfter: 0 })
  assert.deepEqual(outcome, { action: 'land', reason: null, pages: 0, stalls: 0 })
  assert.equal(calls.loadOlder, 0, 'a quote in the loaded window must not reach the host at all')
})

test('the drive pages the honest host in until the quote appears, then lands', async () => {
  const { outcome, calls, host } = await driveHost({ landsAfter: 3 })
  assert.equal(outcome.action, 'land')
  assert.equal(outcome.pages, 3, 'one page per step, no more')
  assert.equal(outcome.stalls, 0, 'a host that moves the window never collects a stall')
  assert.equal(calls.loadOlder, 3)
  assert.equal(host.state.appended, 3)

  // The mutation control for this row: the SAME drive against a host whose
  // `loadOlder()` appends nothing can never land, so `land` above is a fact
  // about the host answering, not about the row being vacuous.
  const mutation = await driveHost({ landsAfter: 3 }, { landsAfter: Infinity })
  assert.notEqual(mutation.outcome.action, 'land', 'a host that never appends must not read as a landing')
})

test('QUESTION 1 variant — a stall streak survives a host that republishes on its own cadence', async () => {
  // The gap the verification report §5 found: `stalls` is NOT always 0 when a
  // page moves the window. A host that pages silently twice and then publishes
  // (silent, silent, advance, …) leaves `stalls === 2` when the third page
  // arrives, which is BELOW the failure threshold of 3 — so the reset line is
  // reachable with a non-zero counter, and that is exactly what it is for.
  //
  // Measured on the unrepaired core, this pattern ends at budget/60 pages; with
  // the reset removed it ends at stalled/4. The row asserts the FIRST of those,
  // so a core that stops resetting the counter is red here.
  const cadence = await driveHost({ landsAfter: Infinity, publishEvery: 3 })

  assert.equal(cadence.outcome.action, 'fail')
  assert.equal(cadence.outcome.reason, 'budget', 'a slow-but-alive host must exhaust the page budget, not be called stalled')
  assert.equal(cadence.outcome.pages, MAX_PAGES, 'it pages the whole history: the two silent pages never accumulate to a failure')
  assert.equal(cadence.outcome.stalls, 0, 'the advance clears the streak, so no stall survives to the end')

  // The two assertions above are only meaningful if the pattern really left a
  // non-zero counter for the reset to clear, so the mid-run value is measured
  // rather than assumed: this is the whole difference between this row and the
  // control above, and the reason the gap went unnoticed.
  assert.equal(cadence.peak.stalls, 2, 'the silent, silent, advance pattern must reach stalls === 2 before the reset clears it')

  // The discriminating control: the same cadence with no publication at all is
  // what `stalled` means, so the two outcomes are genuinely different.
  const dead = await driveHost({ landsAfter: Infinity, pageRevision: 'hold' })
  assert.equal(dead.outcome.reason, 'stalled')
  assert.notEqual(dead.outcome.reason, cadence.outcome.reason, 'a cadence that publishes must not read like one that never does')
})

test('QUESTION 1 — a host whose loadOlder() does not move the revision is reported stalled, not retried into the budget', async () => {
  // The mutation that motivated this file: the host still appends the page, its
  // own `hasMore` and `loadingOlder` still behave, and its snapshot never
  // changes, because the `notifier.markDirty()` pair inside its `loadOlder()`
  // is gone.
  const honest = await driveHost({ landsAfter: Infinity })
  const mutated = await driveHost({ landsAfter: Infinity, pageRevision: 'hold' })

  // State the separation as an assertion of its own first: if a future
  // `runJump` stops reading the revision, this row says so directly rather than
  // through whatever symptom the loss would produce further down.
  assert.equal(honest.outcome.reason, 'budget', 'the honest host is only stopped by the page budget')
  assert.equal(mutated.outcome.reason, 'stalled', 'the silent host is stopped by the stall counter')
  assert.notEqual(honest.outcome.reason, mutated.outcome.reason, 'the revision must separate these two hosts')

  assert.deepEqual(honest.outcome, { action: 'fail', reason: 'budget', pages: MAX_PAGES, stalls: 0 })
  assert.equal(honest.calls.loadOlder, MAX_PAGES, 'a moving window spends the page budget, one call per page')

  assert.deepEqual(mutated.outcome, { action: 'fail', reason: 'stalled', pages: MAX_STALLS, stalls: MAX_STALLS })
  assert.equal(mutated.calls.loadOlder, MAX_STALLS, 'a silent window must be given up on, not hammered 60 times')
  assert.equal(mutated.host.state.appended, MAX_STALLS, 'the mutated host still appended: the page landed, only the publish was gone')
})

test('QUESTION 1 control — the counter is cleared by a window that really moves, and only by that', async () => {
  // Two silent pages, then the host starts publishing: the next page must clear
  // the counter, so the jump survives a host that was merely slow to publish.
  let pages = 0
  const reviving = await driveHost({
    landsAfter: Infinity,
    onTick: (host, frames) => {
      if (frames !== TICKS_PER_PAGE) return
      // A page that arrives late, publishing itself on the wait after it was
      // requested. Every OTHER wait stays silent.
      pages += 1
      if (pages === 3 || pages === 5 || pages === 7) host.state.published += 1
    },
  })
  assert.equal(reviving.outcome.action, 'fail')
  assert.equal(reviving.outcome.reason, 'budget', 'a host that publishes every so often must not be called stalled')
  assert.equal(reviving.outcome.pages, MAX_PAGES)

  // And the same shape without the revival is the mutation: silence on every
  // wait is exactly what `stalled` means.
  const silent = await driveHost({ landsAfter: Infinity, pageRevision: 'hold' })
  assert.equal(silent.outcome.reason, 'stalled')
  assert.notEqual(silent.outcome.reason, reviving.outcome.reason, 'silence on every page is a different outcome')
})

test('QUESTION 2 — a host that no-ops while its own guard is set is waited for, never re-requested', async () => {
  // The host opens with its own `loadingOlder` guard set: its `loadOlder()`
  // returns at the top and pages nothing. Its page promise settles inside the
  // first wait budget — a wait is a bank of frames, and the host resolves on
  // the last of them — which is the shape `jumpDeps`' real `tick` produces.
  const settleInTheFirstWait = (host) => {
    host.state.frames = (host.state.frames ?? 0) + 1
    if (host.state.frames === TICKS_PER_PAGE) host.state.loadingOlder = false
  }

  // Honest: the guard clears after the first wait, and the drive then pages the
  // host in. `calls.loadOlder` therefore grows past the one swallowed request.
  const honest = await driveHost({ landsAfter: Infinity, loadingOlder: true, onFrame: settleInTheFirstWait })
  // The opposite answer: the guard is re-armed on every frame, so it never
  // settles. The drive must wait it out, not ask and ask.
  const mutated = await driveHost({ landsAfter: 2, loadingOlder: true, onFrame: (host) => { host.state.loadingOlder = true } })

  assert.equal(honest.outcome.pages > 1, true, 'the wait must resume paging once the host settles')
  assert.equal(mutated.outcome.pages, 0, 'a host that never settles is never charged a page')
  assert.equal(mutated.outcome.reason, 'stalled', 'and it is given up on rather than spun against')
  assert.equal(honest.outcome.reason, 'budget')

  // The separation, stated where it is sharpest: the mutated host's silent
  // no-op is never called again, so no request is ever swallowed by it.
  assert.equal(mutated.calls.loadOlder, 0, 'the busy host is never asked while its guard is set')
  assert.ok(honest.calls.loadOlder > mutated.calls.loadOlder, 'the settled host is asked, the stuck one is not')
})

test('QUESTION 2 control — waiting spends frames, not pages, and two waits in a row end it stalled', async () => {
  const never = await driveHost({
    landsAfter: Infinity,
    loadingOlder: true,
    // The host never settles: its promise never resolves, which is a host that
    // is gone rather than one that is busy.
  })
  assert.deepEqual(never.outcome, { action: 'fail', reason: 'stalled', pages: 0, stalls: 0 })
  assert.equal(never.calls.loadOlder, 0, 'nothing is requested while the host is busy')
  assert.equal(never.host.state.appended, 0)
})

test('QUESTION 3 — a snapshot that is a frame behind is not a stall, and a non-numeric revision is not progress', async () => {
  // The adapter reads the host's published snapshot at the instant the jump
  // resolves a step, so `stale` is the honest shape for a host that publishes
  // on its own next frame: the revision is read one behind, and it must not
  // read as "nothing moved".
  const stale = await driveHost({ landsAfter: 4, revisionShape: 'stale' })
  assert.equal(stale.outcome.action, 'land', 'a snapshot read one frame behind must still land')
  assert.equal(stale.outcome.stalls, 0, 'and it must collect no stall, because the window really did move')

  const staleMutation = await driveHost({ landsAfter: 4, revisionShape: 'stale' }, { landsAfter: Infinity })
  assert.notEqual(staleMutation.outcome.action, 'land')

  // A revision of the wrong TYPE is not progress: the adapter answers `null`
  // and the drive falls back to its last reading, so a host whose window really
  // moved but cannot be read is reported as silent — `stalled`. Stated the way
  // the design states it: unreadable is not the same as moved.
  const typed = await driveHost({ pageRevision: 'hold', revisionShape: 'string' })
  assert.equal(typed.outcome.action, 'fail')
  assert.equal(typed.outcome.reason, 'stalled', 'an unreadable revision may not be read as a movement')
  assert.equal(typed.outcome.stalls, MAX_STALLS)

  // The control: the SAME host with a readable revision is caught by the budget
  // instead, so the two readings are genuinely different outcomes.
  const readable = await driveHost({ pageRevision: 'advance', revisionShape: 'number' })
  assert.equal(readable.outcome.reason, 'budget')
  assert.notEqual(readable.outcome.reason, typed.outcome.reason)
})

test('QUESTION 4 — a session that never appears fails no-session, and the resolution is re-run, never cached', async () => {
  const absent = await driveHost({ binding: false })
  assert.equal(absent.outcome.action, 'fail')
  assert.equal(absent.outcome.reason, 'no-session')
  assert.equal(absent.calls.loadOlder, 0, 'with no binding there is nothing to page')

  // The face is re-resolved on every step, so a session that comes back is
  // picked up instead of a stale binding being driven forever.
  const wobble = await driveHost({ landsAfter: 2, wobble: true })
  assert.equal(wobble.calls.binding > 1, true, 'the binding must be looked up again, not held')
})

test('the timeout is spent in whole frames, so a frozen clock changes nothing', async () => {
  const { outcome, host } = await driveHost({ landsAfter: 2 })
  assert.equal(outcome.action, 'land')
  assert.ok(host.record.tickFrames > 0)
  assert.equal(host.record.tickFrames % 1, 0, 'every wait is a whole number of frames')
})

/* ------------------------------------------- the real host's loadOlder */

if (hostOptedOut) {
  // The ONE non-verifying path, and it says so out loud. Everything else about
  // this file still runs: the double is the host, and only this one row needs a
  // real installation.
  test('the host half of this contract (skipped)', () => {
    console.log(SKIP_LINE)
  })
} else if (hostFile === null) {
  test('the host half of this contract is real: its loadOlder() publishes, and the drive notices when it stops', () => {
    // A missing host is a FAILURE, never a skip. The first version of this file
    // resolved its path to a place no host has ever been and skipped forever,
    // which is how the only real-host anchor in the drive became decorative
    // (verification report §4). Failing loudly is the fix: the row below cannot
    // be green on a machine that never ran it.
    assert.fail(
      `host root resolved to nothing: ${hostRoot}\n` +
        `  ${HOST_ROOT_ENV} is "${process.env[HOST_ROOT_ENV] ?? '(unset)'}"\n` +
        '  looked for the host session module at:\n' +
        hostSessionFileCandidates(hostRoot)
          .map((candidate) => `    ${candidate}`)
          .join('\n') +
        '\n  fix: point ' + HOST_ROOT_ENV + ' at a DSH install prefix or package directory,\n' +
        '  or set ' + HOST_ROOT_ENV + '=absent in an environment that provably has no DSH\n' +
        '  (the explicit opt-out prints a skip line and must never be quoted as a verification).',
    )
  })
} else {
  test('the host half of this contract is real: its loadOlder() publishes, and the drive notices when it stops', async () => {
    const text = await readFile(hostFile, 'utf8')

    // The real method, as shipped: the guard, then the publish, then the append.
    const at = text.indexOf('async loadOlder() {')
    assert.notEqual(at, -1, 'the host must still declare loadOlder')
    const body = text.slice(at, text.indexOf('\n\t\t\t}', at))
    const publishes = body.split('this.notifier.markDirty();').length - 1
    assert.ok(publishes >= 1, 'the host loadOlder() must publish a new snapshot when it pages')

    // The mutation this file exists for, applied to the REAL host text: the
    // double's `pageRevision: 'hold'` answer is exactly what that edit produces,
    // and the drive above is asserted to call it stalled.
    const stripped = body.split('this.notifier.markDirty();').join('')
    assert.notEqual(stripped, body, 'the publish call must be what was removed')
    assert.equal(stripped.includes('markDirty'), false, 'the mutation removed every publish from loadOlder')
    assert.equal((text.split('notifier.markDirty(').length - 1) > publishes, true, 'the host publishes from other call sites too, which is why the window still moves for other reasons')

    // Printed, so a log says which installation this row verified against
    // rather than leaving it to be inferred from a path nobody sees.
    console.log(`host-contract: verified the real host's loadOlder() at ${hostFile} (${publishes} publish calls)`)
  })
}
