/**
 * dsh-annotate — Host half.
 *
 * The browser half collects annotations (selected quote + optional note) and
 * posts them here. This half:
 *
 *   1. persists them under `$DSH_HOME/annotations/annotations.json`
 *      (outside every workspace, shared by every session),
 *   2. serves the small JSON API the browser half talks to
 *      (`POST /plugins/dsh-annotate/api`),
 *   3. registers the `annotation` tool so the agent can read and resolve them
 *      on its own, and
 *   4. delivers them at `agent/pre-step`: the annotation block is put on the
 *      wire as its own message, right after the user's input entering the step,
 *      so the model receives it with what the user just sent — no composer DOM,
 *      no draft rewriting. That step must carry input attributed to the user
 *      (see "Which step carries the user's message" below): `agent/pre-step`
 *      fires for EVERY step of a turn, so without that gate an annotation added
 *      while the turn is already running would be consumed by the very next step
 *      of that same turn. The block is a separate `user/message`
 *      whose `source.kind` is not `user`, which is what keeps it out of the
 *      user's own bubble: the chat renders an appended `user/message` as a
 *      bubble only for `source.kind === "user"` and as an injected-context row
 *      otherwise (`@deepseek-ai/dsh-client-ui-chat`, `messageDefinition` →
 *      `contextMessage`). It is still a logged, model-visible message.
 *
 * Delivery is deliberately "once per message", and it is confirmed rather than
 * assumed: the pre-step listener injects the block and remembers the receipt
 * (the block's own header line) plus the step it went into, and the annotations
 * are marked delivered only once the session log publishes the `user/message`
 * that carries that receipt. Returning `enter` does not guarantee the step
 * reaches the log — the loop checks its abort signal, and runs `prepareRequest`,
 * before it appends — so a block that never landed must not be reported as
 * delivered. When the step or turn ends without the receipt, the annotations
 * stay pending and ride the next message, which is exactly the retry the user
 * expects after a stop or a failed request.
 *
 * While one receipt is unconfirmed the session injects nothing further: the
 * block may already be in the log, and a second injection would duplicate it.
 *
 * "Which step carries the user's message" is decided by `source.kind`, never by
 * `role` and never by `step === 1`. The loop claims a batch of inbox messages
 * for the step and hands that same array to every `agent/pre-step` listener
 * (`@deepseek-ai/dsh-agent-loop` `AgentInbox.claim` → `preStep`, payload
 * `{ messages: claimed, turn, step, signal }`), so that batch *is* the input the
 * step is about to send. The criterion is attribution, not "the human typed it":
 * human entrypoints always attribute their message to the user
 * (`@deepseek-ai/dsh-api-session-controller` writes `source.kind === "user"`),
 * and so do plugins relaying something the user triggered — `/plan <text>`
 * steers the text the user just typed with `source: { kind: "user" }`
 * (`@deepseek-ai/dsh-plan-mode`), which a LATER step of that same turn claims;
 * `/goal` re-injects its attachments the same way
 * (`@deepseek-ai/dsh-command-goal`); a replayed agent-teams slash command does
 * too (`@nanmicoder/dsh-agent-teams` `command.js:91,107`); and a subagent
 * delegation prompt is `user` in the child session that receives it
 * (`@deepseek-ai/dsh-subagent`).
 *
 * What the gate must keep out is everything the loop and other plugins put in
 * front of the model under their OWN kind: the runtime context folded into every
 * step (`runtime-context`, `@deepseek-ai/dsh-agent-loop`), automatic
 * continuation rounds (`goal`, `@deepseek-ai/dsh-goal-round-driver`), background
 * job notices (`tool-jobs`, `@deepseek-ai/dsh-tool-jobs`), and any other
 * plugin's injection. Matching on `role === "user"` cannot separate those from
 * the user's own input — `createUserMessage` gives that role to every one of
 * them — which is why the gate reads `source.kind`. And a `step === 1` test
 * would re-open this exact defect: a goal round also lands on a step 1.
 *
 * Runtime imports stay on `node:*` builtins on purpose: a workspace-installed
 * bundle cannot resolve `@deepseek-ai/*` packages, so the host half must be
 * dependency-free.
 *
 * @module dsh-annotate
 */

import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'

export const name = 'dsh-annotate'

/** Hard dependency: the tool registry provides the `annotation` tool. */
export const inject = ['tools']

/**
 * Host-half revision. The profile disables module HMR (`hmr.root: []`), so a
 * running process only picks up this file at boot or after the plugin row is
 * re-activated; the tool reports this value so "which revision is live" is
 * answerable without a restart-and-guess.
 *
 * Revision 10: loading the store now backfills the numbers the records written
 * before 0.8.0 never persisted, and leaves a copy of the store behind first.
 */
const REVISION = 10

const ROUTE_PATH = '/plugins/dsh-annotate/api'
/**
 * `source.kind` of the message that carries the block. Anything other than
 * `user` makes the chat render that message as an injected-context row instead
 * of the user's own bubble, which is the whole point of sending the block as a
 * message of its own.
 */
const BLOCK_SOURCE_KIND = 'dsh-annotate'
const STORE_VERSION = 1
/**
 * Where the one-shot pre-migration copy of the store goes: beside it, under a
 * fixed name.
 *
 * The suffix carries the version that introduced the backfill so the file says
 * what it is, and stays free of a timestamp on purpose — a timestamp would pile
 * up one file per retry, and the earliest copy is the useful one. The copy is
 * written with `flag: 'wx'` (mode `0600`), so only the first migration creates
 * it and nobody can lose an earlier copy to a later run.
 */
const MIGRATION_BACKUP_SUFFIX = '.migrate-0.9.0.bak'
const MAX_BODY_BYTES = 512 * 1024
const MAX_QUOTE = 2000
const MAX_NOTE = 4000
const MAX_PER_SESSION = 400
const STATUSES = new Set(['pending', 'delivered'])

/* ------------------------------------------------------------------ paths */

function dshHome() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim().length > 0) return fromEnv.trim()
  return join(homedir(), '.dsh')
}

function storePath() {
  return join(dshHome(), 'annotations', 'annotations.json')
}

/* ------------------------------------------------------------ small utils */

function asString(value, max) {
  return typeof value === 'string' ? value.slice(0, max) : ''
}

function asId(value) {
  return asString(value, 120)
}

/**
 * Keep a client-supplied occurrence only when it is a finite, non-negative
 * integer.
 *
 * The field is optional (records written before 0.6.0 do not carry it) and the
 * browser is not trusted: a string, a fraction, a negative or `NaN` is dropped
 * to `undefined` so the client half falls back to its creation-order table
 * instead of trying to locate a nonsense position. Never throws.
 */
function asOccurrence(value) {
  return Number.isInteger(value) && value >= 0 ? value : undefined
}

/**
 * Keep a stored annotation number only when it is an integer of at least 1.
 *
 * The field is optional (records written before 0.8.0 do not carry it) and the
 * stored file is not trusted either: a string, a fraction, a zero, a negative or
 * `NaN` is dropped to `undefined` so {@link numbering} falls back to the position
 * of that record instead of labelling it with a nonsense value. Never throws.
 *
 * Written exactly like {@link asOccurrence} on purpose: the two optional
 * identity fields share one acceptance rule shape, so a reader only has to learn
 * it once.
 */
function asNumber(value) {
  return Number.isInteger(value) && value >= 1 ? value : undefined
}

/**
 * Resolve the Session id from an agent handle. The event contract exposes
 * `agent.id`, but the live Agent also carries `agent.session.id`; prefer
 * whichever looks like a session id so a contract change degrades to the
 * other one instead of silently addressing the wrong session.
 * @param {any} agent agent handle from a tool execution or pre-step payload.
 */
function sessionIdOf(agent) {
  const direct = asId(agent?.id)
  const nested = asId(agent?.session?.id)
  if (direct.startsWith('session-')) return direct
  if (nested.startsWith('session-')) return nested
  return direct.length > 0 ? direct : nested
}

function blankState() {
  return { version: STORE_VERSION, annotations: [] }
}

function normalizeRecord(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const id = asId(raw.id)
  const sessionId = asId(raw.sessionId)
  if (id.length === 0 || sessionId.length === 0) return undefined
  const status = STATUSES.has(raw.status) ? raw.status : 'pending'
  return {
    id,
    sessionId,
    quote: asString(raw.quote, MAX_QUOTE),
    note: asString(raw.note, MAX_NOTE),
    status,
    createdAt: Number.isFinite(raw.createdAt) ? raw.createdAt : Date.now(),
    updatedAt: Number.isFinite(raw.updatedAt) ? raw.updatedAt : Date.now(),
    deliveredAt: Number.isFinite(raw.deliveredAt) ? raw.deliveredAt : undefined,
    deliveredTurn: Number.isFinite(raw.deliveredTurn) ? raw.deliveredTurn : undefined,
    origin: raw.origin === 'user' ? 'user' : 'assistant',
    occurrence: asOccurrence(raw.occurrence),
    number: asNumber(raw.number),
  }
}

/**
 * Replace a file with `text`, atomically where the platform allows it.
 *
 * The temp-file + rename dance is what keeps a crash from leaving a half
 * written store; the fallback covers platforms (notably Windows) where
 * `rename` refuses to replace an existing destination instead of doing it
 * atomically.
 *
 * @param file destination path.
 * @param text full next content.
 */
async function writeAtomic(file, text) {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
  await writeFile(tmp, text, { encoding: 'utf8', mode: 0o600 })
  try {
    await rename(tmp, file)
  } catch (error) {
    if (error?.code === 'EEXIST' || error?.code === 'EPERM' || error?.code === 'EACCES') {
      await rm(file, { force: true })
      await rename(tmp, file)
      return
    }
    await rm(tmp, { force: true }).catch(() => {})
    throw error
  }
}

/* --------------------------------------------------------------- the store */

class AnnotationStore {
  /**
   * @param {string} file absolute path of the JSON document.
   * @param {any} [logger] `ctx.logger`; the backfill reports through it. Absent
   *   or partial loggers are tolerated — a missing method is never an error.
   */
  constructor(file, logger) {
    this.file = file
    this.logger = logger
    this.state = blankState()
    this.loaded = false
    this.loading = undefined
    /**
     * The bytes `load()` read this boot, kept for the pre-migration backup so it
     * can be a copy of the file as it was rather than of a re-serialised state.
     * `undefined` when there was nothing to read (missing or unparsable file).
     */
    this.source = undefined
    /** Serializes writes so two concurrent API calls cannot interleave. */
    this.writing = Promise.resolve()
  }

  async load() {
    if (this.loaded) return this.state
    if (this.loading !== undefined) return this.loading
    this.loading = (async () => {
      this.source = undefined
      try {
        const text = await readFile(this.file, 'utf8')
        const parsed = JSON.parse(text)
        const raw = Array.isArray(parsed?.annotations) ? parsed.annotations : []
        this.source = text
        this.state = { version: STORE_VERSION, annotations: raw.map(normalizeRecord).filter((r) => r !== undefined) }
      } catch (error) {
        if (error?.code !== 'ENOENT') {
          // A corrupt document must not take the plugin down: keep a copy and start clean.
          try {
            await rename(this.file, `${this.file}.corrupt-${Date.now()}`)
          } catch {
            /* the move is best-effort */
          }
        }
        this.state = blankState()
      }
      // Deliberately OUTSIDE the try/catch above: an unexpected throw in here
      // must never be mistaken for a corrupt document, which would move the real
      // store aside and start from an empty state. A failure here is logged and
      // the boot carries on with the numbers read at run time (see
      // `backfillNumbers`), and the next boot retries.
      try {
        await this.backfillNumbers()
      } catch (error) {
        this.logger?.warn?.('dsh-annotate: annotation number backfill failed: %o', error)
      }
      this.loaded = true
      return this.state
    })()
    return this.loading
  }

  /**
   * One-shot backfill of the numbers the pre-0.8.0 records never persisted.
   *
   * Returns the number of records written; 0 means "nothing to do" and no write
   * happened. Never throws: every failure is logged and leaves the store as it
   * was, so the next boot retries with the read-time derivation still in place.
   *
   * The value written is the one {@link numbering} ALREADY reports for that
   * record — the same function every projection reads — so the upgrade changes
   * no number the user can see. Records that do carry a valid number (including
   * the duplicated ones a hand-edited file can hold) are never rewritten.
   *
   * Order matters: the backup lands first, then the in-memory numbers, then the
   * store. Until the backup exists nothing has been changed anywhere, and if the
   * store write fails the in-memory numbers are rolled back so memory and disk
   * agree again and a later flush cannot persist them by accident.
   *
   * The store is written through {@link writeAtomic} rather than `this.flush()`
   * on purpose: `flush()` chains onto `this.writing` and a rejection there would
   * silently fail every later flush of the boot. Nothing can be racing this
   * write — every path that flushes awaits `load()` first — so the serialization
   * the chain buys is not needed this early.
   */
  async backfillNumbers() {
    const groups = new Map()
    for (const record of this.state.annotations) {
      const group = groups.get(record.sessionId)
      if (group === undefined) groups.set(record.sessionId, [record])
      else group.push(record)
    }
    const filled = []
    for (const group of groups.values()) {
      // The session's own records, in the order they are stored: `numbering()`
      // sorts by `createdAt` itself and keeps the document order on a tie, which
      // is the rule every read path already resolves a tie with.
      const numbers = numbering(group)
      for (const record of group) {
        // Missing and invalid go the same way: `normalizeRecord` already turned
        // a string, a fraction, a zero, a negative and `NaN` into `undefined`.
        if (asNumber(record.number) !== undefined) continue
        const derived = numbers.get(record.id)
        if (!Number.isInteger(derived) || derived < 1) continue
        filled.push([record, derived])
      }
    }
    if (filled.length === 0) return 0

    const backup = `${this.file}${MIGRATION_BACKUP_SUFFIX}`
    try {
      // `wx` = O_CREAT|O_EXCL: an existing backup means a previous migration got
      // here first, and that earlier copy is the more valuable one. Keep it and
      // carry on — refusing to migrate would leave a machine that lost the
      // backup file unnumbered forever.
      await writeFile(backup, this.source, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    } catch (error) {
      if (error?.code !== 'EEXIST') {
        this.logger?.warn?.(
          'dsh-annotate: could not write the pre-0.9.0 store backup; the store is left untouched: %o',
          error,
        )
        return 0
      }
      this.logger?.info?.('dsh-annotate: pre-0.9.0 store backup already present; keeping the earliest copy')
    }

    for (const [record, value] of filled) record.number = value
    const snapshot = JSON.stringify({ version: STORE_VERSION, annotations: this.state.annotations }, null, 2)
    try {
      await mkdir(dirname(this.file), { recursive: true })
      await writeAtomic(this.file, snapshot)
    } catch (error) {
      for (const [record] of filled) record.number = undefined
      this.logger?.warn?.(
        'dsh-annotate: could not persist the backfilled annotation numbers; they stay derived this boot: %o',
        error,
      )
      return 0
    }
    this.logger?.info?.(
      'dsh-annotate: backfilled %d annotation number(s); the pre-migration store is at %s',
      filled.length,
      backup,
    )
    return filled.length
  }

  async flush() {
    const snapshot = JSON.stringify({ version: STORE_VERSION, annotations: this.state.annotations }, null, 2)
    this.writing = this.writing.then(async () => {
      await mkdir(dirname(this.file), { recursive: true })
      await writeAtomic(this.file, snapshot)
    })
    return this.writing
  }

  /** Every record of one session, newest first. */
  list(sessionId) {
    return this.state.annotations
      .filter((item) => item.sessionId === sessionId)
      .sort((a, b) => b.createdAt - a.createdAt)
  }

  pending(sessionId) {
    return this.list(sessionId)
      .filter((item) => item.status === 'pending')
      .sort((a, b) => a.createdAt - b.createdAt)
  }

  async create(input) {
    const sessionId = asId(input.sessionId)
    if (sessionId.length === 0) throw new Error('sessionId is required')
    // Assign the number ONCE, here, before the record joins the list: it is an
    // identity, not a position. It must clear every number this session already
    // reads — the persisted ones and the derived ones of older records alike —
    // so a newcomer can never re-label an annotation that already has one. The
    // new record is deliberately not part of the maximum: its own number is
    // still undefined, and the derived pass would otherwise hand it a position
    // (the smallest free one) that the increment then skips over.
    const existing = this.state.annotations.filter((item) => item.sessionId === sessionId)
    const numbers = numbering(existing)
    let highest = 0
    for (const item of existing) highest = Math.max(highest, numbers.get(item.id) ?? 0)
    const record = normalizeRecord({
      id: `ann-${randomUUID()}`,
      sessionId,
      number: highest + 1,
      quote: input.quote,
      note: input.note,
      origin: input.origin,
      occurrence: input.occurrence,
      status: 'pending',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
    if (record === undefined) throw new Error('sessionId is required')
    this.state.annotations.push(record)
    const forSession = this.state.annotations.filter((item) => item.sessionId === record.sessionId)
    if (forSession.length > MAX_PER_SESSION) {
      // Oldest delivered first; pending records are never dropped.
      const overflow = forSession.length - MAX_PER_SESSION
      const doomed = new Set(
        forSession
          .filter((item) => item.status === 'delivered')
          .sort((a, b) => a.createdAt - b.createdAt)
          .slice(0, overflow)
          .map((item) => item.id),
      )
      this.state.annotations = this.state.annotations.filter((item) => !doomed.has(item.id))
    }
    await this.flush()
    return record
  }

  async update(id, patch) {
    const record = this.state.annotations.find((item) => item.id === id)
    if (record === undefined) return undefined
    if (patch.quote !== undefined) record.quote = asString(patch.quote, MAX_QUOTE)
    if (patch.note !== undefined) record.note = asString(patch.note, MAX_NOTE)
    if (patch.status !== undefined && STATUSES.has(patch.status)) record.status = patch.status
    record.updatedAt = Date.now()
    await this.flush()
    return record
  }

  async remove(id) {
    const before = this.state.annotations.length
    this.state.annotations = this.state.annotations.filter((item) => item.id !== id)
    if (this.state.annotations.length === before) return false
    await this.flush()
    return true
  }

  /**
   * Put one record back in the delivery queue.
   *
   * Only the persisted state changes: the record returns to `pending` and the
   * delivery receipt (`deliveredAt`/`deliveredTurn`) is dropped, so the next step
   * that carries input attributed to the user picks it up again like any other
   * pending annotation — a step that carries none never takes it. This
   * deliberately does not inject anything itself: injection is the pre-step
   * listener's job, and it is confirmed off the session log.
   *
   * Idempotent: a record that is already pending comes back pending (with a
   * refreshed `updatedAt`).
   */
  async redeliver(id) {
    const record = this.state.annotations.find((item) => item.id === id)
    if (record === undefined) return undefined
    record.status = 'pending'
    record.deliveredAt = undefined
    record.deliveredTurn = undefined
    record.updatedAt = Date.now()
    await this.flush()
    return record
  }

  async clearDelivered(sessionId) {
    const before = this.state.annotations.length
    this.state.annotations = this.state.annotations.filter(
      (item) => !(item.sessionId === sessionId && item.status === 'delivered'),
    )
    const removed = before - this.state.annotations.length
    if (removed > 0) await this.flush()
    return removed
  }

  /** Mark records delivered; returns the records that changed. */
  async markDelivered(ids, turn) {
    const wanted = new Set(ids)
    const changed = []
    for (const record of this.state.annotations) {
      if (!wanted.has(record.id) || record.status === 'delivered') continue
      record.status = 'delivered'
      record.deliveredAt = Date.now()
      record.deliveredTurn = Number.isFinite(turn) ? turn : undefined
      record.updatedAt = record.deliveredAt
      changed.push(record)
    }
    if (changed.length > 0) await this.flush()
    return changed
  }
}

/* ------------------------------------------------------- delivery rendering */

/**
 * Stable per-session numbering: the numbers the panel, the badges and the reply
 * markers all read, so "Annotation 4" always means the same annotation.
 *
 * Since 0.8.0 a number is assigned **once**, when the record is created, and
 * persisted with it ({@link AnnotationStore.create}); this function only reports
 * it. The stored value wins, so deleting another annotation or clearing the
 * delivered ones never moves a surviving record's number.
 *
 * A record written before 0.8.0 has no number, and a stored value that is not a
 * valid number is dropped on load; those records are numbered by position: in
 * `createdAt` order each takes the SMALLEST positive integer that no persisted
 * number already owns. A session in which no record carries a persisted number
 * is therefore still numbered 1..N in creation order — byte for byte what 0.7.0
 * produced — and a record that does carry one never consumes a fallback value
 * that belongs to an older record.
 *
 * A surviving record's number never changes, and a new annotation never takes a
 * number a surviving record still reads — it takes `max(what still reads) + 1`.
 * The numbering is therefore not a monotonically growing counter, and reuse
 * happens on exactly one narrow edge: deleting the record that holds the
 * CURRENT maximum frees that number for the next annotation (delete 3 from
 * 1, 2, 3 and the next annotation is 3 again; delete 2 and the next one is 4, so
 * a NON-maximum number is never reused). Numbers do stop being contiguous in a
 * session where something was deleted: stable beats contiguous.
 *
 * @param {Array<any>} records every record of one session.
 * @returns {Map<string, number>}
 */
function numbering(records) {
  const ordered = records.slice().sort((a, b) => a.createdAt - b.createdAt)
  const numbers = new Map()
  const taken = new Set()
  for (const record of ordered) {
    const stored = asNumber(record.number)
    // A duplicate — a hand-edited file, say — must not make two records read the
    // same: the first one in creation order keeps the value and the rest fall
    // back to a free position, so every record still gets exactly one number.
    if (stored === undefined || taken.has(stored)) continue
    numbers.set(record.id, stored)
    taken.add(stored)
  }
  let next = 1
  for (const record of ordered) {
    if (numbers.has(record.id)) continue
    while (taken.has(next)) next += 1
    numbers.set(record.id, next)
    taken.add(next)
  }
  return numbers
}

/**
 * Render the block the model reads.
 *
 * The block travels as its own message, so it does not need to separate itself
 * from the user's text with a leading blank line any more: the message boundary
 * does that. It still ends with a newline so the instruction line is a
 * paragraph of its own.
 *
 * @param records pending records in creation order.
 * @param {Map<string, number>} numbers stable per-session numbers.
 */
function renderBlock(records, numbers) {
  const lines = []
  const labels = records.map((record) => numbers.get(record.id) ?? 0)
  lines.push(`—— 批注（共 ${records.length} 处，编号 ${labels.join('、')}）——`)
  lines.push('')
  records.forEach((record) => {
    const quote = record.quote.replace(/\s+/g, ' ').trim()
    lines.push(`${numbers.get(record.id) ?? 0}. 原文：「${quote.length > 0 ? quote : '(未捕获到原文)'}」`)
    const note = record.note.trim()
    lines.push(`   批注：${note.length > 0 ? note : '（未填写批注，只标记了原文）'}`)
    lines.push('')
  })
  lines.push(
    `请用${labels.map((label) => `「Annotation ${label}：…」`).join('')}的格式逐条回应；` +
      '不要复述原文，先直接回答问题，需要时再引用被批注的句子。',
  )
  lines.push('')
  return lines.join('\n')
}

/**
 * The delivery receipt of one rendered block: its header line.
 *
 * This is what the store waits for in the session log before calling an
 * annotation delivered. Nothing is added to the message for bookkeeping — the
 * receipt is text the model already reads, so the log stays clean and a
 * receipt cannot be forged by the plugin itself.
 *
 * @param block output of {@link renderBlock}.
 */
function receiptOf(block) {
  for (const line of String(block).split('\n')) {
    if (line.trim().length > 0) return line
  }
  return ''
}

/**
 * Whether one `user/message` event is the message that carries this receipt.
 * @param event the appended session event.
 * @param receipt receipt of the injected block.
 */
function eventCarriesReceipt(event, receipt) {
  if (receipt.length === 0) return false
  const content = event?.data?.content
  if (!Array.isArray(content)) return false
  return content.some(
    (part) => part?.type === 'text' && typeof part.text === 'string' && part.text.includes(receipt),
  )
}

/**
 * Build the message that carries the block.
 *
 * `role` must stay `user`: the session store rejects a `user/message` event
 * whose role is anything else. `source.kind` is the only lever — it is what
 * keeps the row out of the user's own bubble.
 *
 * @param block output of {@link renderBlock}.
 */
function blockMessage(block) {
  return {
    id: randomUUID(),
    role: 'user',
    source: { kind: BLOCK_SOURCE_KIND },
    content: [{ type: 'text', text: block }],
  }
}

/**
 * Put the annotation block on the wire as its own message, immediately after
 * the user-attributed message the step carries.
 *
 * The user's own message is returned untouched: the block is an additional
 * entry in the list, not extra text on their message. DSH appends every entry
 * of `decision.messages` as its own event, so the block still lands in the log
 * (and therefore still reaches the model), it just stops being part of the
 * words the user typed.
 *
 * The host is the message the step carries from the user
 * (`role === "user"` and `source.kind === "user"`) — and that is the ONLY host
 * this function accepts. There is deliberately no `role === "user"` fallback:
 * `createUserMessage` gives the `user` role to the loop's own runtime context
 * and to every plugin notice (`runtime-context`, `goal`, `tool-jobs`, …), so a
 * fallback would silently hang the block on a message the user never sent —
 * which is exactly the defect the pre-step gate exists to prevent. When no such
 * message is on the list, nothing is injected and the annotations stay pending
 * for the user's next message.
 *
 * @returns the replacement message list, or undefined when nothing applies.
 */
function injectIntoMessages(messages, block) {
  if (!Array.isArray(messages) || messages.length === 0) return undefined
  let index = -1
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]
    if (message?.role === 'user' && message?.source?.kind === 'user') {
      index = i
      break
    }
  }
  if (index === -1) return undefined
  const out = messages.slice()
  out.splice(index + 1, 0, blockMessage(block))
  return out
}

/* -------------------------------------------------------------- http plumbing */

function hostIsLocal(request) {
  const host = String(request?.headers?.host ?? '')
  const name = host.replace(/:\d+$/, '').replace(/^\[|\]$/g, '').toLowerCase()
  return name === '127.0.0.1' || name === 'localhost' || name === '::1'
}

/**
 * Whether one browser request may use the annotation API.
 *
 * Two fences, both required: the `Host` header must be loopback (so a remote
 * page cannot reach this route by DNS rebinding), and the request must prove it
 * came from a page THIS process served — with the per-boot token published into
 * that page's boot payload, or, before any page has been rendered, with the
 * static marker header the browser half always sends.
 *
 * Exported so the guard can be tested without a live server.
 *
 * @param request incoming request; only `headers` is read.
 * @param token the per-boot token, or an empty string when none was minted.
 * @param requireToken true once that token has been published into a served page.
 * @returns whether the request is authorized.
 */
export function authorize(request, token, requireToken) {
  if (!hostIsLocal(request)) return false
  const headers = request?.headers ?? {}
  if (requireToken === true && typeof token === 'string' && token.length > 0) {
    return headers['x-dsh-annotate-token'] === token
  }
  return headers['x-dsh-annotation'] === '1'
}

async function readJsonBody(request) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new Error('request body too large')
    chunks.push(chunk)
  }
  if (size === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

function sendJson(response, status, payload) {
  const body = JSON.stringify(payload)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  response.end(body)
}

/** Project one record onto the browser-facing shape. */
function toClient(record, numbers) {
  return {
    id: record.id,
    sessionId: record.sessionId,
    number: numbers === undefined ? undefined : numbers.get(record.id),
    quote: record.quote,
    note: record.note,
    status: record.status,
    origin: record.origin,
    occurrence: record.occurrence,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    deliveredAt: record.deliveredAt,
  }
}

/* ------------------------------------------------------------------- plugin */

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx plugin context.
 */
export function apply(ctx) {
  const logger = ctx.logger ?? console
  const store = new AnnotationStore(storePath(), logger)
  /** Per-boot secret: only a page this process served can present it. */
  const token = randomUUID()
  let tokenPublished = false
  /**
   * Delivery receipts still waiting for the log, per session: which annotation
   * ids went into which step, and the header line that proves it landed.
   * @type {Map<string, { ids: string[], receipt: string, turn: number, step: number }>}
   */
  const inFlight = new Map()

  // Hand the token to the served page. `index-inject` runs while the boot HTML
  // is rendered, which always precedes the browser half that reads it, so the
  // flag is set before any authorized request can arrive from that page.
  ctx.on('webserver/index-inject', (table) => {
    tokenPublished = true
    table.push({
      kind: 'global',
      name: '__DSH_ANNOTATE__',
      value: { route: ROUTE_PATH, token },
    })
  })

  /* ---- browser API route (client half) ---- */
  ctx.inject(['webServer'], (webCtx) => {
    const webServer = webCtx.webServer ?? webCtx.reflect?.get?.('webServer')
    if (webServer === undefined || typeof webServer.register !== 'function') return
    webCtx.effect(
      () =>
        webServer.register({
          kind: 'exact',
          path: ROUTE_PATH,
          handler: async (request, response) => {
            // Local-only plugin surface, guarded by a custom header: a
            // cross-origin page cannot set it without a preflight, and this
            // route answers no preflight.
            if (!authorize(request, token, tokenPublished)) {
              sendJson(response, 403, { ok: false, error: 'forbidden' })
              return
            }
            if (request.method === 'OPTIONS') {
              response.writeHead(204).end()
              return
            }
            if (request.method !== 'POST') {
              sendJson(response, 405, { ok: false, error: 'POST only' })
              return
            }
            try {
              const body = await readJsonBody(request)
              await store.load()
              const sessionId = asId(body.sessionId)
              const payload = await handleApi(store, body, sessionId)
              sendJson(response, 200, { ok: true, ...payload })
            } catch (error) {
              logger.warn?.('dsh-annotate: api failed: %o', error)
              sendJson(response, 400, { ok: false, error: error instanceof Error ? error.message : String(error) })
            }
          },
        }),
      'dsh-annotate: browser api route',
    )
  })

  /* ---- delivery: send the block as its own message, right after the user's ---- */
  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    if (decision?.kind !== 'enter') return decision
    const sessionId = sessionIdOf(payload?.agent)
    if (sessionId.length === 0) return decision
    // Deliver only on a step that carries input attributed to the user.
    // `agent/pre-step` runs for EVERY step of a turn, so without this gate an
    // annotation added while the turn is already running would ride the next step
    // of that same turn (reported live: a block landed on step 24 of a turn with
    // no user message).
    //
    // The verdict is taken from the batch this step CLAIMED (`payload.messages`)
    // — the array the loop hands to every listener and returns as the enter
    // decision (`{ messages: claimed, turn, step, signal }`, agent-loop
    // `preStep`) — not from `decision.messages`, which a later listener may have
    // added to. The block itself is still injected into `decision.messages`, the
    // list the step will actually send. And the criterion is `source.kind`, not
    // `role`: `createUserMessage` gives the `user` role to the runtime context
    // and to plugin notices alike, while only input attributed to the user
    // carries `source.kind === 'user'` — a step 1 is no guide either, since a
    // goal round lands on a step 1 too (see the module header for the sources).
    //
    // This sits before `store.load()` on purpose: a step that carries no
    // user-attributed input must not pay for a store read (or, worse, leave a
    // receipt), and the annotation must stay pending for the user's next message.
    const claimed = payload?.messages
    if (!Array.isArray(claimed) || !Array.isArray(decision.messages)) {
      // A broken payload contract is not "no user input": say so instead of
      // silently switching delivery off for the session.
      logger.warn?.('dsh-annotate: agent/pre-step messages are not an array; skipping delivery for this step')
      return decision
    }
    if (!claimed.some((message) => message?.source?.kind === 'user')) return decision
    try {
      await store.load()
      // One receipt at a time. A live one means the previous block may already
      // be in the log, and injecting it again would duplicate it in the
      // transcript; the step/end below clears it when it demonstrably did not
      // land.
      if (inFlight.has(sessionId)) return decision
      const pending = store.pending(sessionId)
      if (pending.length === 0) return decision
      const block = renderBlock(pending, numbering(store.list(sessionId)))
      const messages = injectIntoMessages(decision.messages, block)
      if (messages === undefined) {
        // The claimed batch had user-attributed input but the list this step will
        // send has none to hang the block on. Nothing else may host it, so the
        // annotations stay pending — and this is said out loud rather than
        // silently consumed.
        logger.warn?.('dsh-annotate: no user-attributed message to carry the annotation block; nothing injected')
        return decision
      }
      // Deliberately NOT marked delivered here: the loop still has its abort
      // check and `prepareRequest` to get through before this message is
      // appended, and a block the model never received is not delivered.
      inFlight.set(sessionId, {
        ids: pending.map((item) => item.id),
        receipt: receiptOf(block),
        turn: payload?.turn,
        step: payload?.step,
      })
      return { ...decision, messages }
    } catch (error) {
      logger.warn?.('dsh-annotate: delivery failed: %o', error)
      return decision
    }
  })

  /* ---- delivery receipt: the log is what makes a block delivered ---- */
  ctx.on('session/event', (session, event) => {
    const sessionId = asId(session?.id)
    if (sessionId.length === 0) return
    const flight = inFlight.get(sessionId)
    if (flight === undefined) return
    if (event?.type === 'user/message') {
      if (!eventCarriesReceipt(event, flight.receipt)) return
      inFlight.delete(sessionId)
      // `append` publishes this event synchronously, so the store is already
      // loaded on this path; the fallback covers a listener attached earlier.
      const mark = () => store.markDelivered(flight.ids, flight.turn)
      const settled = store.loaded ? mark() : store.load().then(mark)
      // Returning the promise does not hold the append up — the event is
      // already in the log, and DSH only contains observer rejections — but it
      // makes "this delivery is persisted" awaitable instead of a guess.
      return settled.catch((error) => {
        logger.warn?.('dsh-annotate: could not record delivery: %o', error)
      })
    }
    // The step (or the whole turn, when the abort lands before the step even
    // started) is over and the receipt was never seen: the message was not
    // appended, so those annotations are still unsent. Drop the receipt and let
    // the next message carry them.
    if (event?.type === 'step/end' && event.data?.turn === flight.turn && event.data?.step === flight.step) {
      inFlight.delete(sessionId)
      logger.info?.('dsh-annotate: step %s/%s ended without the annotation block; %d annotation(s) stay pending', flight.turn, flight.step, flight.ids.length)
      return
    }
    if (event?.type === 'turn/end' && event.data?.turn === flight.turn) {
      inFlight.delete(sessionId)
      logger.info?.('dsh-annotate: turn %s ended without the annotation block; %d annotation(s) stay pending', flight.turn, flight.ids.length)
    }
  })

  /* ---- the agent-facing tool ---- */
  ctx.effect(
    () =>
      ctx.tools.register({
        name: 'annotation',
        description:
          'Read or resolve the user\'s annotations on this conversation. Annotations are quotes the user ' +
          'selected in the transcript plus an optional note; the pending ones are delivered automatically with ' +
          'the next user message. Use action "list" to re-read them (for example after a compaction) and ' +
          'action "resolve" to mark the ones you have answered.',
        parameters: {
          type: 'object',
          properties: {
            action: {
              type: 'string',
              enum: ['list', 'resolve'],
              description: 'list: return this session\'s annotations. resolve: mark annotations as answered.',
            },
            ids: {
              type: 'array',
              items: { type: 'string' },
              description: 'resolve only: annotation ids to resolve. Omit to resolve every pending annotation.',
            },
            includeDelivered: {
              type: 'boolean',
              description: 'list only: also return already delivered annotations. Defaults to true.',
            },
          },
          required: ['action'],
          additionalProperties: false,
        },
        output: {
          schema: { type: 'object' },
          render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
        },
        execute: async (args, exec) => {
          await store.load()
          const sessionId = sessionIdOf(exec?.agent)
          if (sessionId.length === 0) return { error: 'no session in scope' }
          const action = asString(args?.action, 32)
          if (action === 'resolve') {
            const requested = Array.isArray(args?.ids) && args.ids.length > 0 ? args.ids.map(asId) : store.pending(sessionId).map((item) => item.id)
            const changed = await store.markDelivered(requested, undefined)
            return { resolved: changed.map((item) => ({ id: item.id, quote: item.quote })) }
          }
          const includeDelivered = args?.includeDelivered !== false
          const all = store.list(sessionId)
          const numbers = numbering(all)
          const shown = includeDelivered ? all : all.filter((item) => item.status === 'pending')
          return {
            revision: REVISION,
            sessionId,
            pending: all.filter((item) => item.status === 'pending').length,
            annotations: shown
              .slice()
              .reverse()
              .map((item) => ({
                id: item.id,
                number: numbers.get(item.id),
                status: item.status,
                origin: item.origin,
                quote: item.quote,
                note: item.note,
                createdAt: new Date(item.createdAt).toISOString(),
              })),
          }
        },
      }),
    'dsh-annotate: annotation tool',
  )
}

/**
 * One request of the browser API.
 * @param {AnnotationStore} store loaded store.
 * @param {any} body parsed request body.
 * @param {string} sessionId session addressed by the request.
 */
async function handleApi(store, body, sessionId) {
  const action = asString(body?.action, 32)
  switch (action) {
    case 'list': {
      if (sessionId.length === 0) throw new Error('sessionId is required')
      const records = store.list(sessionId)
      const numbers = numbering(records)
      return { annotations: records.map((record) => toClient(record, numbers)) }
    }
    case 'create': {
      const input = body?.annotation ?? {}
      const target = asId(input.sessionId) || sessionId
      if (target.length === 0) throw new Error('sessionId is required')
      const record = await store.create({
        sessionId: target,
        quote: asString(input.quote, MAX_QUOTE),
        note: asString(input.note, MAX_NOTE),
        origin: input.origin === 'user' ? 'user' : 'assistant',
        occurrence: input.occurrence,
      })
      const records = store.list(target)
      const numbers = numbering(records)
      return {
        annotation: toClient(record, numbers),
        annotations: records.map((item) => toClient(item, numbers)),
      }
    }
    case 'update': {
      const id = asId(body?.id)
      const record = await store.update(id, {
        quote: body?.patch?.quote,
        note: body?.patch?.note,
      })
      if (record === undefined) throw new Error(`unknown annotation: ${id}`)
      const records = store.list(record.sessionId)
      const numbers = numbering(records)
      return {
        annotation: toClient(record, numbers),
        annotations: records.map((item) => toClient(item, numbers)),
      }
    }
    case 'redeliver': {
      const id = asId(body?.id)
      const record = await store.redeliver(id)
      if (record === undefined) throw new Error(`unknown annotation: ${id}`)
      const records = store.list(record.sessionId)
      const numbers = numbering(records)
      return { annotations: records.map((item) => toClient(item, numbers)) }
    }
    case 'delete': {
      const id = asId(body?.id)
      const target = store.state.annotations.find((item) => item.id === id)
      const owner = target === undefined ? sessionId : target.sessionId
      const removed = await store.remove(id)
      if (!removed) throw new Error(`unknown annotation: ${id}`)
      if (owner.length === 0) return { annotations: [] }
      const records = store.list(owner)
      const numbers = numbering(records)
      return { annotations: records.map((record) => toClient(record, numbers)) }
    }
    case 'clear-delivered': {
      if (sessionId.length === 0) throw new Error('sessionId is required')
      const removed = await store.clearDelivered(sessionId)
      const records = store.list(sessionId)
      const numbers = numbering(records)
      return { removed, annotations: records.map((record) => toClient(record, numbers)) }
    }
    default:
      throw new Error(`unknown action: ${action}`)
  }
}
