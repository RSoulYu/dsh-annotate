/**
 * Jump-to-source, driven through the SHIPPING BYTES.
 *
 * Why this file exists (the root cause of the 0.10.0 blocker): the other jump
 * suite evaluates two `new Function` slices of `client.js`, and the driver tests
 * feed `runJump` their OWN `deps`. Nothing there ever executes `jumpDeps`,
 * `executeJump` or `jumpTo`, so the shipping `loadOlder` collaborator could
 * reference an undefined identifier — and it did, for the whole round: the
 * "load earlier history" path threw `ReferenceError: act is not defined` at
 * runtime while 134 tests stayed green.
 *
 * So this suite runs the whole factory body of `client.js`: everything between
 * `factory(require) {` and the body's final `return { inject: … }` is the
 * shipping source, byte for byte, and only that one return statement is swapped
 * for a probe return. The host's session face is a fixture shaped after the
 * host's own declarations (`SessionBinding.session` = `SessionFace` =
 * `ISession & ObservableSnapshot<SessionSnapshot>`; `eventSource` =
 * `ObservableSnapshot<SessionEventWindow>`), and every host call is counted.
 *
 * The point of the tests below: when the quote is not mounted, the host must be
 * asked for older history — actually asked, not "the suite went green".
 *
 * Run with: node --test
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const source = await readFile(new URL('../client.js', import.meta.url), 'utf8')

/** The frozen probe return: the only bytes of the factory body this suite replaces. */
const SHIPPING_RETURN = "    return { inject: ['slots', 'locale'], apply: apply, core: coreExports }"
const PROBE_RETURN = [
  'return {',
  '  apply: apply,',
  '  core: coreExports,',
  '  store: store,',
  '  runtime: runtime,',
  '  jumpTo: jumpTo,',
  '  executeJump: executeJump,',
  '  jumpDeps: jumpDeps,',
  '  sessionLookup: sessionLookup,',
  '  jumpStateOf: jumpStateOf,',
  '  locateJumpRange: locateJumpRange,',
  '  syncHighlights: syncHighlights,',
  '}',
].join('\n')

/**
 * The shipping factory body with its return statement swapped.
 *
 * A missing or duplicated marker is a hard failure: a silently empty or
 * mis-sliced body would make every test below vacuous.
 */
export function factoryBody(text) {
  const from = text.indexOf('factory(require) {')
  assert.ok(from !== -1, 'client.js must declare factory(require)')
  const open = text.indexOf('{', from)
  const asyncPrefix = text.slice(from - 'async '.length, from)
  const bodyHead = text.indexOf('\n', open) + 1
  const to = text.lastIndexOf('\n  },')
  assert.ok(to > bodyHead, 'client.js must close the module definition after the factory body')
  const body = text.slice(bodyHead, to)
  assert.equal(body.split(SHIPPING_RETURN).length, 2, 'the shipping return statement must appear exactly once')
  const swapped = body.replace(SHIPPING_RETURN, PROBE_RETURN)
  assert.equal(swapped.includes('act('), false, 'the factory body must not call an undefined `act`')
  return { body: swapped, async: asyncPrefix === 'async ' }
}

/**
 * Every global the factory body touches, plus the environment knobs a test
 * drives: the transcript text, the host session face and the frame clock.
 */
export async function environment() {
  const state = {
    texts: [],
    appended: 0,
    hostLoads: 0,
    binds: 0,
    revisions: 0,
    scrolls: 0,
    rangesRead: 0,
    loadingOlder: false,
    hasMore: true,
    openState: 'open',
    sessions: 'service',
    appendsQuote: false,
    quoteText: 'the sentence that is not loaded yet',
    pages: 0,
    budgetPages: 200,
    frameScheduler: null,
  }

  function makeText(value) {
    const element = {
      nodeType: 1,
      isConnected: true,
      rect: { width: 120, height: 18 },
      text: null,
      closest: () => null,
      parentElement: null,
      getBoundingClientRect() {
        this.rect = { width: 120, height: 18 }
        return this.rect
      },
      scrollIntoView() {
        state.scrolls += 1
      },
      appendChild() {},
      querySelector: () => null,
    }
    const textNode = {
      nodeType: 3,
      isConnected: true,
      nodeValue: String(value),
      parentElement: element,
    }
    element.text = textNode
    return { textNode, element }
  }

  function RangeStub() {
    state.rangesRead += 1
    let node = null
    this.startContainer = null
    this.getBoundingClientRect = () => {
      const rect = node === null ? { width: 0, height: 0 } : node.parentElement.rect
      return rect
    }
    this.setStart = (next) => {
      node = next
      this.startContainer = next
    }
    this.setEnd = () => {}
  }

  const documentStub = {
    body: {},
    head: { appendChild() {} },
    visibilityState: 'visible',
    getElementById: () => null,
    createElement: () => ({ id: '', style: {}, textContent: '', appendChild() {}, remove() {} }),
    createRange: () => new RangeStub(),
    createTreeWalker: () => {
      let index = 0
      const nodes = state.texts.slice()
      return {
        nextNode: () => (index < nodes.length ? nodes[index++] : null),
      }
    },
    addEventListener() {},
    removeEventListener() {},
  }

  const ReactStub = {
    Component: class Component {
      constructor(props) {
        this.props = props
      }
    },
    createElement: () => null,
    memo: (value) => value,
    useEffect() {},
    useLayoutEffect() {},
    useState: () => [undefined, () => {}],
    useRef: () => ({ current: null }),
    useCallback: (value) => value,
  }

  const windowStub = {
    __DSH_ANNOTATE__: {},
    __ModuleLoader__: { load: () => {} },
    getComputedStyle: () => ({ overflowY: 'visible' }),
    getSelection: () => null,
    addEventListener() {},
    removeEventListener() {},
    requestAnimationFrame: (callback) => {
      state.frameScheduler(callback)
      return 0
    },
  }

  globalThis.Highlight = class Highlight {
    constructor() {
      this.size = 0
    }
    add() {
      this.size += 1
    }
  }

  /** The host's session face, shaped after `ISession` / `SessionSnapshot` / `SessionEventWindow`. */
  const session = {
    ownsLoadOlder: true,
    /**
     * One `loadOlder()` call: at most one page, exactly as the host's own
     * implementation behaves while the flags line up.
     *
     * `appendsQuote` decides whether this page actually delivers anything. A
     * page that delivers nothing does NOT move the window revision — that is
     * the only public progress signal a jump can read, and it is what separates
     * "the host answered" from "the host is silent".
     */
    async loadOlder() {
      if (state.openState !== 'open' || state.hasMore !== true || state.loadingOlder === true) return
      state.hostLoads += 1
      state.pages += 1
      state.loadingOlder = true
      if (state.appendsQuote === true) {
        const quote = makeText(state.quoteText)
        state.texts.push(quote.textNode)
        state.appended += 1
        state.revisions += 1
      }
      if (state.pages >= state.budgetPages) state.hasMore = false
      state.loadingOlder = false
    },
    getSnapshot() {
      return { openState: state.openState, hasMore: state.hasMore, loadingOlder: state.loadingOlder }
    },
  }
  const eventSource = {
    getSnapshot() {
      return { entries: [], hasMore: state.hasMore, revision: state.revisions, change: null }
    },
  }
  const binding = { sessionId: 'session-fixture', session, eventSource, ctx: {} }
  const sessionsService = {
    binding() {
      state.binds += 1
      if (state.sessions !== 'service') return undefined
      return binding
    },
  }

  const requireStub = (name) => {
    if (name === 'react') return ReactStub
    throw new Error(`unexpected require('${name}') from the shipping factory`)
  }

  /** Hand the module the one knob `jumpTick` reads, so tests need no real frames. */
  state.frameScheduler = (callback) => queueMicrotask(callback)

  const module = { }
  const windowForModule = windowStub
  const { body } = factoryBody(source)
  const factory = new Function(
    'window',
    'document',
    'React',
    'Node',
    'NodeFilter',
    'require',
    `return async function probe(require) {\n${body}\n}`,
  )
  const probe = factory(windowForModule, documentStub, ReactStub, { TEXT_NODE: 3, ELEMENT_NODE: 1, DOCUMENT_POSITION_FOLLOWING: 4 }, { SHOW_TEXT: 4 }, requireStub)
  const api = await probe(requireStub)
  api.runtime.frameScheduler = state.frameScheduler
  module.api = api

  const harness = {
    api,
    state,
    document: documentStub,
    /** Put one text node in the transcript the plugin can find, and return it. */
    mountText(value) {
      const { textNode } = makeText(value)
      state.texts.push(textNode)
      return textNode
    },
    /** Point the runtime's `sessions` at the fixture service (or at nothing). */
    installSessions(mode) {
      state.sessions = mode
      api.runtime.sessions = mode === 'service' ? sessionsService : null
    },
    /** Let the module's own asynchronous work advance, then settle. */
    async settle(turns = 400) {
      for (let i = 0; i < turns; i += 1) await null
    },
    async waitForJump(limit = 20000) {
      for (let i = 0; i < limit; i += 1) {
        const jump = api.store.jump
        if (jump === null || jump.phase === 'failed') return jump
        await null
      }
      throw new Error('the jump did not settle within the polling limit')
    },
    session,
    binding,
  }
  harness.installSessions('service')
  // `store.sessionId` is what a jump addresses; the panel/chip set it through
  // `bindSession` when they mount, so the harness points it at the fixture
  // session the same way instead of calling the network-facing refresh path.
  api.store.sessionId = 'session-fixture'
  return harness
}

/** The annotation every test jumps from, with its recorded occurrence. */
function wantedQuote(quote) {
  return { id: 'a1', quote, ordinal: 0 }
}

/* ------------------------------------------- F1: the host is actually asked */

test('shipping bytes: an unmounted quote makes the host load older history, then lands', async () => {
  const env = await environment()
  env.state.appendsQuote = true
  assert.equal(env.state.texts.length, 0, 'the quote starts outside the loaded window')

  await env.api.executeJump(wantedQuote(env.state.quoteText), env.api.store.jumpGen)

  assert.equal(env.api.store.jump, null, 'a successful jump leaves no state behind')
  assert.ok(env.state.hostLoads >= 1, `the host loadOlder must be called, saw ${env.state.hostLoads}`)
  assert.equal(env.state.hostLoads, env.state.appended, 'one host page per landed append')
  assert.ok(env.api.store.ranges.a1 !== undefined, 'the range is retained for the landed quote')
  assert.equal(env.api.store.ranges.a1.startContainer.isConnected, true)
  assert.ok(env.state.scrolls >= 1, 'landing must scroll the view')
})

test('shipping bytes: the panel button (jumpTo) does the same through the real wiring', async () => {
  const env = await environment()
  env.state.appendsQuote = true

  env.api.jumpTo(wantedQuote(env.state.quoteText))
  assert.equal(env.api.store.jump.phase, 'locating', 'the button shows a busy state immediately')

  const settled = await env.waitForJump()
  assert.equal(settled, null, 'the button-driven jump lands')
  assert.ok(env.state.hostLoads >= 1, `the button must reach the host, saw ${env.state.hostLoads}`)
  assert.equal(env.api.store.ranges.a1.startContainer.parentElement.text.nodeValue, env.state.quoteText)
  assert.equal(env.api.store.toast, null, 'a successful jump shows no toast')
})

test('shipping bytes: the loadOlder collaborator is a host call, never a bare identifier', async () => {
  const env = await environment()
  const deps = env.api.jumpDeps(env.api.store.jumpGen, wantedQuote(env.state.quoteText))
  assert.equal(typeof deps.loadOlder, 'function')
  // The blocker was `return act('loadOlder')`: calling it threw ReferenceError.
  await deps.loadOlder()
  assert.equal(env.state.hostLoads, 1, 'one call reaches the host session face')
  assert.equal(env.state.pages, 1, 'the host session counted that page')
})

test('shipping bytes: a host that returns nothing ends in failed:stalled, with the budget recorded', async () => {
  const env = await environment()
  env.state.appendsQuote = false

  const jump = await (async () => {
    env.api.jumpTo(wantedQuote(env.state.quoteText))
    return env.waitForJump()
  })()

  assert.equal(jump.phase, 'failed')
  assert.equal(jump.reason, 'stalled', 'three silent pages in a row is the stalled reason')
  assert.equal(jump.pages, env.api.core.JUMP_MAX_STALLS, 'the redial count is on the state, not guessed')
  assert.equal(env.state.hostLoads, env.api.core.JUMP_MAX_STALLS, 'the host was asked exactly that many times')
  assert.equal(env.api.store.toast.message, 'panel.jump.failed.stalled', 'the failure is reported through its persistent label')
})

test('shipping bytes: an advancing window that never contains the quote stops at the page budget', async () => {
  const env = await environment()
  env.state.appendsQuote = false
  env.state.budgetPages = 1e9
  env.state.hasMore = true
  // Every page really does land and advance the window — just not the quote —
  // so the stall counter never fires and the page budget is the only ceiling.
  env.session.loadOlder = async () => {
    env.state.hostLoads += 1
    env.state.pages += 1
    env.state.revisions += 1
    if (env.state.pages >= env.state.budgetPages) env.state.hasMore = false
  }

  await env.api.executeJump(wantedQuote(env.state.quoteText), env.api.store.jumpGen)

  assert.equal(env.api.store.jump.phase, 'failed')
  assert.equal(env.api.store.jump.reason, 'budget')
  assert.equal(env.api.store.jump.pages, env.api.core.JUMP_MAX_PAGES)
  assert.equal(env.state.hostLoads, env.api.core.JUMP_MAX_PAGES)
})

/* ------------------------------- F3: a mounted quote needs no host at all */

test('shipping bytes: no session service still jumps a mounted quote (0.9.0 behaviour kept)', async () => {
  const env = await environment()
  env.installSessions('missing')
  assert.equal(env.api.sessionLookup().ok, false, 'the session face really is unavailable')
  env.mountText(env.state.quoteText)

  await env.api.executeJump(wantedQuote(env.state.quoteText), env.api.store.jumpGen)

  assert.equal(env.api.store.jump, null, 'a mounted quote lands without any host session')
  assert.equal(env.state.hostLoads, 0, 'nothing to load, and no service to ask')
  assert.equal(env.state.binds, 0, 'the host face is never even bound')
  assert.ok(env.state.scrolls >= 1, 'the view still moves to the quote')
  assert.equal(env.api.store.ranges.a1.startContainer.isConnected, true)
})

test('shipping bytes: no session service plus an unmounted quote is the honest no-session failure', async () => {
  const env = await environment()
  env.installSessions('missing')

  env.api.jumpTo(wantedQuote(env.state.quoteText))
  const jump = await env.waitForJump()

  assert.equal(jump.phase, 'failed')
  assert.equal(jump.reason, 'no-session')
  assert.equal(env.state.hostLoads, 0, 'there is no host face to page')
  assert.equal(env.api.store.toast.message, 'panel.jump.failed.noSession', 'the reason reaches the user as its own label')
})

/* --------------------------------------- the in-flight trap, on the wiring */

test('shipping bytes: a busy window is waited on, never re-requested', async () => {
  const env = await environment()
  env.state.appendsQuote = false
  env.state.loadingOlder = true
  // The host never clears the busy flag in this fixture, and its revision never moves.

  await env.api.executeJump(wantedQuote(env.state.quoteText), env.api.store.jumpGen)

  assert.equal(env.state.hostLoads, 0, 'loadOlder must not be called while the host reports a page in flight')
  assert.equal(env.api.store.jump.phase, 'failed')
  assert.equal(env.api.store.jump.reason, 'stalled', 'the wait budget ends the wait')
  assert.equal(env.api.store.jump.pages, 0, 'waiting spends no page budget')
})

/* --------------------------------------------------- F6: reveal is bounded */

test('shipping bytes: a zero-box match is revealed once and reported folded', async () => {
  const env = await environment()
  // The shipping `locate()` returns the SAME Range while its node is connected
  // (it is retained in `store.ranges`), so one reveal is the whole story.
  const range = env.document.createRange()
  range.setStart(env.mountText(env.state.quoteText))
  range.getBoundingClientRect = () => ({ width: 0, height: 0 })
  const deps = env.api.jumpDeps(env.api.store.jumpGen, wantedQuote(env.state.quoteText))
  deps.locate = () => range
  deps.visible = () => false
  let reveals = 0
  deps.reveal = () => {
    reveals += 1
  }

  const outcome = await env.api.core.runJump(deps)

  assert.equal(outcome.action, 'fail')
  assert.equal(outcome.reason, 'folded')
  assert.equal(reveals, 1, 'one reveal for one stable match')
})

test('shipping bytes: a pathological locate cannot make the reveal phase unbounded', async () => {
  const env = await environment()
  // The case with no natural end: every step produces a NEW zero-box match, so
  // `revealed` is re-earned each round. Without a reveal budget this loop never
  // terminates; with it, the run ends in `folded` after a bounded number of
  // frames. Each fresh match is mounted only so the frame stays finite.
  const deps = env.api.jumpDeps(env.api.store.jumpGen, wantedQuote(env.state.quoteText))
  let locates = 0
  let reveals = 0
  deps.locate = () => {
    locates += 1
    assert.ok(locates < 50, 'the reveal phase must end long before 50 matches')
    const range = env.document.createRange()
    range.setStart(env.mountText(env.state.quoteText))
    range.getBoundingClientRect = () => ({ width: 0, height: 0 })
    return range
  }
  deps.visible = () => false
  deps.reveal = () => {
    reveals += 1
  }

  const outcome = await env.api.core.runJump(deps)

  assert.equal(outcome.action, 'fail')
  assert.equal(outcome.reason, 'folded')
  // Two reveals and a third attempt that trips the budget: the run is bounded
  // by the counter, not by the DOM standing still.
  assert.equal(reveals, env.api.core.JUMP_REVEAL_TRIES, 'the reveal budget is what ends it')
  assert.equal(outcome.pages, 0, 'revealing spends no page budget')
})

/* ---------------------------------------- no undeclared identifier, statically */

/**
 * Every identifier the shipping factory body READS must be declared in the body,
 * a parameter of some function in it, or a known platform global.
 *
 * F1 was a bare `act('loadOlder')` that nothing declared. The bytes tests above
 * catch that path by running it; this scan covers the rest of the body — the
 * paths a fixture never reaches — so the same class cannot come back through a
 * branch nobody drives. Only compound reads (calls, member bases, etc.) are
 * judged, which keeps the scan free of statement-keyword noise, and the scan
 * plants a bare call first to prove it still reports one.
 */
const PLATFORM_GLOBALS = new Set([
  'window', 'document', 'console', 'globalThis', 'navigator', 'location',
  'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'queueMicrotask',
  'fetch', 'Promise', 'Object', 'Array', 'String', 'Number', 'Boolean', 'Math',
  'JSON', 'Date', 'RegExp', 'Error', 'TypeError', 'Map', 'Set', 'WeakMap', 'WeakSet',
  'Symbol', 'Proxy', 'Reflect', 'Intl', 'Function', 'Infinity', 'NaN', 'undefined',
  'isNaN', 'isFinite', 'parseInt', 'parseFloat', 'URL', 'URLSearchParams',
  'TextEncoder', 'TextDecoder', 'AbortController', 'requestAnimationFrame',
  'cancelAnimationFrame', 'Node', 'NodeFilter', 'Highlight', 'CSS', 'Event',
  'MutationObserver', 'ResizeObserver', 'getComputedStyle', 'localStorage',
  'sessionStorage', 'process', 'structuredClone', 'require', 'arguments',
  // Keywords and accessor headers can look like compound reads to a regex scan.
  'catch', 'constructor', 'else', 'for', 'get', 'if', 'return', 'set', 'super',
  'switch', 'this', 'throw', 'typeof', 'while', 'yield',
])

/**
 * Strip what can never be a read or a declaration: comments, literals, and the
 * two forms that only LOOK like a call — a method definition's name and an
 * object accessor's name (`get lastRevision() {`).
 */
function strippedCode(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ')
    .replace(/\{[^;{}]*\}\s*=>/g, ' ARROW ')
    .replace(/(?:^|[\s;{}])(?:get|set)\s+([A-Za-z_$][\w$]*)\s*\(/g, ' ACCESSOR $1 ')
    .replace(/(?:^|\n)\s*(?:static\s+)?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/g, ' METHOD ')
    .replace(/'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g, ' LITERAL ')
}

/** Names declared by `var`/`let`/`const`, function/class names, catch bindings. */
function declaredNames(code) {
  const names = new Set()
  const patterns = [
    /\b(?:var|let|const)\s+([A-Za-z_$][\w$]*)/g,
    /\bfunction\s*\*?\s*([A-Za-z_$][\w$]*)/g,
    /\bclass\s+([A-Za-z_$][\w$]*)/g,
    /\bcatch\s*\(\s*([A-Za-z_$][\w$]*)/g,
  ]
  for (const pattern of patterns) for (const match of code.matchAll(pattern)) names.add(match[1])
  // Destructuring targets: `var { a, b: c } = …` / `var [d, e] = …`.
  for (const match of code.matchAll(/\b(?:var|let|const)\s*[\[{]([^\]}]*)[\]}]/g)) {
    for (const part of match[1].split(',')) {
      const name = part.split(':').pop().split('=')[0].trim()
      if (/^[A-Za-z_$][\w$]*$/.test(name)) names.add(name)
    }
  }
  return names
}

/** Every parameter name of every function/arrow in the body (shallow, sufficient here). */
function parameterNames(code) {
  const names = new Set()
  const signatures = [/\bfunction\s*\*?\s*[\w$]*\s*\(([^)]*)\)/g, /\(([^)]*)\)\s*=>/g, /([A-Za-z_$][\w$]*)\s*=>/g]
  for (const pattern of signatures) {
    for (const match of code.matchAll(pattern)) {
      for (const part of match[1].split(',')) {
        const name = part.split('=')[0].trim().replace(/^\.\.\./, '')
        if (/^[A-Za-z_$][\w$]*$/.test(name)) names.add(name)
        else {
          const inner = name.replace(/^[\[{]|[\]}]$/g, '')
          for (const nested of inner.split(',')) {
            const leaf = nested.split(':').pop().split('=')[0].trim()
            if (/^[A-Za-z_$][\w$]*$/.test(leaf)) names.add(leaf)
          }
        }
      }
    }
  }
  return names
}

/** Identifiers read in compound position: call bases, member bases, tag names. */
function compoundReads(code) {
  const reads = new Set()
  const key = 'key'
  const patterns = [
    /(?<![.\w$])([A-Za-z_$][\w$]*)\s*\(/g,
    /(?<![.\w$])([A-Za-z_$][\w$]*)\s*\./g,
    /(?<![.\w$])([A-Za-z_$][\w$]*)\s*\[/g,
    /(?<![.\w$])([A-Za-z_$][\w$]*)\s*(?:[+\-*/%<>!&|^]==?|===|!==)/g,
  ]
  for (const pattern of patterns) for (const match of code.matchAll(pattern)) reads.add(match[key === 'key' ? 1 : 1])
  return reads
}

function undeclaredIn(body) {
  const code = strippedCode(body)
  const declared = declaredNames(code)
  for (const name of parameterNames(code)) declared.add(name)
  return [...compoundReads(code)].filter((name) => !declared.has(name) && !PLATFORM_GLOBALS.has(name)).sort()
}

test('the scan itself reports a planted undeclared call', () => {
  const planted = `${factoryBody(source).body}\n    var sink = totallyUndeclaredProbe()\n`
  assert.ok(undeclaredIn(planted).includes('totallyUndeclaredProbe'), 'the scan must see a planted bare call')
})

test('the shipping factory body references no undeclared identifier', () => {
  const undeclared = undeclaredIn(factoryBody(source).body)
  assert.deepEqual(
    undeclared,
    [],
    `the shipping factory body reads undeclared identifiers: ${undeclared.join(', ')} — this is the class of bug F1 was`,
  )
})

/* --------------------------------------------------------------- hygiene */

test('the probe never reaches the host plugin API or the real store', async () => {
  const env = await environment()
  assert.equal(typeof env.api.apply, 'function')
  // The jump helpers are driven directly, so the plugin's HTTP route is never
  // called: no request, and therefore no store read or write from this suite.
  let fetches = 0
  const realFetch = globalThis.fetch
  globalThis.fetch = () => {
    fetches += 1
    return Promise.reject(new Error('unexpected request'))
  }
  try {
    await env.api.executeJump(wantedQuote(env.state.quoteText), env.api.store.jumpGen)
    assert.equal(fetches, 0, 'a jump must not call the plugin API')
  } finally {
    globalThis.fetch = realFetch
  }
})
