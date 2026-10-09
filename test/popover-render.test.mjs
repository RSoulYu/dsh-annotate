/**
 * The render path, driven through the SHIPPING BYTES.
 *
 * Why this file exists: 0.10.0 shipped a crash that no source-only assertion
 * could see. `BadgePopover` called `React.useEffect` after two early
 * `return null`s, so the frame that opened the popover rendered one hook more
 * than the closed one; React answered "Rendered more hooks than during the
 * previous render" (minified error #310), the plugin's own `Boundary` caught
 * it, and the whole overlay was replaced by its crash line the moment a badge
 * was clicked. Every suite in this repository stayed green through it, because
 * none of them ever rendered a component.
 *
 * So this suite renders. It evaluates the whole factory body of `client.js` —
 * everything between `factory(require) {` and the final
 * `return { inject, apply, core }` is the shipping source, byte for byte, and
 * only that one return statement is swapped for a probe return — then mounts
 * the real `Overlay` with the real `react` / `react-dom` the host's browser
 * module table serves (the DSH web profile pins react 18.3.1) inside a real DOM
 * (jsdom), and drives the plugin's own `togglePopover` entry point, which is
 * what a numbered badge calls.
 *
 * The one environment stand-in is `ResizeObserver`: jsdom has none, and the
 * plugin uses it only while wiring its own listeners in `apply()`, which this
 * suite does not call. Nothing about the components is stubbed — the crash and
 * the fix both live in the bytes under test.
 *
 * The second test is a mutation control. It moves the hook back behind the early
 * return in those same bytes and asserts that THIS harness then reports the
 * crash. Without it, a green first test would only prove that React did not
 * complain about whatever the file happens to contain.
 *
 * Dependencies (react@18.3.1, react-dom@18.3.1, jsdom): they are deliberately
 * NOT in package.json — the plugin keeps its zero-dependency manifest and the
 * host profile never receives them. Install them beside the checkout:
 *
 *   npm install --no-save --no-package-lock react@18.3.1 react-dom@18.3.1 jsdom@24
 *
 * A missing dependency FAILS the suite; the only non-verifying path is the
 * explicit `DSH_ANNOTATE_RENDER=absent`, which prints
 * `popover render check: skipped by DSH_ANNOTATE_RENDER=absent` and must never
 * be quoted as a verification.
 *
 * Run with: node --test
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'

const source = await readFile(new URL('../client.js', import.meta.url), 'utf8')

/** The frozen probe return: the only bytes of the factory body this suite replaces. */
const SHIPPING_RETURN = "    return { inject: ['slots', 'locale'], apply: apply, core: coreExports }"
const PROBE_RETURN = [
  '    return {',
  '      apply: apply,',
  '      core: coreExports,',
  '      Overlay: Overlay,',
  '      store: store,',
  '      togglePopover: togglePopover,',
  '    }',
].join('\n')

/** The composition this suite depends on: the overlay must still mount the popover. */
const OVERLAY_MOUNTS_POPOVER = 'h(BadgePopover, null)'

/** The two statements the mutation control moves past each other. */
const EARLY_RETURN_LINE = '      if (popover === null || annotation === null) return null\n'
const HOOK_COMMENT_LINE = '      // Every hook runs before the first early return. Returning first and then\n'

const HOOK_ORDER_MESSAGE = 'Rendered more hooks than during the previous render'
const CRASH_LINE_PREFIX = '批注插件出错：'

/**
 * The shipping factory body with its return statement swapped for the probe.
 *
 * A missing or duplicated marker is a hard failure: a silently empty or
 * mis-sliced body would make every test below vacuous.
 */
function probeBundle(text, label) {
  const first = text.indexOf(SHIPPING_RETURN)
  assert.notEqual(first, -1, `${label}: client.js must still carry the shipping return`)
  const second = text.indexOf(SHIPPING_RETURN, first + 1)
  assert.equal(second, -1, `${label}: the shipping return appears twice, the probe would be ambiguous`)
  return text.slice(0, first) + PROBE_RETURN + text.slice(first + SHIPPING_RETURN.length)
}

/**
 * The pre-fix hook placement, produced from the shipping bytes.
 *
 * This is the mutation the fence exists for: the hook runs only on the frames
 * that got past the early return, so opening the popover renders three hooks
 * where the closed one rendered two.
 */
function hookBehindEarlyReturn(text, label) {
  const earlyReturn = text.indexOf(EARLY_RETURN_LINE)
  assert.notEqual(earlyReturn, -1, `${label}: the early return this control moves is gone`)
  assert.equal(text.indexOf(EARLY_RETURN_LINE, earlyReturn + 1), -1, `${label}: the early return is not unique`)
  const hook = text.indexOf(HOOK_COMMENT_LINE)
  assert.notEqual(hook, -1, `${label}: the hook-order marker comment is gone`)
  assert.ok(hook < earlyReturn, `${label}: the marker comment is not before the early return any more`)
  const withoutReturn = text.slice(0, earlyReturn) + text.slice(earlyReturn + EARLY_RETURN_LINE.length)
  return withoutReturn.slice(0, hook) + EARLY_RETURN_LINE + withoutReturn.slice(hook)
}

const require = createRequire(import.meta.url)
const MODULES = ['react', 'react-dom/client', 'jsdom']

function missingModules() {
  const missing = []
  for (const name of MODULES) {
    try {
      require.resolve(name)
    } catch {
      missing.push(name)
    }
  }
  return missing
}

/**
 * Mount the real Overlay, then click a badge three times.
 *
 * A fresh jsdom per render: React DOM reads the platform globals at call time,
 * and a previous scenario's unmounted window must not leak into this one.
 */
function renderScenario(bundle, label) {
  const { JSDOM } = require('jsdom')
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    pretendToBeVisual: true,
    runScripts: 'outside-only',
    url: 'http://localhost/',
  })
  const win = dom.window

  try {
    for (const key of Object.keys(win)) {
      if (key in globalThis) continue
      try {
        Object.defineProperty(globalThis, key, { value: win[key], configurable: true, writable: true })
      } catch {
        /* read-only platform globals stay as they are */
      }
    }
    for (const key of ['window', 'document', 'navigator', 'Node', 'NodeFilter', 'Element', 'HTMLElement', 'Range', 'Text', 'Event', 'MouseEvent', 'getComputedStyle', 'getSelection', 'requestAnimationFrame', 'cancelAnimationFrame', 'MutationObserver', 'CSS']) {
      try {
        Object.defineProperty(globalThis, key, { value: win[key], configurable: true, writable: true })
      } catch {
        /* ignore */
      }
    }
    if (typeof globalThis.ResizeObserver !== 'function') {
      Object.defineProperty(globalThis, 'ResizeObserver', {
        value: class { observe() {} unobserve() {} disconnect() {} },
        configurable: true,
        writable: true,
      })
    }
    globalThis.IS_REACT_ACT_ENVIRONMENT = true

    // Required only now: react-dom decides it is running in a browser while it
    // is being loaded.
    const React = require('react')
    const ReactDOMClient = require('react-dom/client')
    const act = React.act || require('react-dom/test-utils').act

    let registered = null
    win.__ModuleLoader__ = { load(definition) { registered = definition } }
    win.eval(bundle)
    assert.notEqual(registered, null, `${label}: the bundle did not register itself with the module loader`)
    const mod = registered.factory(function (name) {
      if (name === 'react') return React
      throw new Error(`${label}: the plugin required an unexpected module: ${name}`)
    })

    const { Overlay, store, togglePopover } = mod
    store.annotations = [
      { id: 'a1', quote: 'the quoted text', note: 'a note', number: 1, status: 'pending', createdAt: 1, origin: 'user', sessionId: 's1' },
    ]

    const consoleErrors = []
    const realConsoleError = console.error
    console.error = function (...args) {
      consoleErrors.push(args.map(String).join(' '))
    }

    const container = win.document.getElementById('root')
    const read = () => {
      const crash = container.querySelector('[data-dsa-ui="error"]')
      return {
        crashLine: crash === null ? null : crash.textContent,
        popover: container.querySelector('[data-dsa-ui="popover"]') !== null,
      }
    }
    const item = { annotation: store.annotations[0], left: 100, top: 100 }
    const renders = []
    let thrown = null
    const root = ReactDOMClient.createRoot(container)
    try {
      act(() => { root.render(React.createElement(Overlay)) })
      renders.push({ step: 'mounted, popover closed', ...read() })
      for (let round = 1; round <= 3; round += 1) {
        act(() => { togglePopover(item) })
        renders.push({ step: `badge clicked (round ${round}), popover open`, ...read() })
        act(() => { togglePopover(item) })
        renders.push({ step: `badge clicked again (round ${round}), popover closed`, ...read() })
      }
    } catch (error) {
      thrown = String(error && error.message ? error.message : error)
    } finally {
      console.error = realConsoleError
      try {
        act(() => { root.unmount() })
      } catch {
        /* an unmount after a crash boundary reset is not what this suite reports */
      }
      win.close()
    }
    return { renders, consoleErrors, thrown }
  } finally {
    if (typeof win.close === 'function') win.close()
  }
}

const missing = missingModules()

if (missing.length > 0) {
  if (process.env.DSH_ANNOTATE_RENDER === 'absent') {
    test('popover render check (skipped)', () => {
      console.log('popover render check: skipped by DSH_ANNOTATE_RENDER=absent')
    })
  } else {
    test('the render harness is installed', () => {
      assert.fail(
        `missing ${missing.join(', ')} — the render fence cannot run. Install it with\n` +
        '  npm install --no-save --no-package-lock react@18.3.1 react-dom@18.3.1 jsdom@24\n' +
        'or set DSH_ANNOTATE_RENDER=absent to skip this fence explicitly (a skip is not a verification).',
      )
    })
  }
} else {
  const versions = MODULES.map((name) => `${name.replace('/client', '')} ${require(`${name.replace('/client', '')}/package.json`).version}`).join(' / ')
  console.log(`popover render check: verified with ${versions}`)

  test('clicking a badge renders the note popover instead of crashing the overlay', () => {
    assert.ok(source.includes(OVERLAY_MOUNTS_POPOVER), 'the overlay must still mount BadgePopover, or this fence tests nothing')

    const result = renderScenario(probeBundle(source, 'shipping bytes'), 'shipping bytes')

    assert.equal(result.thrown, null, `mounting the overlay threw: ${result.thrown}`)
    for (const step of result.renders) {
      assert.equal(step.crashLine, null, `${step.step}: the boundary caught "${step.crashLine}"`)
    }
    assert.ok(result.renders[1].popover, 'the open frame must render the popover surface')
    assert.equal(result.renders[2].popover, false, 'the closed frame must render no popover surface')
    assert.ok(result.renders[5].popover, 'reopening after a close must render the popover surface again')
    assert.deepEqual(
      result.consoleErrors.filter((line) => line.includes('change in the order of Hooks') || line.includes('overlay crashed')),
      [],
      'a render must not change the number of hooks or reach the crash boundary',
    )
  })

  test('the fence is not vacuous: the pre-fix hook placement still crashes this harness', () => {
    const mutated = probeBundle(hookBehindEarlyReturn(source, 'shipping bytes'), 'mutated bytes')
    const result = renderScenario(mutated, 'pre-fix hook placement')
    const opened = result.renders[1]

    assert.ok(
      opened.crashLine !== null && opened.crashLine.startsWith(CRASH_LINE_PREFIX),
      `the mutation must reproduce the 0.10.0 crash line, got ${JSON.stringify(opened.crashLine)}`,
    )
    assert.ok(
      opened.crashLine.includes(HOOK_ORDER_MESSAGE),
      `the crash line must name the hook-order error, got ${JSON.stringify(opened.crashLine)}`,
    )
    assert.equal(opened.popover, false, 'the crashed frame renders no popover')
    assert.ok(
      result.consoleErrors.some((line) => line.includes('change in the order of Hooks')),
      'React must report the hook-order change the mutation reintroduces',
    )
  })
}
