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
 * assumed: the pre-step listener injects the block and remembers which batch of
 * annotations went into which step, and those annotations are marked delivered
 * only once the session log publishes the `user/message` that proves it. The
 * proof is the batch token on the block's own last line, together with the
 * plugin's own `source.kind` — never the block's header line, which two
 * different batches can print identically and which a user can paste. Returning
 * `enter` does not guarantee the step reaches the log — the loop checks its
 * abort signal, and runs `prepareRequest`, before it appends — so a block that
 * never landed must not be reported as delivered. When the step or turn ends
 * without the proof, the annotations stay pending and ride the next message,
 * which is exactly the retry the user expects after a stop or a failed request.
 *
 * The same standard applies a boot later: {@link reconcile} reads the session's
 * own log and accepts only a `user/message` carrying the same token under the
 * plugin's `source.kind`, which is how a block that reached the log before the
 * process exited is not sent a second time.
 *
 * While one batch is unconfirmed the session injects nothing further: the block
 * may already be in the log, and a second injection would duplicate it.
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
 *
 * Revision 11: every block carries a per-batch identity and the next boot
 * reconciles an unconfirmed delivery against the session log, closing the
 * duplicate window of README §7.
 *
 * Revision 12: confirmation is one standard again — the batch token under the
 * plugin's own `source.kind` — on both the in-process and the cold-log path.
 * The older header-substring leg, which could admit a message the plugin never
 * sent, is gone.
 */
const REVISION = 12

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
/**
 * The marker line of every block: the batch's own identity, and the only part
 * of the text that decides whether a `user/message` is this batch's block.
 *
 * It is deliberately not the only required condition — a message must ALSO
 * carry the plugin's own `source.kind`, which is what excludes a user pasting
 * the block or a model repeating it. The two are independent, and both are
 * required; neither is sufficient alone.
 *
 * The header line cannot serve as identity. It reads
 * `—— 批注（共 N 处，编号 …）——` and is decided entirely by how many
 * annotations the batch holds and which numbers they carry — it says nothing
 * about content, so it is not unique: every session's first batch is
 * `共 1 处，编号 1`, a freed maximum number is deliberately reused (README §6),
 * and the string sits in 98 places across the sessions on this machine
 * (tool results, assistant replies, and text the user typed themselves). A
 * receipt that another batch can produce is not a receipt.
 *
 * So the marker carries a per-batch `randomUUID`, and the round trip is exact:
 * {@link renderBlock} writes the line and the ids it belongs to, {@link tokenOf}
 * and {@link idsOf} read them back out of the text — by scanning for the marker
 * line, so that text after it does not defeat recognition — and every judgement
 * goes through equality on the token, never a substring of the header. A UUID
 * is not something a quote, a note, a model reply or a user's own paste produces
 * by accident, and two boots cannot mint the same one.
 */
const BATCH_MARKER = '批次'

/**
 * The vocabulary of `event.type` that carries the block. The plugin only ever
 * puts it on a `user/message` (`blockMessage`), so anything else in the log is
 * text that merely looks like a block.
 */
const BLOCK_EVENT_TYPE = 'user/message'
/**
 * A UUID, and how it is found.
 *
 * Anchored and case-insensitive rather than global: the token is always the
 * first thing on the marker line, so an anchored match is the whole search — and
 * a non-global pattern carries no `lastIndex` between calls, which a `g` flag
 * would (and a shared pattern whose `lastIndex` drifted would start missing
 * tokens that are plainly there). `match` and `test` both report the match, so
 * one literal serves {@link canonicalToken} and {@link asToken} alike.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
/** A UUID anywhere in a line, for the marker line the block writes. */
const UUID_ANYWHERE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i

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
 * Keep a batch token only when it is exactly one canonical UUID.
 *
 * The same acceptance rule shape as {@link asOccurrence} and {@link asNumber}:
 * the field is optional (a pre-0.10.3 record has none) and the stored file is
 * not trusted, so anything else — a number, a truncated id, a sentence, a
 * value a hand-edited file invented — becomes `undefined` rather than a token
 * that could match a block by accident. `undefined` is what every caller does
 * anyway when it has no token: the field is left out.
 *
 * @param value candidate token.
 */
function asToken(value) {
  if (typeof value !== 'string') return undefined
  // The anchored pattern, not a round trip through `canonicalToken`: the two
  // disagree on exactly the strings that matter — a sentence containing a UUID
  // is a valid TOKEN when read back out of a block (the token is the first UUID
  // on the line) but is not a valid STORED value, and accepting one there would
  // let a stray string stand in for a batch.
  return UUID.test(value.trim()) ? value.trim().toLowerCase() : undefined
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
    // 0.10.3. `batchId` is the token of the batch this record is currently
    // riding; `deliveredBatch` is the token it was delivered under. Both are
    // optional and both are `undefined` on a record written before they
    // existed, which is what keeps a 0.10.3 store readable by 0.10.2 and a
    // 0.10.2 store readable here (they are simply absent, never invented).
    batchId: asToken(raw.batchId),
    deliveredBatch: asToken(raw.deliveredBatch),
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

  /**
   * The batch tokens this session has already settled.
   *
   * This is what closes the window the restart reconciliation exists for. The
   * reconciliation reads the session log to find out whether a batch reached
   * it, and the log outlives the process — which is also exactly the problem:
   * a block from an earlier boot is still sitting in the log, and without
   * something that remembers "that batch is already accounted for", the next
   * boot would see it and call the next batch delivered too. Every delivered
   * record records the token it rode, and {@link reconcile} refuses to accept a
   * token a delivered record already claims.
   *
   * The token is read from `deliveredBatch` whatever the record's CURRENT
   * status is, and that is deliberate: a re-queued record is `pending` again
   * but keeps its `deliveredBatch` — its first block is still in the log, and
   * the whole point of the ledger is to stop that block from confirming the
   * second attempt. Keying on `status === 'delivered'` would let exactly the
   * record that was re-queued be confirmed by its own old delivery.
   *
   * It is a lookup, not the truth: the log is still the only thing that makes a
   * block delivered. This only says "this token has been settled before", which
   * is a question about the store's own history.
   *
   * @param {string} sessionId
   * @returns {Set<string>}
   */
  ledger(sessionId) {
    const settled = new Set()
    for (const record of this.state.annotations) {
      if (record.sessionId !== sessionId) continue
      if (record.deliveredBatch !== undefined) settled.add(record.deliveredBatch)
    }
    return settled
  }

  pending(sessionId) {
    return this.list(sessionId)
      .filter((item) => item.status === 'pending')
      .sort((a, b) => a.createdAt - b.createdAt)
  }

  /**
   * Admit one annotation into its session.
   *
   * The per-session maximum is hard. Leaving it is only allowed by evicting
   * older DELIVERED records — never a pending one, which is the promise the
   * README makes — so a create that would leave the session above the maximum
   * with too few delivered records to evict is REFUSED: the record is rolled
   * back off the list and nothing is written. Refusing is the only option that
   * keeps both halves of that promise; the alternative is an unbounded store
   * whose every save re-serializes a larger document.
   *
   * @param {object} input the annotation to create.
   * @returns the admitted record.
   * @throws when the session is at its maximum and the overflow cannot be
   *   absorbed by evicting delivered records.
   */
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
      const overflow = forSession.length - MAX_PER_SESSION
      // Oldest delivered first; pending records are never dropped. The pool is
      // measured before anything is evicted, because the question the next
      // branch asks is whether that pool can absorb the WHOLE overflow.
      const evictable = forSession
        .filter((item) => item.status === 'delivered')
        .sort((a, b) => a.createdAt - b.createdAt)
      if (overflow > evictable.length) {
        // The pool is too small for the overflow, and a pending record is never
        // dropped, so this create cannot be admitted. `slice()` would quietly
        // return fewer records than `overflow` and leave the excess on the
        // list: the session would pass 400, and the only hard ceiling would be
        // gone — every save would serialize an ever larger document.
        // Roll the record back completely: it must not stay on the list, and it
        // must not flush, or the rejected annotation would reach disk anyway.
        // The roll-back also leaves the numbering untouched: a refusal consumes
        // no number and opens no hole, so the next annotation still takes
        // `highest-read + 1` and a session's numbers never skip a value BECAUSE
        // of a refusal. Whether the freed slot itself comes back is a separate,
        // pre-existing question — `numbering()` backfills a record that has no
        // stored number into the smallest free slot, so a session still holding
        // such a legacy record hands that slot to it and the next annotation
        // takes the following number instead.
        this.state.annotations = this.state.annotations.filter((item) => item.id !== record.id)
        throw new Error(
          `session is at the ${MAX_PER_SESSION}-annotation limit; delete or clear delivered annotations to add more`,
        )
      }
      const doomed = new Set(evictable.slice(0, overflow).map((item) => item.id))
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
   * Put one batch back in the delivery queue: every record of `ids` becomes
   * pending under a NEW token, in one write.
   *
   * Only the persisted state changes: those records return to `pending` and
   * their delivery stamp (`deliveredAt`/`deliveredTurn`) is dropped, so the next
   * step that carries input attributed to the user picks them up again like any
   * other pending annotation — a step that carries none never takes them. This
   * deliberately does not inject anything itself: injection is the pre-step
   * listener's job, and it is confirmed off the session log.
   *
   * It is idempotent for a record that is already pending (it comes back
   * pending, with a refreshed `updatedAt` and the new token), and it is not a
   * per-record loop: a re-queued annotation rides a batch that has not been
   * sent before — that is the only way the restart reconciliation can tell the
   * second attempt from the first, since the FIRST attempt's block is still
   * sitting in the log and still carries the first token. Reusing that token
   * would make the next boot's reconciliation read the stale block as proof of
   * the new batch, which is precisely the misjudgement it must never make. One
   * write for the whole batch, too, so a process exiting halfway cannot leave
   * half of it re-queued.
   *
   * @param {string[]} ids records of one session to re-queue.
   * @param {string} token the new batch's canonical token.
   * @returns the number of records changed.
   */
  async requeue(ids, token) {
    const wanted = new Set(ids)
    const batch = asToken(token)
    let changed = 0
    for (const record of this.state.annotations) {
      if (!wanted.has(record.id)) continue
      record.status = 'pending'
      record.deliveredAt = undefined
      record.deliveredTurn = undefined
      // `deliveredBatch` is deliberately NOT cleared. It is the ledger: "this
      // token has already been settled", which is still true — the block that
      // carried it is in the log. Clearing it would let a later reconciliation
      // accept that same old block a second time.
      record.batchId = batch
      record.updatedAt = Date.now()
      changed += 1
    }
    if (changed > 0) await this.flush()
    return changed
  }

  /**
   * Stamp the batch token onto the records that are about to be sent.
   *
   * This is a WRITE, and it has to be. The token is the only thing that lets a
   * later boot find out whether this batch reached the log: the block carries
   * it, so the log carries it — but a boot can only ask the log about a token
   * the STORE still remembers. If the stamp lived only in memory, the crash
   * this whole path exists for (block appended, process gone, store still
   * `pending`) would also take the token with it, and the next boot would have
   * nothing to look for.
   *
   * Persisting it does not mark anything delivered and cannot lose an
   * annotation: the records stay `pending`, so the worst a stamp can do is leave
   * a token on a record whose block never landed — a token no log will ever
   * name, which the next boot's reconciliation finds nothing for and which the
   * next delivery overwrites.
   *
   * @param {string[]} ids records of one batch.
   * @param {string} token that batch's canonical token.
   */
  async stampBatch(ids, token) {
    const wanted = new Set(ids)
    const batch = asToken(token)
    if (batch === undefined) return
    let changed = false
    for (const record of this.state.annotations) {
      if (!wanted.has(record.id) || record.batchId === batch) continue
      record.batchId = batch
      record.updatedAt = Date.now()
      changed = true
    }
    if (changed) await this.flush()
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

  /**
   * Mark records delivered and record the batch they were delivered under.
   *
   * Idempotent: a record already delivered is skipped, so a second caller
   * cannot move its stamp. Returns the records that actually changed.
   *
   * The batch token is written only when the caller has one to give, and only
   * the `annotation` tool's `resolve` has none — it answers annotations the
   * model has dealt with rather than delivering a block, so there is no batch
   * to record and the field is left exactly as absent as it is on a pre-0.10.3
   * record. No token is ever invented.
   *
   * @param {string[]} ids records to mark.
   * @param {number} [turn] the turn a block went into, when there was one.
   * @param {{batch?: string}} [options] the batch token, when there was one.
   */
  async markDelivered(ids, turn, options = {}) {
    const wanted = new Set(ids)
    const batch = asToken(options.batch)
    const changed = []
    for (const record of this.state.annotations) {
      if (!wanted.has(record.id) || record.status === 'delivered') continue
      record.status = 'delivered'
      record.deliveredAt = Date.now()
      record.deliveredTurn = Number.isFinite(turn) ? turn : undefined
      record.deliveredBatch = batch
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
 * The last line is the batch marker (see {@link BATCH_MARKER}). It goes at the
 * END on purpose: the header line is what the panel, the tests and the reader
 * know, and a marker at the end leaves it exactly as it was. What the line
 * costs — a UUID and one line per block — buys the only thing that can tell two
 * batches apart.
 *
 * @param records pending records in creation order.
 * @param {Map<string, number>} numbers stable per-session numbers.
 * @param {string} token the batch's canonical token.
 */
function renderBlock(records, numbers, token) {
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
  // The token comes FIRST because {@link canonicalToken} reads the first UUID
  // on the line, and the block does not get to choose what a quote contains.
  // The ids after it are what make the block specific to these records rather
  // than merely to this batch.
  lines.push(`${BATCH_MARKER} ${token} · ${records.map((record) => record.id).join(',')}`)
  lines.push('')
  return lines.join('\n')
}

function canonicalToken(text) {
  const found = String(text).match(UUID_ANYWHERE)
  return found === null ? '' : found[0].toLowerCase()
}

/**
 * The batch token of a rendered block, read back out of its own text.
 *
 * The marker is found by scanning UP for the last non-empty line that STARTS
 * WITH {@link BATCH_MARKER}, not by assuming the marker is the last non-empty
 * line of the text. The difference matters in the one direction that would
 * otherwise go unnoticed: a log event is not required to end where the block
 * ends. A host that appends anything after it — its own annotation, a wrapper,
 * a note about the message — used to make the whole token comparison fail, so a
 * block that WAS in the log read as absent and the annotation was sent a second
 * time. Requiring the marker's own line instead keeps the recognition, and
 * scanning upward (rather than forward) keeps the answer the same when the
 * surrounding text happens to contain a line that looks like a marker.
 *
 * The first UUID on that line is the token; the ids that follow it are read by
 * {@link idsOf} from the same line.
 *
 * @param {string} text the rendered block, possibly embedded in more text.
 * @returns the canonical token, or `''` when no marker line is there.
 */
function tokenOf(text) {
  const lines = String(text).split('\n')
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i].trim()
    if (line.length === 0 || !line.startsWith(BATCH_MARKER)) continue
    return canonicalToken(line)
  }
  return ''
}

/**
 * The annotation ids one rendered block carried, in block order.
 *
 * The reason a batch can be identified beyond its token: the ids say WHICH
 * records the block was built from, so a block that carried a different set is
 * a different block.
 *
 * Only the last non-empty line is read, so nothing in the surrounding prose can
 * be mistaken for the marker.
 *
 * @param {string} text the rendered block.
 * @returns {string[]} ids, in block order; empty when there is no marker.
 */
function idsOf(text) {
  const lines = String(text).split('\n')
  // The SAME line {@link tokenOf} reads, found the same way: the last non-empty
  // line that starts with the marker. Taking "the last non-empty line" here
  // would be a second, independent way for the pair to lose track of a block
  // that plainly carries a marker — the token would be found and the ids would
  // not, and `eventIsBlockOf` requires both. The two functions must agree about
  // which line is the marker's.
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i].trim()
    if (line.length === 0 || !line.startsWith(BATCH_MARKER)) continue
    // Everything after the `·` is the id list; the token itself is the first
    // UUID on the same line, which `tokenOf` reads.
    const at = line.indexOf('·')
    if (at === -1) return []
    return line
      .slice(at + 1)
      .split(',')
      .map((id) => id.trim())
      .filter((id) => id.length > 0)
  }
  return []
}

/**
 * Whether the block DEFINES this token — the forward direction, used to decide
 * whether a message about to be sent is the injected block itself.
 *
 * Deliberately not the reverse test: a message that merely CONTAINS the token
 * (a user pasting the block, the model repeating it) must not be identity.
 * @param {any} message the injected message.
 * @param {string} token canonical batch token.
 */
function messageDefinesToken(message, token) {
  if (token.length === 0 || !Array.isArray(message?.content)) return false
  return message.content.some(
    (part) => part?.type === 'text' && typeof part.text === 'string' && tokenOf(part.text) === token,
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
 * @param token the batch's canonical token, carried on the message so the
 *   caller knows what to look for without parsing the text again.
 */
function blockMessage(block, token) {
  return {
    id: randomUUID(),
    role: 'user',
    source: { kind: BLOCK_SOURCE_KIND, batch: token },
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
function injectIntoMessages(messages, block, token) {
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
  out.splice(index + 1, 0, blockMessage(block, token))
  return out
}

/* ------------------------------------------------- the restart reconciliation */

/**
 * Whether one raw log event is the block of ONE KNOWN batch.
 *
 * The caller already knows which batch it is looking for — it read the token
 * out of the record that was about to be sent — and this function answers a yes
 * or no question about one event. There is deliberately no "scan for any block"
 * variant: the only question worth asking the log is "is THIS batch in it",
 * because that is the only question whose answer is allowed to change a record.
 *
 * Four fences, all required, and the token comparison is exact equality against
 * the block's own last line rather than a substring search:
 *
 *   1. the event must be the type the plugin injects (`user/message`);
 *   2. `source.kind` must be the plugin's own (`dsh-annotate`), so a model
 *      reply, a tool result or the user pasting a block is never a delivery;
 *   3. the text must END with this token — a message that merely quotes a block
 *      (the user pasting the previous one) has the text but not the ending, and
 *      a block built before 0.10.3 has no token at all;
 *   4. the text must name the records it carried, and every one of `ids` must
 *      be among them.
 *
 * The last fence is what makes the answer specific to the annotation rather
 * than to the batch. It matters for the case the whole reconciliation exists
 * for: a record re-queued for a second attempt rides a NEW token precisely
 * because its first block is still in the log, so the old block must not match
 * the new token (fence 3) — but even the same token cannot be accepted for a
 * batch whose membership changed, because that would be a different block
 * answering a question about this one.
 *
 * @param event one raw event of a session log.
 * @param {string} token the canonical token of the batch being asked about.
 * @param {string[]} ids the annotation ids that batch would carry.
 * @returns whether this event is exactly that block.
 */
function eventIsBlockOf(event, token, ids) {
  if (token.length === 0 || ids.length === 0) return false
  if (event?.type !== BLOCK_EVENT_TYPE) return false
  if (event?.data?.source?.kind !== BLOCK_SOURCE_KIND) return false
  const content = event?.data?.content
  if (!Array.isArray(content)) return false
  for (const part of content) {
    if (part?.type !== 'text' || typeof part.text !== 'string') continue
    if (tokenOf(part.text) !== token) continue
    const carried = idsOf(part.text)
    if (carried.length !== ids.length) return false
    const named = new Set(carried)
    for (const id of ids) if (!named.has(id)) return false
    return true
  }
  return false
}

/**
 * Ask the log whether one pending batch of one session already reached it, and
 * mark it delivered when the answer is yes.
 *
 * The duplicate-delivery window is: the block reached `session.log`, the
 * process exited before the store was written. `inFlight` is memory, so the
 * next boot is amnesiac, the records still read `pending`, and the block is
 * sent a second time. The record carries the batch token it LAST rode
 * ({@link AnnotationStore.requeue} and the pre-step stamp are what put it
 * there), and the log — which outlives the process and is already the thing
 * that decides a delivery — is where the answer is.
 *
 * Two properties are load-bearing, and both are about NOT writing:
 *
 *   - **It only ever moves pending → delivered.** A record whose status is not
 *     `pending` is left alone wherever the caller found it, so this can never
 *     undo what the live path did.
 *   - **A "no" changes nothing at all.** Not finding the block is not evidence
 *     that it was never sent: the log may be unreadable, the block may have
 *     been compacted away, the session may not be persisted yet, the host may
 *     have no query service. Marking a record delivered on any of those would
 *     silently swallow the user's annotation, which is strictly worse than
 *     sending it twice. Every failure path here returns without a write.
 *
 * The ledger is what keeps the answer specific. A token that some delivered
 * record already claims has been settled — and the block carrying it is still
 * in the log, which is exactly the trap: without the gate, the next boot's
 * reconciliation would read that same old block as proof of the NEXT batch. A
 * batch is only ever accepted when its token is neither claimed by a delivered
 * record nor named by a block the log already holds of a batch that is.
 *
 * @param {any} query the `sessionQuery` service, or undefined when this host
 *   has none (a TUI profile, an older host): then nothing is reconciled.
 * @param {AnnotationStore} store a LOADED store.
 * @param {string} sessionId the session about to receive a block.
 * @returns the number of annotations marked delivered.
 */
export async function reconcile(query, store, sessionId) {
  try {
    if (query === null || typeof query !== 'object' || typeof query.readSession !== 'function') return 0
    if (sessionId.length === 0) return 0
    // Nothing to reconcile is the common case and it must not pay for a log
    // read: a session with no pending annotation has no delivery to confirm.
    if (store.pending(sessionId).length === 0) return 0

    // The read is the expensive part and it happens once, however many batches
    // the session has pending (a re-queued one and a fresh one, say); the
    // questions against it are free.
    const snapshot = await query.readSession(sessionId)
    const log = Array.isArray(snapshot?.events) ? snapshot.events : []
    // A fork inherits its parent's events. A block inside that prefix is the
    // PARENT's delivery — this session's own batch tokens are not in it — so it
    // is skipped rather than scanned.
    const from = Number.isInteger(snapshot?.inheritedEventCount) && snapshot.inheritedEventCount > 0
      ? snapshot.inheritedEventCount
      : 0
    const own = log.slice(from)

    // One pass over the SESSION's records, not over the pending ones: the
    // question is not "which pending records share a token" but "is the whole
    // batch of this token pending", and a token whose batch is half-delivered
    // (the live path got part of it before the process died) has no answer this
    // path can give — it is left exactly as it is.
    const batches = new Map()
    for (const record of store.list(sessionId)) {
      const token = asToken(record.batchId)
      if (token === undefined) continue
      const seen = batches.get(token) ?? { all: true, ids: [] }
      seen.ids.push(record.id)
      if (record.status !== 'pending') seen.all = false
      batches.set(token, seen)
    }

    const claimed = store.ledger(sessionId)
    let settled = 0
    for (const [token, batch] of batches) {
      // The ledger gate. A token a delivered record already claims has been
      // settled — and its block is still in the log, which is exactly why this
      // gate exists: without it, the next boot's reconciliation would read that
      // same old block as proof of the NEXT batch.
      if (!batch.all || claimed.has(token)) continue
      if (!own.some((event) => eventIsBlockOf(event, token, batch.ids))) continue
      claimed.add(token)
      const changed = await store.markDelivered(batch.ids, undefined, { batch: token })
      settled += changed.length
    }
    return settled
  } catch (error) {
    // Nothing is marked on a failure, and an unreadable log is not worth
    // failing a turn over: the annotations simply stay pending and ride the
    // next message, which is the behaviour 0.10.2 already had.
    store.logger?.warn?.('dsh-annotate: could not reconcile the previous boot\'s deliveries: %o', error)
    return 0
  }
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
   * Deliveries still waiting for the log to prove them, per session: the rendered
   * block that went into which step, its header line, and the batch token that
   * is the only thing that proves it.
   * @type {Map<string, { ids: string[], block: string, batch: string, turn: number, step: number }>}
   */
  const inFlight = new Map()

  /**
   * The one thing the restart reconciliation needs from the store's logger, so
   * the store can report a failure itself. Passed as a getter because both
   * halves read the same object the plugin was handed.
   */
  store.logger = logger

  /**
   * Read a session's complete raw log, or `undefined` when this host cannot.
   *
   * `sessionQuery` is a public cordis service of the host (the same kind of
   * collaborator as `tools`, `logger` and `webServer`), so it is reached
   * through `ctx.get` and never through an `import`: the host half stays
   * builtin-only so a workspace-installed bundle keeps loading. A host that
   * does not provide it — a TUI profile, an older build — simply has no
   * reconciliation, and {@link reconcile} returns without writing anything.
   *
   * Read through `ctx.get` rather than `ctx.inject(...)` on purpose: injection
   * would make the service a hard dependency of this plugin row, and a host
   * without it would refuse to load the plugin at all instead of loading it
   * without the one ability it cannot provide.
   */
  function sessionQuery() {
    try {
      const value = ctx.get?.('sessionQuery') ?? ctx.reflect?.get?.('sessionQuery')
      return typeof value?.readSession === 'function' ? value : undefined
    } catch {
      return undefined
    }
  }

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
    // proof), and the annotation must stay pending for the user's next message.
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
      // One batch at a time. A live one means the previous block may already
      // be in the log, and injecting it again would duplicate it in the
      // transcript; the step/end below clears it when it demonstrably did not
      // land.
      if (inFlight.has(sessionId)) return decision
      // The previous boot may have died between "the block reached the log" and
      // "the store says delivered" (`inFlight` is memory; a restart is amnesia).
      // This asks the log before deciding to send anything again — see
      // {@link reconcile} for why it only ever moves pending → delivered.
      await reconcile(sessionQuery(), store, sessionId)
      const pending = store.pending(sessionId)
      if (pending.length === 0) return decision
      // A fresh token per block. It is what makes THIS block unmistakable in the
      // log: the header line is decided by the numbers alone and two batches can
      // share it (every session's first batch is `共 1 处，编号 1`), so the token
      // is the only part of the block a comparison may rest on.
      const batch = randomUUID()
      const ids = pending.map((item) => item.id)
      // The stamp goes on BEFORE the block can reach the log, and it is awaited
      // because it is a real write: it is the token that a later boot will ask
      // the log about, so it must be on disk before the block it names can be.
      // A stamp whose block never lands is harmless — those records stay
      // pending, and no log will ever name that token.
      await store.stampBatch(ids, batch)
      const block = renderBlock(pending, numbering(store.list(sessionId)), batch)
      const messages = injectIntoMessages(decision.messages, block, batch)
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
        ids,
        block,
        batch,
        turn: payload?.turn,
        step: payload?.step,
      })
      return { ...decision, messages }
    } catch (error) {
      logger.warn?.('dsh-annotate: delivery failed: %o', error)
      return decision
    }
  })

  /* ---- delivery proof: the log is what makes a block delivered ---- */
  ctx.on('session/event', (session, event) => {
    const sessionId = asId(session?.id)
    if (sessionId.length === 0) return
    const flight = inFlight.get(sessionId)
    if (flight === undefined) return
    if (event?.type === 'user/message') {
      // A block confirms a delivery only when it is THIS plugin's block for
      // THIS batch. Two independent conditions, and BOTH are required:
      //
      //   - the message must carry the plugin's own `source.kind`, which is
      //     what excludes a message that merely quotes the block — the user
      //     pasting it, the model repeating it, a tool result echoing it. Those
      //     have the TEXT but not the source;
      //   - the message must END its text with this batch's token, which is
      //     what excludes another batch's block. The header line cannot do this
      //     job: every session's first batch prints the same
      //     `—— 批注（共 N 处，编号 …）——`, a freed number is reused, and the
      //     string appears 98 times across the sessions on this machine — in
      //     tool results, model replies, and text the user typed themselves.
      //
      // This is the same standard the cold-log leg applies in
      // {@link eventIsBlockOf}, and that is the point: the two must agree. An
      // OR between them would let the weaker one answer alone, and the weaker
      // one would be a substring test on the header line — text that two
      // different batches, and a user's own paste, can both produce. Marking a
      // record delivered on that would swallow the annotation forever, which is
      // worse than any duplicate this file prevents.
      //
      // There is no "either leg" fallback in either direction. A host payload
      // missing `content`, `source` or `data` simply fails to confirm, and the
      // annotation stays pending and rides the next message.
      const provesBlock =
        event?.data?.source?.kind === BLOCK_SOURCE_KIND && messageDefinesToken(event.data, flight.batch)
      if (!provesBlock) return
      inFlight.delete(sessionId)
      // `append` publishes this event synchronously, so the store is already
      // loaded on this path; the fallback covers a listener attached earlier.
      const mark = () => store.markDelivered(flight.ids, flight.turn, { batch: flight.batch })
      const settled = store.loaded ? mark() : store.load().then(mark)
      // Returning the promise does not hold the append up — the event is
      // already in the log, and DSH only contains observer rejections — but it
      // makes "this delivery is persisted" awaitable instead of a guess.
      return settled.catch((error) => {
        logger.warn?.('dsh-annotate: could not record delivery: %o', error)
      })
    }
    // The step (or the whole turn, when the abort lands before the step even
    // started) is over and the proof was never seen: the message was not
    // appended, so those annotations are still unsent. Drop the flight and let
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
      const target = store.state.annotations.find((item) => item.id === id)
      if (target === undefined) throw new Error(`unknown annotation: ${id}`)
      // Re-queued under a NEW batch token, never the one it was delivered
      // under: the old block is still in the log, and a re-queue that kept its
      // token would have the next boot's reconciliation read that block as
      // proof of this new batch (the ledger refuses a token already settled, so
      // nothing is lost — but a batch whose token the ledger refuses can never
      // be reconciled, which is the whole point of minting a fresh one).
      await store.requeue([id], randomUUID())
      const records = store.list(target.sessionId)
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
