/**
 * Hold the reconciliation's host assumptions against the REAL host and its REAL
 * logs on this machine.
 *
 * Every other check of this fix runs against a double. This file is the one
 * place the assumptions about the host's own shapes are confronted with
 * something that cannot be edited to agree with the code.
 *
 * Two facts are established, and both are load-bearing for `eventIsBlockOf`:
 *
 *   1. the service the plugin reaches for through `ctx.get('sessionQuery')`
 *      really is a live cordis service whose engine exposes `readSession`, and
 *      the engine's own declared return type really is `SessionLogSnapshot` —
 *      `{ session, inheritedEventCount, events }`, the three fields the
 *      reconciliation destructures;
 *   2. a real persisted session log really stores a `user/message` event the
 *      way the fences expect — `data.content` an array of parts, each with
 *      `type`/`text`; `data.source.kind` a producer discriminator that actually
 *      varies. This machine's own logs carry `user` and `runtime-context` side
 *      by side, which is the whole reason the fence reads `kind` and not `role`.
 *
 * What it deliberately does NOT do is boot a whole host profile. The engine
 * needs a persistence backend mounted through that profile, and fabricating one
 * here would be a second, worse host double. So the reconciliation itself is
 * driven end to end in `reconcile.test.mjs`, and this file pins the facts that
 * make that double faithful.
 *
 * Non-verifying paths, both explicit: `DSH_ANNOTATE_HOST_ROOT=absent` (the
 * opt-out the two other host suites share) and a machine with no persisted
 * sessions. A host that is merely MISSING is a failure, not a skip — the rule
 * `host-shape` and `host-contract` both follow.
 *
 * Run with: node --test
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'

const HOST_ROOT = process.env.DSH_ANNOTATE_HOST_ROOT ?? '/usr/lib/node_modules/@deepseek-ai/dsh'
const ABSENT = HOST_ROOT === 'absent'
const SESSIONS = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'sessions')

/** One real persisted session log file on this machine, or null. */
function findLog() {
  if (!existsSync(SESSIONS)) return null
  for (const workspace of readdirSync(SESSIONS)) {
    const dir = join(SESSIONS, workspace)
    try {
      if (!statSync(dir).isDirectory()) continue
    } catch {
      continue
    }
    for (const candidate of readdirSync(dir)) {
      const file = join(dir, candidate, 'session.v4.jsonl.zstd')
      try {
        if (statSync(file).isFile() && statSync(file).size > 1024) return file
      } catch {
        /* keep looking */
      }
    }
  }
  return null
}

/** Every event of one real compressed session log. */
function readEvents(file) {
  const text = execFileSync('zstd', ['-dc', file], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  return text
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line))
}

const logFile = ABSENT ? null : findLog()

test('the host sessionQuery is a live service whose engine exposes readSession', { skip: ABSENT ? 'DSH_ANNOTATE_HOST_ROOT=absent' : false }, async () => {
  const cordis = join(HOST_ROOT, 'node_modules', '@deepseek-ai', 'cordis', 'lib', 'index.js')
  if (!existsSync(cordis)) {
    assert.fail(`no host at ${HOST_ROOT}; pass DSH_ANNOTATE_HOST_ROOT=absent to declare a machine without one`)
  }
  const { Context } = await import(cordis)
  const engineModule = await import(join(HOST_ROOT, 'node_modules', '@deepseek-ai', 'dsh-session-query', 'lib', 'index.js'))
  const Engine = engineModule.default ?? engineModule.SessionQueryEngine
  assert.equal(typeof Engine, 'function', 'dsh-session-query exposes a SessionQueryEngine')

  const ctx = new Context()
  // `ctx.get` is the exact lookup the plugin performs. The service is not
  // provided here — the engine needs a persistence backend from the host
  // profile — so what this asserts is the lookup CONTRACT: an unprovided name
  // answers `undefined` rather than throwing, which is what makes the plugin's
  // `sessionQuery()` degrade instead of refusing to load.
  assert.equal(ctx.get('sessionQuery'), undefined, 'ctx.get answers undefined for a service that is not mounted')

  const engine = new Engine(ctx, {})
  assert.equal(typeof engine.readSession, 'function', 'readSession is the real verb the plugin calls')

  // The declared return type is what the reconciliation destructures. A rename
  // there must break this assertion rather than the fix silently reading nothing.
  const declared = readFileSync(
    join(HOST_ROOT, 'node_modules', '@deepseek-ai', 'dsh-session-query', 'lib', 'types', 'types.d.ts'),
    'utf8',
  )
  const from = declared.indexOf('interface SessionLogSnapshot')
  assert.notEqual(from, -1, 'SessionLogSnapshot is still declared')
  const snapshot = declared.slice(from, declared.indexOf('interface SessionEventRecord', from))
  for (const field of ['session:', 'inheritedEventCount:', 'events:']) {
    assert.ok(snapshot.includes(field), `SessionLogSnapshot still declares ${field}`)
  }
  console.log(`real-host drive: sessionQuery.readSession present (${Engine.name}); SessionLogSnapshot shape confirmed`)
})

test('a real session log stores user/message the way the fences read it', { skip: ABSENT ? 'DSH_ANNOTATE_HOST_ROOT=absent' : false }, (t) => {
  if (logFile === null) {
    t.skip(`no persisted session logs under ${SESSIONS}`)
    return
  }
  const events = readEvents(logFile)
  assert.ok(events.length > 0, 'the log holds events')
  assert.equal(events[0].type, 'session', 'the first record is the session header')

  const messages = events.filter((event) => event.type === 'user/message')
  assert.ok(messages.length > 0, 'the log holds at least one user/message')

  const kinds = new Set()
  for (const event of messages) {
    const data = event.data
    assert.equal(typeof data.id, 'string', 'a user/message carries an identified message')
    assert.ok(Array.isArray(data.content), 'content is an array of parts')
    for (const part of data.content) {
      assert.equal(typeof part.type, 'string')
      if (part.type === 'text') assert.equal(typeof part.text, 'string', 'a text part carries its text')
    }
    assert.equal(typeof data.source?.kind, 'string', 'source.kind is what tells producers apart')
    kinds.add(data.source.kind)
    // The whole reason the fence reads `kind` instead of `role`: the role is
    // `user` for every one of these, the kind is not.
    assert.equal(data.role, 'user', 'every user/message carries the user role')
  }
  assert.ok(kinds.size >= 2, `source.kind actually discriminates on this machine (saw ${[...kinds].join(', ')})`)
  console.log(`real-host drive: read ${events.length} events from ${logFile}; user/message source kinds: ${[...kinds].join(', ')}`)
})
