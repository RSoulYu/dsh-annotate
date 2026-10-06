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
 *      wire as its own message, right after the user message entering the step,
 *      so the model receives it with the message the user actually sent — no
 *      composer DOM, no draft rewriting. The block is a separate `user/message`
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
 */
const REVISION = 6

const ROUTE_PATH = '/plugins/dsh-annotate/api'
/**
 * `source.kind` of the message that carries the block. Anything other than
 * `user` makes the chat render that message as an injected-context row instead
 * of the user's own bubble, which is the whole point of sending the block as a
 * message of its own.
 */
const BLOCK_SOURCE_KIND = 'dsh-annotate'
const STORE_VERSION = 1
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
  /** @param {string} file absolute path of the JSON document. */
  constructor(file) {
    this.file = file
    this.state = blankState()
    this.loaded = false
    this.loading = undefined
    /** Serializes writes so two concurrent API calls cannot interleave. */
    this.writing = Promise.resolve()
  }

  async load() {
    if (this.loaded) return this.state
    if (this.loading !== undefined) return this.loading
    this.loading = (async () => {
      try {
        const text = await readFile(this.file, 'utf8')
        const parsed = JSON.parse(text)
        const raw = Array.isArray(parsed?.annotations) ? parsed.annotations : []
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
      this.loaded = true
      return this.state
    })()
    return this.loading
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
    const record = normalizeRecord({
      id: `ann-${randomUUID()}`,
      sessionId: input.sessionId,
      quote: input.quote,
      note: input.note,
      origin: input.origin,
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
   * delivery receipt (`deliveredAt`/`deliveredTurn`) is dropped, so the next
   * `agent/pre-step` of that session picks it up again like any other pending
   * annotation. This deliberately does not inject anything itself — injection is
   * the pre-step listener's job, and it is confirmed off the session log.
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
 * Stable per-session numbering: creation order. The panel, the badges and the
 * reply markers all use these numbers, so "Annotation 4" always means the same
 * annotation.
 * @param {Array<any>} records every record of one session.
 * @returns {Map<string, number>}
 */
function numbering(records) {
  const ordered = records.slice().sort((a, b) => a.createdAt - b.createdAt)
  return new Map(ordered.map((record, index) => [record.id, index + 1]))
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
 * the last user message of one step.
 *
 * The user's own message is returned untouched: the block is an additional
 * entry in the list, not extra text on their message. DSH appends every entry
 * of `decision.messages` as its own event, so the block still lands in the log
 * (and therefore still reaches the model), it just stops being part of the
 * words the user typed.
 *
 * @returns the replacement message list, or undefined when nothing applies.
 */
function injectIntoMessages(messages, block) {
  if (!Array.isArray(messages) || messages.length === 0) return undefined
  let index = -1
  // Prefer a genuine user-authored message; fall back to the last user-role one.
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]
    if (message?.role === 'user' && message?.source?.kind === 'user') {
      index = i
      break
    }
  }
  if (index === -1) {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      if (messages[i]?.role === 'user') {
        index = i
        break
      }
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
  const store = new AnnotationStore(storePath())
  const logger = ctx.logger ?? console
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
      if (messages === undefined) return decision
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
