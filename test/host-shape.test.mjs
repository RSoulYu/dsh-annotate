/**
 * Host-shape assertions — the mechanical fence against the environment this
 * feature is built on.
 *
 * Every entry below is copied verbatim from the frozen list of the design freeze
 * (`jump-design.md` §5.1, machine-readable copy `host-shape.json`). Nothing is
 * skipped, relaxed or reworded: if the host changes the shape of the public
 * session face the jump calls, this suite must fail loudly rather than stay
 * green against a memory of what the host used to look like.
 *
 * Root rule (frozen):
 *
 *   root = process.env.DSH_ANNOTATE_HOST_ROOT ?? '/usr/lib/node_modules/@deepseek-ai/dsh'
 *
 * - root or any asserted file missing -> FAILURE. A missing host is never a
 *   silent pass; the failure names the variable and the escape hatch.
 * - the ONLY non-verifying path is an explicit DSH_ANNOTATE_HOST_ROOT=absent,
 *   for an environment that provably has no DSH (a CI runner). It prints
 *   `host shape check: skipped by DSH_ANNOTATE_HOST_ROOT=absent` and must never
 *   be quoted as a verification.
 *
 * Run with: node --test
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

/** The host root the design froze, and the variable that overrides it. */
const HOST_ROOT_DEFAULT = '/usr/lib/node_modules/@deepseek-ai/dsh'
const HOST_ROOT_ENV = 'DSH_ANNOTATE_HOST_ROOT'
/** The one explicit opt-out value, for a machine that provably has no host. */
const HOST_ROOT_ABSENT = 'absent'

/** Emitted verbatim into the local output and the CI log; never a silent skip. */
const SKIP_LINE = 'host shape check: skipped by DSH_ANNOTATE_HOST_ROOT=absent'

/**
 * The frozen assertion list (22 entries), copied verbatim.
 *
 * `kind` is `contains` (a substring of the file) or `count` (an exact number of
 * occurrences). Every entry is required.
 */
const ASSERTIONS = [
  {
    id: 'H1',
    file: 'node_modules/@deepseek-ai/dsh-cordis-client-runner/lib/client.js',
    kind: 'contains',
    value: 'key: "sessions",',
    why: 'the client API catalogue (cordis_inspect SERVICE_API) lists ctx.sessions as a public client service',
  },
  {
    id: 'H2',
    file: 'node_modules/@deepseek-ai/dsh-cordis-client-runner/lib/client.js',
    kind: 'contains',
    value: 'The sessions-service face injected as',
    why: "the catalogue entry's summary, so a renamed key cannot keep matching",
  },
  {
    id: 'H3',
    file: 'node_modules/@deepseek-ai/dsh-api-session-controller/lib/types/client/contract/sessions.d.ts',
    kind: 'contains',
    value: 'binding(id: SessionId): SessionBinding | undefined;',
    why: 'signature of ctx.sessions.binding',
  },
  {
    id: 'H4',
    file: 'node_modules/@deepseek-ai/dsh-api-session-controller/lib/types/client/sessions/service.d.ts',
    kind: 'contains',
    value: 'readonly session: SessionFace;',
    why: 'SessionBinding.session is the face carrying loadOlder',
  },
  {
    id: 'H5',
    file: 'node_modules/@deepseek-ai/dsh-api-session-controller/lib/types/client/sessions/service.d.ts',
    kind: 'contains',
    value: 'readonly eventSource: SessionEventSource;',
    why: 'the only public progress signal (window revision)',
  },
  {
    id: 'H6',
    file: 'node_modules/@deepseek-ai/dsh-api-session-controller/lib/types/client/contract/session.d.ts',
    kind: 'contains',
    value: 'loadOlder(): Promise<void>;',
    why: 'the verb route A calls',
  },
  {
    id: 'H7',
    file: 'node_modules/@deepseek-ai/dsh-api-session-controller/lib/types/client/contract/snapshot.d.ts',
    kind: 'contains',
    value: 'readonly hasMore: boolean;',
    why: 'input of the absent/budget decisions',
  },
  {
    id: 'H8',
    file: 'node_modules/@deepseek-ai/dsh-api-session-controller/lib/types/client/contract/snapshot.d.ts',
    kind: 'contains',
    value: 'readonly loadingOlder: boolean;',
    why: 'input of the in-flight guard',
  },
  {
    id: 'H9',
    file: 'node_modules/@deepseek-ai/dsh-api-session-controller/lib/types/client/contract/snapshot.d.ts',
    kind: 'contains',
    value: 'readonly openState: OpenState;',
    why: 'input of the no-session decision',
  },
  {
    id: 'H10',
    file: 'node_modules/@deepseek-ai/dsh-api-session-controller/lib/client.js',
    kind: 'contains',
    value: 'if (this.openState !== "open" || !this.hasMore || this.loadingOlder) return;',
    why: 'loadOlder is a silent no-op in those three states: the loop must wait instead of re-requesting',
  },
  {
    id: 'H11',
    file: 'node_modules/@deepseek-ai/dsh-api-session-controller/lib/types/client/contract/events.d.ts',
    kind: 'contains',
    value: 'readonly revision: number;',
    why: 'the progress field read off the event window',
  },
  {
    id: 'H12',
    file: 'node_modules/@deepseek-ai/dsh-client-ui-chat/lib/client.js',
    kind: 'contains',
    value: 'const binding = ctx.sessions.binding(sessionId);',
    why: "the host's own view resolves the session face the same way",
  },
  {
    id: 'H13',
    file: 'node_modules/@deepseek-ai/dsh-client-ui-chat/lib/client.js',
    kind: 'contains',
    value: 'session.loadOlder();',
    why: "the host's own Load-earlier button call",
  },
  {
    id: 'H14',
    file: 'node_modules/@deepseek-ai/dsh-client-ui-chat/lib/client.js',
    kind: 'contains',
    value: 'const rows = entries.map((entry) => {',
    why: 'the transcript renders every loaded entry, so loaded history reaches the DOM',
  },
  {
    id: 'H15',
    file: 'node_modules/@deepseek-ai/dsh-client-ui-chat/lib/client.js',
    kind: 'count',
    value: 'IntersectionObserver',
    count: 0,
    why: 'no viewport-driven rendering/unmounting in the transcript',
  },
  {
    id: 'H16',
    file: 'node_modules/@deepseek-ai/dsh-client-ui-chat/lib/client.js',
    kind: 'count',
    value: '= useVirtualizer({',
    count: 1,
    why: 'exactly one virtualizer call site exists in the chat bundle',
  },
  {
    id: 'H17',
    file: 'node_modules/@deepseek-ai/dsh-client-ui-chat/lib/client.js',
    kind: 'contains',
    value: 'const virtualizer = useVirtualizer({',
    why: 'that call site is named',
  },
  {
    id: 'H18',
    file: 'node_modules/@deepseek-ai/dsh-client-ui-chat/lib/client.js',
    kind: 'contains',
    value: 'items[index]?.turn ?? index',
    why: 'the one virtualizer keys by turn, i.e. it is the turn rail, not the message list',
  },
  {
    id: 'H19',
    file: 'node_modules/@deepseek-ai/dsh-client-ui-chat/lib/client.js',
    kind: 'count',
    value: 'viewRequest',
    count: 0,
    why: 'the chat View ignores focus requests, so openView(view, focus) cannot address a message',
  },
  {
    id: 'H20',
    file: 'node_modules/@deepseek-ai/dsh-client-ui-conversation/lib/client.js',
    kind: 'contains',
    value: '"data-conversation-scroll": ""',
    why: 'the conversation is one scrollport handed to the transcript',
  },
  {
    id: 'H21',
    file: 'node_modules/@deepseek-ai/dsh-cordis-client-runner/lib/client.js',
    kind: 'contains',
    value: '"sessionId: SessionId"',
    why: "the sidebar.right.pane.tab slot's standard props carry the session identity the jump addresses",
  },
  {
    id: 'H22',
    file: 'node_modules/@deepseek-ai/dsh-client-ui-chat/lib/client.js',
    kind: 'contains',
    value: 'element.setAttribute("hidden", "until-found");',
    why: 'collapsed blocks use the platform hidden=until-found, which keeps text in the DOM',
  },
  /**
   * H23 is an ADDITION to the frozen list, not an edit of it (ruling 7 / F5):
   * H21's substring occurs 43 times in the runner bundle, because every slot's
   * `standardProps` lists it, so H21 alone stays green even if this one slot
   * loses `sessionId`. H23 pins the assertion to the `sidebar.right.pane.tab`
   * entry itself: the anchor is that slot's own `key:` line, and the window ends
   * at the entry's next closing line.
   */
  {
    id: 'H23',
    file: 'node_modules/@deepseek-ai/dsh-cordis-client-runner/lib/client.js',
    kind: 'block',
    anchor: 'key: "sidebar.right.pane.tab",',
    value: '"sessionId: SessionId"',
    count: 1,
    why: "the sidebar.right.pane.tab slot's standard props carry the session identity the jump addresses (anchored to the one slot, so a shape change is caught)",
  },
]


/**
 * The lines of one slot catalogue entry, from its own `key:` line to the end of
 * that entry.
 *
 * `anchor` is that slot's unique key line, so the window cannot drift onto a
 * neighbouring entry. `end` is the first following line that closes the entry;
 * `count` then applies inside the window only.
 */
function blockWindow(text, anchor, end = '\n\t\t\t{') {
  const from = text.indexOf(anchor)
  if (from === -1) return null
  const rest = text.slice(from)
  const match = new RegExp(end).exec(rest)
  // +1 keeps the newline out of the window; `end` names the line where the
  // NEXT entry opens, so nested closers inside this entry cannot end it early.
  const length = match === null ? rest.length : match.index + 1
  return { text: text.slice(from, from + length), length }
}

/** How many occurrences of `needle` the file holds (no regular expressions). */
function occurrences(text, needle) {
  let count = 0
  let at = text.indexOf(needle)
  while (at !== -1) {
    count += 1
    at = text.indexOf(needle, at + needle.length)
  }
  return count
}

/** The root to check, or the explicit opt-out. */
const root = process.env[HOST_ROOT_ENV] ?? HOST_ROOT_DEFAULT
const optedOut = root === HOST_ROOT_ABSENT

if (optedOut) {
  test('host shape check', () => {
    console.log(SKIP_LINE)
  })
} else if (!existsSync(root)) {
  test('host shape check', () => {
    assert.fail(
      `host root not found: ${root}\n` +
        `  ${HOST_ROOT_ENV} is "${process.env[HOST_ROOT_ENV] ?? '(unset)'}"\n` +
        `  fix: point ${HOST_ROOT_ENV} at the DSH install, or set ${HOST_ROOT_ENV}=absent in an\n` +
        '  environment that provably has no DSH (the explicit opt-out prints a skip line\n' +
        '  and must never be quoted as a verification).',
    )
  })
} else {
  test('host shape: every asserted file exists and carries the frozen shape', async () => {
    const texts = new Map()
    for (const assertion of ASSERTIONS) {
      const path = join(root, assertion.file)
      if (!existsSync(path)) {
        assert.fail(
          `${assertion.id} FAIL missing file ${assertion.file} under ${root}\n` +
            `  why this assertion exists: ${assertion.why}\n` +
            '  do not remove the assertion: re-read the host, decide whether its behaviour changed,\n' +
            '  and if it did, change the design contract first.',
        )
      }
      if (!texts.has(assertion.file)) texts.set(assertion.file, await readFile(path, 'utf8'))
      const text = texts.get(assertion.file)
      if (assertion.kind === 'block') {
        const window = blockWindow(text, assertion.anchor)
        assert.ok(
          window !== null && window.length > 0,
          `${assertion.id} FAIL ${assertion.file} does not contain the anchor ${JSON.stringify(assertion.anchor)}\n` +
            `  why this assertion exists: ${assertion.why}\n` +
            '  do not relax the assertion: re-read the host and change the contract first.',
        )
        const count = occurrences(window.text, assertion.value)
        assert.equal(
          count,
          assertion.count,
          `${assertion.id} FAIL ${assertion.file} anchored at ${JSON.stringify(assertion.anchor)} holds ${count}x ${JSON.stringify(assertion.value)}, expected ${assertion.count}\n` +
            `  why this assertion exists: ${assertion.why}\n` +
            '  do not relax the assertion: re-read the host and change the contract first.',
        )
      } else if (assertion.kind === 'contains') {
        assert.ok(
          text.includes(assertion.value),
          `${assertion.id} FAIL ${assertion.file} does not contain ${JSON.stringify(assertion.value)}\n` +
            `  why this assertion exists: ${assertion.why}\n` +
            '  do not relax the assertion: re-read the host and change the contract first.',
        )
      } else if (assertion.kind === 'count') {
        const count = occurrences(text, assertion.value)
        assert.equal(
          count,
          assertion.count,
          `${assertion.id} FAIL ${assertion.file} count(${JSON.stringify(assertion.value)}) === ${count}, expected ${assertion.count}\n` +
            `  why this assertion exists: ${assertion.why}\n` +
            '  do not relax the assertion: re-read the host and change the contract first.',
        )
      } else {
        assert.fail(`${assertion.id} FAIL unknown kind ${assertion.kind}`)
      }
    }
    console.log(`host-shape: verified ${ASSERTIONS.length} assertions at ${root} (22 frozen + H23 anchored)`)
  })

  test('host shape: the list itself is the frozen one, plus the anchored addition', () => {
    // A fence that silently loses entries verifies nothing, so its own size is
    // asserted too: the 22 frozen entries, plus H23 (ruling 7 / F5), which
    // does not replace or reword any of them.
    assert.equal(ASSERTIONS.length, 23)
    assert.equal(new Set(ASSERTIONS.map((entry) => entry.id)).size, 23)
    assert.deepEqual(
      ASSERTIONS.slice(0, 22).map((entry) => entry.id),
      Array.from({ length: 22 }, (_, index) => `H${index + 1}`),
      'the frozen 22 must stay in order and unchanged',
    )
    for (const entry of ASSERTIONS) {
      assert.equal(typeof entry.file, 'string')
      assert.ok(['contains', 'count', 'block'].includes(entry.kind), `${entry.id} kind`)
      assert.ok(typeof entry.why === 'string' && entry.why.length > 0, `${entry.id} must say why it exists`)
      if (entry.kind === 'count' || entry.kind === 'block') assert.equal(typeof entry.count, 'number')
      if (entry.kind === 'block') assert.equal(typeof entry.anchor, 'string')
    }
  })

  test('host shape: H21 alone cannot discriminate, and H23 can', async () => {
    // The reason H23 exists, measured rather than asserted from memory: the
    // runner bundle holds H21's substring many times over, but exactly once
    // inside the sidebar.right.pane.tab entry.
    const file = 'node_modules/@deepseek-ai/dsh-cordis-client-runner/lib/client.js'
    const text = await readFile(join(root, file), 'utf8')
    const total = occurrences(text, '"sessionId: SessionId"')
    assert.ok(total > 1, `H21 is not discriminating when the string occurs ${total} times`)
    const window = blockWindow(text, 'key: "sidebar.right.pane.tab",')
    assert.ok(window !== null, 'the sidebar.right.pane.tab entry must exist')
    assert.equal(occurrences(window.text, '"sessionId: SessionId"'), 1)
  })
}
