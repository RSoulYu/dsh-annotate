/**
 * dsh-annotate — browser half.
 *
 * Hand-written CommonJS bundle (same shape as the shipped decoration
 * template: `window.__ModuleLoader__.load` + `factory(require)`), no build
 * step. React comes from the browser module table; no Harness Client package
 * is imported.
 *
 * What it owns:
 *
 *   - selecting text anywhere outside the composer opens a one-button
 *     "批注" toolbar in `shell.overlay` (the frame-wide floating layer, which
 *     is click-through, so the button never blocks the app);
 *   - the note editor, the numbered marks (CSS Custom Highlight API, so the
 *     message DOM is never mutated) and the numbered badges;
 *   - clicking a badge opens a small popover with that annotation's quote and
 *     note, so one annotation is readable without leaving the transcript;
 *   - a compact chip in `conversation.input.right` (the composer tool row,
 *     immediately before the submit action) that opens the management panel;
 *   - the panel itself is a right-sidebar page (`sidebar.right.pane.tab`),
 *     revealed through `ctx.sidebarRight.openTab`.
 *
 * Delivery is the host half's job: this half only persists annotations
 * through `POST /plugins/dsh-annotate/api`.
 */

window.__ModuleLoader__.load({
  id: 'dsh-annotate',
  factory(require) {
    'use strict'

    var React = require('react')
    var h = React.createElement

    var API = '/plugins/dsh-annotate/api'
    var HIGHLIGHT_NAME = 'dsa-mark'
    var STYLE_ID = 'dsa-style'
    var POLL_MS = 2000
    /** Quiet period before one re-anchoring pass after the transcript changes. */
    var ANCHOR_DEBOUNCE_MS = 800
    /** Floor between two re-anchoring passes, so a busy transcript cannot thrash it. */
    var ANCHOR_RETRY_MS = 1500
    var TOOLBAR_W = 78
    var TOOLBAR_H = 30
    var EDITOR_W = 340
    var POPOVER_W = 340
    var GAP = 8
    var TAB_ID = 'dsh-annotate'

    /** Handles the sidebar services hand back once they activate. */
    var runtime = { openTab: null }

    /* ------------------------------------------------------------ i18n */

    var ZH = {
      'toolbar.annotate': '批注',
      'editor.title': '添加批注',
      'editor.placeholder': '写下你的批注（可留空，只标记原文）',
      'editor.hint': 'Enter 保存 · Shift+Enter 换行 · Esc 取消',
      'editor.save': '保存',
      'editor.cancel': '取消',
      'chip.label': '批注',
      'chip.title': '打开批注栏（右侧栏）',
      'tab.title': '批注',
      'tab.guide': '查看、编辑、跳回原文或删除本次会话的批注',
      'panel.refresh': '刷新',
      'panel.openSidebar': '在右栏查看',
      'panel.noSidebar': '右侧栏不可用',
      'panel.title': '本会话批注',
      'panel.empty': '还没有批注。在回复里选中要批注的文字，点「批注」即可。',
      'panel.close': '收起',
      'panel.pending': '待发送',
      'panel.delivered': '已送达',
      'panel.origin.user': '我的消息',
      'panel.origin.assistant': '助手回复',
      'panel.noNote': '（未填写批注）',
      'panel.jump': '跳回原文',
      'panel.edit': '编辑',
      'panel.delete': '删除',
      'panel.clearDelivered': '清空已送达',
      'panel.redeliver': '重新投递',
      'panel.copy': '复制',
      'panel.copied': '已复制',
      'panel.hint': '批注会在你发送下一条消息时自动随消息发给我，我会按编号逐条回应。',
      'panel.unanchored': '原文未在视图中',
      'panel.unanchoredHint': '这句原文还没出现在当前加载的消息里。滚动到它所在的回复，高亮与编号徽标会自动出现。',
      'panel.error': '批注服务不可用：',
      'panel.loading': '加载中…',
      'toast.jumpFailed': '原文不在当前视图中',
      'toast.saveFailed': '保存失败',
      'toast.redeliverFailed': '重新投递失败',
    }

    var EN = {
      'toolbar.annotate': 'Annotate',
      'editor.title': 'Add annotation',
      'editor.placeholder': 'Write your annotation (empty = mark the quote only)',
      'editor.hint': 'Enter to save · Shift+Enter for a line break · Esc to cancel',
      'editor.save': 'Save',
      'editor.cancel': 'Cancel',
      'chip.label': 'Annotations',
      'chip.title': 'Open the annotation panel (right sidebar)',
      'tab.title': 'Annotations',
      'tab.guide': 'Review, edit, jump to, or delete this session\u2019s annotations',
      'panel.refresh': 'Refresh',
      'panel.openSidebar': 'Open in sidebar',
      'panel.noSidebar': 'the right sidebar is unavailable',
      'panel.title': 'Annotations in this session',
      'panel.empty': 'No annotations yet. Select text in a reply and press “Annotate”.',
      'panel.close': 'Collapse',
      'panel.pending': 'Pending',
      'panel.delivered': 'Delivered',
      'panel.origin.user': 'Your message',
      'panel.origin.assistant': 'Assistant reply',
      'panel.noNote': '(no note)',
      'panel.jump': 'Jump to source',
      'panel.edit': 'Edit',
      'panel.delete': 'Delete',
      'panel.clearDelivered': 'Clear delivered',
      'panel.redeliver': 'Redeliver',
      'panel.copy': 'Copy',
      'panel.copied': 'Copied',
      'panel.hint': 'Annotations ride the next message you send; the reply answers them by number.',
      'panel.unanchored': 'source not in view',
      'panel.unanchoredHint': 'The quoted message is not loaded yet. Scroll to the reply it came from and the highlight and badge appear on their own.',
      'panel.error': 'Annotation service unavailable: ',
      'panel.loading': 'Loading…',
      'toast.jumpFailed': 'The source text is not in the current view',
      'toast.saveFailed': 'Could not save',
      'toast.redeliverFailed': 'Could not redeliver',
    }

    var t = function (key) {
      return key
    }
    function setTranslator(next) {
      if (typeof next === 'function') t = next
    }
    function tr(key) {
      var value = t(key)
      return typeof value === 'string' && value.length > 0 ? value : key
    }

    /* ----------------------------------------------------------- store */

    var store = {
      sessionId: null,
      annotations: [],
      ranges: Object.create(null),
      loading: false,
      error: null,
      focusId: null,
      popover: null,
      editor: null,
      toolbar: null,
      toast: null,
      scrollTick: 0,
      listeners: new Set(),
    }

    function emit() {
      store.listeners.forEach(function (listener) {
        try {
          listener()
        } catch (error) {
          /* a broken subscriber must not stop the others */
        }
      })
    }

    function useStore() {
      var pair = React.useState(0)
      var bump = pair[1]
      React.useEffect(function () {
        var listener = function () {
          bump(function (n) {
            return n + 1
          })
        }
        store.listeners.add(listener)
        return function () {
          store.listeners.delete(listener)
        }
      }, [])
      return store
    }

    /* -------------------------------------------------------------- api */

    /** Boot payload the host half injects into the served page. */
    function bootConfig() {
      var config = window.__DSH_ANNOTATE__
      return config !== null && typeof config === 'object' ? config : null
    }

    function apiHeaders() {
      // The static marker is the compatibility fence (an older host half only
      // knows it); the per-boot token is what a current host half requires.
      var headers = { 'content-type': 'application/json', 'x-dsh-annotation': '1' }
      var config = bootConfig()
      if (config !== null && typeof config.token === 'string' && config.token.length > 0) {
        headers['x-dsh-annotate-token'] = config.token
      }
      return headers
    }

    function api(payload) {
      return fetch(API, {
        method: 'POST',
        credentials: 'same-origin',
        headers: apiHeaders(),
        body: JSON.stringify(payload),
      })
        .then(function (response) {
          return response.json().catch(function () {
            throw new Error('HTTP ' + response.status)
          })
        })
        .then(function (body) {
          if (!body || body.ok !== true) throw new Error((body && body.error) || 'request failed')
          return body
        })
    }

    function applyResponse(body) {
      if (Array.isArray(body.annotations)) {
        store.annotations = body.annotations
        pruneRanges()
      }
      store.error = null
    }

    function refresh() {
      var sessionId = store.sessionId
      if (sessionId === null) return Promise.resolve()
      store.loading = store.annotations.length === 0
      emit()
      return api({ action: 'list', sessionId: sessionId })
        .then(function (body) {
          if (sessionId !== store.sessionId) return
          applyResponse(body)
          reanchor()
          syncHighlights()
          store.loading = false
          syncPolling()
          emit()
        })
        .catch(function (error) {
          store.loading = false
          store.error = error instanceof Error ? error.message : String(error)
          emit()
        })
    }

    function mutate(payload) {
      return api(payload)
        .then(function (body) {
          applyResponse(body)
          reanchor()
          syncHighlights()
          emit()
          return body
        })
        .catch(function (error) {
          store.error = error instanceof Error ? error.message : String(error)
          emit()
          throw error
        })
    }

    /* ----------------------------------------------------------- polling */

    var pollTimer = null
    var viewportFrame = null

    function needsPolling() {
      if (store.sessionId === null) return false
      return store.annotations.some(function (item) {
        return item.status === 'pending'
      })
    }

    function syncPolling() {
      if (needsPolling()) {
        if (pollTimer === null) pollTimer = setInterval(function () { refresh() }, POLL_MS)
        return
      }
      if (pollTimer !== null) {
        clearInterval(pollTimer)
        pollTimer = null
      }
    }

    /**
     * Point the session-scoped store at one session. Both the chip and the
     * sidebar panel call it, so either one can be the first to mount after a
     * session switch.
     */
    function bindSession(sessionId) {
      if (sessionId === undefined || sessionId === null) return
      if (store.sessionId !== sessionId) {
        store.sessionId = sessionId
        store.annotations = []
        store.ranges = Object.create(null)
        store.focusId = null
        store.popover = null
        store.error = null
        emit()
      }
      refresh()
    }

    /** Focus one annotation in the right column, revealing it if collapsed. */
    function openSidebar(focusId) {
      if (focusId !== undefined && focusId !== null) store.focusId = focusId
      store.popover = null
      emit()
      if (runtime.openTab === null) {
        fail('open sidebar', new Error(tr('panel.noSidebar')))
        return
      }
      try {
        runtime.openTab(TAB_ID)
      } catch (error) {
        fail('open sidebar', error)
      }
    }

    /** Toggle the small note popover that a numbered badge opens. */
    function togglePopover(item) {
      if (store.popover !== null && store.popover.id === item.annotation.id) {
        store.popover = null
        emit()
        return
      }
      var width = POPOVER_W
      var left = Math.max(8, Math.min(item.left, window.innerWidth - width - 8))
      var top = item.top + 22
      if (top + 220 > window.innerHeight) top = Math.max(8, item.top - 228)
      store.popover = { id: item.annotation.id, top: top, left: left }
      emit()
    }

    /* -------------------------------------------------------- anchoring */

    function allNumbers() {
      // Stable numbering: creation order among this session's annotations.
      var ordered = store.annotations.slice().sort(function (a, b) {
        return a.createdAt - b.createdAt
      })
      var numbers = Object.create(null)
      ordered.forEach(function (item, index) {
        numbers[item.id] = Number.isFinite(item.number) && item.number > 0 ? item.number : index + 1
      })
      return numbers
    }

    function pruneRanges() {
      var alive = Object.create(null)
      store.annotations.forEach(function (item) {
        alive[item.id] = true
      })
      Object.keys(store.ranges).forEach(function (id) {
        var range = store.ranges[id]
        if (alive[id] !== true || range.startContainer.isConnected !== true) {
          delete store.ranges[id]
        }
      })
    }

    /* @pure-anchor
     *
     * Quote anchoring core. Kept free of any DOM reference so it can be
     * exercised directly by the test suite: the browser side only builds the
     * segment list and turns the returned offsets back into a Range.
     */

    /** Collapse every whitespace run to one space and trim, like the browser does when it copies a selection. */
    function normalizeQuote(text) {
      return String(text == null ? '' : text).replace(/\s+/g, ' ').trim()
    }

    /**
     * Build a whitespace-normalized haystack over ordered text segments.
     *
     * Every emitted character remembers which segment and offset it came from,
     * so a match can be mapped back to the DOM. Injected separator spaces map to
     * null: a quote never starts or ends on one, and a match that would is
     * skipped rather than mapped to the wrong place.
     *
     * @param segments ordered `{ text }` segments in document order.
     */
    function buildAnchorIndex(segments) {
      var text = ''
      var map = []
      var pendingSpace = false
      var started = false
      for (var s = 0; s < segments.length; s += 1) {
        var segment = String((segments[s] && segments[s].text) || '')
        for (var o = 0; o < segment.length; o += 1) {
          if (/\s/.test(segment.charAt(o))) {
            pendingSpace = started
            continue
          }
          if (pendingSpace) {
            text += ' '
            map.push(null)
            pendingSpace = false
          }
          text += segment.charAt(o)
          map.push({ s: s, o: o })
          started = true
        }
      }
      return { text: text, map: map }
    }

    /**
     * Locate the `wanted`-th (0-based) occurrence of a normalized quote.
     *
     * @param index result of {@link buildAnchorIndex}.
     * @param quote already-normalized quote text.
     * @param wanted occurrence ordinal among equal quotes.
     * @returns `{ start, end }` segment/offset pairs, or null.
     */
    function locateQuote(index, quote, wanted) {
      if (typeof quote !== 'string' || quote.length === 0) return null
      var seen = 0
      var from = 0
      for (;;) {
        var at = index.text.indexOf(quote, from)
        if (at === -1) return null
        var head = index.map[at]
        var tail = index.map[at + quote.length - 1]
        if (head != null && tail != null) {
          if (seen === wanted) return { start: head, end: tail }
          seen += 1
        }
        from = at + 1
      }
    }

    /**
     * Which occurrence (0-based) of its own quote each annotation owns.
     *
     * Two annotations of the same sentence must stay on the two places they were
     * made: the one created first takes the first occurrence, the next one the
     * second, and so on. The table is built over EVERY annotation of the
     * session, not only over the ones whose range is still missing — an
     * annotation that is already anchored has already used up its occurrence,
     * so counting only the unanchored ones would hand a later annotation
     * somebody else's spot (the bug this fixes).
     *
     * Quotes are compared after {@link normalizeQuote}, so a copy that differs
     * only in whitespace still counts as the same sentence. Different quotes
     * never affect each other, and the only annotation of a quote gets 0.
     *
     * @param annotations this session's records, in any order.
     * @returns id → 0-based occurrence ordinal among equal quotes.
     */
    function quoteOccurrences(annotations) {
      var list = Array.isArray(annotations) ? annotations.slice() : []
      // Stable ascending creation order: equal timestamps keep their input order.
      list.sort(function (a, b) {
        return a.createdAt - b.createdAt
      })
      var seen = Object.create(null)
      var occurrences = Object.create(null)
      list.forEach(function (item) {
        var key = normalizeQuote(item.quote)
        var at = seen[key] === undefined ? 0 : seen[key]
        occurrences[item.id] = at
        seen[key] = at + 1
      })
      return occurrences
    }

    /**
     * Which occurrence (0-based) of a quote one position belongs to.
     *
     * This is what the creation flow asks: the selection start is the one
     * moment the place the user meant is known for certain, and the answer is
     * stored with the annotation so re-anchoring never has to guess it again.
     *
     * The rule is "how many occurrences lie entirely before `position`": a
     * position at or inside an occurrence answers with that occurrence's own
     * ordinal, and a position past the end of the last one answers with the
     * total number of occurrences (a caller looking for a locatable ordinal
     * then simply gets a miss, exactly like a quote that is not there at all).
     * Because the comparison is on (segment, offset) — not on the normalized
     * text — a position that falls in whitespace the normalization collapsed
     * behaves like the following character, so a selection that starts on a
     * leading space still lands on the occurrence it was made on.
     *
     * @param index result of {@link buildAnchorIndex}.
     * @param quote the quote, normalized or not ({@link normalizeQuote} is idempotent).
     * @param position `{ s, o }` point in the same coordinates {@link locateQuote} matches.
     * @returns 0-based ordinal; 0 for an empty, malformed or absent quote.
     */
    function occurrenceAt(index, quote, position) {
      var wanted = normalizeQuote(quote)
      if (wanted.length === 0 || position === null || position === undefined) return 0
      var seen = 0
      for (;;) {
        var match = locateQuote(index, wanted, seen)
        if (match === null) return seen
        // The occurrence is still "not over" at `position`: either it contains
        // it or it starts after it. Either way the answer is `seen`.
        if (match.end.s > position.s || (match.end.s === position.s && match.end.o >= position.o)) return seen
        seen += 1
      }
    }

    /**
     * The occurrence an annotation captured when it was created, or null.
     *
     * The field is optional: records written before 0.6.0 do not carry it, and
     * the host half drops anything malformed. Only a finite, non-negative
     * integer counts — a string, a fraction, a negative or `NaN` must fall back
     * to {@link quoteOccurrences} instead of being trusted as a place.
     *
     * @param annotation one client-side record.
     * @returns the stored 0-based ordinal, or null when it must be inferred.
     */
    function storedOccurrence(annotation) {
      var value = annotation === null || annotation === undefined ? undefined : annotation.occurrence
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || Math.floor(value) !== value) return null
      return value
    }

    /**
     * The occurrence each annotation must be located at.
     *
     * A record that captured its own occurrence at creation (0.6.0) is believed:
     * it is the place the user actually selected, so two annotations of one
     * quote made on the same spot both say 0 and both land there, instead of the
     * second one claiming an occurrence that may not exist.
     *
     * Only the records WITHOUT that value are numbered the old way (creation
     * order over equal quotes), and the fallback table is built among those
     * records alone: a record that knows its own occurrence must not use up an
     * ordinal there and push an older record onto the wrong place.
     *
     * @param annotations this session's records, in any order.
     * @returns id → 0-based occurrence ordinal.
     */
    function wantedOccurrences(annotations) {
      var list = Array.isArray(annotations) ? annotations : []
      var wanted = Object.create(null)
      var legacy = []
      list.forEach(function (item) {
        var stored = storedOccurrence(item)
        if (stored === null) legacy.push(item)
        else wanted[item.id] = stored
      })
      var fallback = quoteOccurrences(legacy)
      Object.keys(fallback).forEach(function (id) {
        if (wanted[id] === undefined) wanted[id] = fallback[id]
      })
      return wanted
    }
    /* @pure-anchor-end */

    /** Ordered text segments of the transcript, skipping this plugin's own UI. */
    function collectSegments() {
      var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null)
      var segments = []
      var node = walker.nextNode()
      while (node !== null) {
        if (closestOf(node.parentElement, '[data-dsa-ui]') === null) {
          segments.push({ node: node, text: node.nodeValue || '' })
        }
        node = walker.nextNode()
      }
      return segments
    }

    /** Turn one match back into a live Range, or null when the offsets are stale. */
    function rangeOfMatch(segments, match) {
      var head = segments[match.start.s]
      var tail = segments[match.end.s]
      if (head === undefined || tail === undefined) return null
      var headLength = (head.node.nodeValue || '').length
      var tailLength = (tail.node.nodeValue || '').length
      var range = document.createRange()
      try {
        range.setStart(head.node, Math.min(match.start.o, headLength))
        range.setEnd(tail.node, Math.min(match.end.o + 1, tailLength))
      } catch (error) {
        return null
      }
      return range
    }

    /**
     * Find one quote in the transcript.
     *
     * Unlike a per-node `indexOf`, this matches across node boundaries (a quote
     * that spans `<strong>` or a code span is the common case) and ignores
     * whitespace differences between the copied selection and the rendered text.
     */
    function findQuoteRange(quote, wanted) {
      var segments = collectSegments()
      var match = locateQuote(buildAnchorIndex(segments), normalizeQuote(quote), wanted)
      return match === null ? null : rangeOfMatch(segments, match)
    }

    /**
     * The `{ s, o }` coordinate of one DOM point, in the coordinates
     * {@link buildAnchorIndex} uses.
     *
     * The start of a selection is usually a text node plus an offset; an element
     * container means "between its children" (a selection that begins on a
     * `<strong>` edge, for example), which is the first collected text node at
     * or after that boundary. Returns null when the point is not inside any
     * collected text segment — the caller then has no truth to record.
     */
    function segmentPositionOf(segments, node, offset) {
      if (node === null || node === undefined) return null
      if (node.nodeType === Node.TEXT_NODE) {
        for (var i = 0; i < segments.length; i += 1) {
          if (segments[i].node === node) return { s: i, o: offset }
        }
        return null
      }
      var children = node.childNodes
      var boundary = offset < children.length ? children[offset] : null
      for (var j = 0; j < segments.length; j += 1) {
        var candidate = segments[j].node
        if (boundary === null) {
          if ((node.compareDocumentPosition(candidate) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0) return { s: j, o: 0 }
          continue
        }
        if (
          boundary.contains(candidate) ||
          (boundary.compareDocumentPosition(candidate) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
        ) {
          return { s: j, o: 0 }
        }
      }
      return null
    }

    /**
     * The 0-based occurrence of `quote` that one selection starts on, or null
     * when that cannot be answered.
     *
     * This is the DOM-touching half of the creation-time capture, and it is
     * called while the selection is still live. Null means "no truth available"
     * — the range is gone, or it starts outside the collected transcript text
     * (our own UI, the composer, a node a re-render replaced) — and the caller
     * then stores no occurrence at all, so the legacy creation-order fallback
     * takes over instead of a guessed ordinal being pinned to the record.
     */
    function occurrenceOfRange(quote, range) {
      if (range === null || range === undefined || range.startContainer === undefined) return null
      var segments = collectSegments()
      var index = buildAnchorIndex(segments)
      var position = segmentPositionOf(segments, range.startContainer, range.startOffset)
      if (position === null) return null
      return occurrenceAt(index, quote, position)
    }

    /**
     * Rebuild ranges that were lost (page reload).
     *
     * One index build serves every missing annotation (the old shape walked the
     * whole document once per annotation, which is quadratic on a long
     * transcript), and every annotation is located at {@link wantedOccurrences}'
     * ordinal — the occurrence captured at creation, or the creation-order table
     * for records that predate it — so two annotations of the same sentence land
     * on the two places they were made, whether or not the earlier one still has
     * a live range.
     */
    function reanchor() {
      var added = 0
      var missing = store.annotations
        .slice()
        .sort(function (a, b) {
          return a.createdAt - b.createdAt
        })
        .filter(function (item) {
          var range = store.ranges[item.id]
          return range === undefined || range.startContainer.isConnected !== true
        })
      if (missing.length === 0) return added
      var segments = collectSegments()
      var index = buildAnchorIndex(segments)
      // The ordinal comes from the record itself when it captured one at
      // creation (0.6.0); only records without it are numbered among themselves.
      // An annotation that is already anchored occupies its occurrence either
      // way, so it must not be handed out again to a later annotation.
      var wanted = wantedOccurrences(store.annotations)
      missing.slice(0, 200).forEach(function (item) {
        var key = normalizeQuote(item.quote)
        var ordinal = wanted[item.id]
        var match = locateQuote(index, key, ordinal === undefined ? 0 : ordinal)
        if (match === null) return
        var range = rangeOfMatch(segments, match)
        if (range !== null) {
          store.ranges[item.id] = range
          added += 1
        }
      })
      return added
    }

    /** Whether this annotation currently has a live Range in the loaded transcript. */
    function isAnchored(id) {
      var range = store.ranges[id]
      return range !== undefined && range.startContainer.isConnected === true
    }

    /**
     * Whether any annotation still needs a range.
     *
     * This is the gate for every retry: a fully anchored session (the normal
     * case) costs one array scan and nothing else.
     */
    function needsAnchoring() {
      for (var i = 0; i < store.annotations.length; i += 1) {
        if (!isAnchored(store.annotations[i].id)) return true
      }
      return false
    }

    var anchorRetryTimer = null
    var lastAnchorPassAt = 0

    /**
     * Re-attempt localization after the transcript changes.
     *
     * A quote is only locatable while its message is rendered, and the
     * transcript loads history in pages: after restarting DSH, an annotation on
     * a message that is still above the loaded window has no range until that
     * message appears. Retrying on DOM changes and on scroll is what makes those
     * marks come back on their own instead of only after a manual refresh.
     *
     * Debounced (so streaming keeps postponing one single pass) and rate
     * limited, and it stops by itself as soon as everything is anchored.
     */
    function scheduleAnchorRetry() {
      if (anchorRetryTimer !== null) return
      if (store.sessionId === null || !needsAnchoring()) return
      anchorRetryTimer = setTimeout(function () {
        anchorRetryTimer = null
        var now = Date.now()
        if (now - lastAnchorPassAt < ANCHOR_RETRY_MS) {
          scheduleAnchorRetry()
          return
        }
        lastAnchorPassAt = now
        // Repaint only when something was actually located. An unconditional
        // emit would mutate the DOM, re-arm the observer that scheduled this
        // pass, and spin forever on a quote that is simply not loaded yet.
        if (reanchor() > 0) {
          syncHighlights()
          emit()
        }
      }, ANCHOR_DEBOUNCE_MS)
    }

    function syncHighlights() {
      try {
        if (typeof Highlight === 'undefined' || !window.CSS || !CSS.highlights) return
        var highlight = new Highlight()
        Object.keys(store.ranges).forEach(function (id) {
          var range = store.ranges[id]
          if (range.startContainer.isConnected === true) highlight.add(range)
        })
        if (highlight.size > 0) CSS.highlights.set(HIGHLIGHT_NAME, highlight)
        else CSS.highlights.delete(HIGHLIGHT_NAME)
      } catch (error) {
        /* highlighting is decorative: never break the plugin for it */
      }
    }

    function rangeRect(id) {
      var range = store.ranges[id]
      if (range === undefined || range.startContainer.isConnected !== true) return null
      var rect = range.getBoundingClientRect()
      if (rect.width === 0 && rect.height === 0) return null
      return rect
    }

    function jumpTo(annotation) {
      var rect = rangeRect(annotation.id)
      var range = store.ranges[annotation.id]
      if (rect === null || range === undefined) {
        // Fall back to THIS annotation's own occurrence (the one captured at
        // creation, or the creation-order table for older records), not the
        // first one: with two annotations of the same sentence, always
        // occurrence 0 would jump the second one to the first one's text.
        var ordinal = wantedOccurrences(store.annotations)[annotation.id]
        range = findQuoteRange(annotation.quote, ordinal === undefined ? 0 : ordinal)
        if (range === null) {
          showToast(tr('toast.jumpFailed'))
          return
        }
        store.ranges[annotation.id] = range
        rect = range.getBoundingClientRect()
      }
      var element = range.startContainer.parentElement
      if (element !== null) element.scrollIntoView({ block: 'center', behavior: 'smooth' })
      syncHighlights()
      emit()
    }

    function showToast(message) {
      store.toast = { message: message, at: Date.now() }
      emit()
      setTimeout(function () {
        if (store.toast !== null && Date.now() - store.toast.at >= 1400) {
          store.toast = null
          emit()
        }
      }, 2600)
    }

    /** Report a failure instead of swallowing it. */
    function fail(label, error) {
      var message = error && error.message ? error.message : String(error)
      console.error('[dsh-annotate] ' + label + ': ' + message, error)
      showToast('批注插件出错：' + message)
    }

    /** Wrap an event handler so a throw becomes a visible toast, not silence. */
    function guard(label, handler) {
      return function () {
        try {
          return handler.apply(null, arguments)
        } catch (error) {
          fail(label, error)
          return undefined
        }
      }
    }

    /**
     * Render-error boundary: a crashing entry would otherwise leave the slot
     * blank with nothing but a console line, which is exactly the failure mode
     * this plugin exists to avoid.
     */
    class Boundary extends React.Component {
      constructor(props) {
        super(props)
        this.state = { error: null }
      }
      static getDerivedStateFromError(error) {
        return { error: error }
      }
      componentDidCatch(error) {
        console.error('[dsh-annotate] ' + this.props.label + ' crashed', error)
      }
      render() {
        if (this.state.error !== null) {
          var message = this.state.error && this.state.error.message ? this.state.error.message : String(this.state.error)
          return h(
            'div',
            {
              'data-dsa-ui': 'error',
              style: {
                padding: '6px 10px',
                border: '1px solid var(--dsw-alias-state-error-primary)',
                borderRadius: '8px',
                color: 'var(--dsw-alias-state-error-primary)',
                font: CHIP_FONT,
              },
            },
            '批注插件出错：' + message,
          )
        }
        return this.props.children
      }
    }

    /* -------------------------------------------------------- selection */

    function closestOf(element, selector) {
      if (element === null || element === undefined) return null
      if (typeof element.closest !== 'function') return null
      try {
        return element.closest(selector)
      } catch (error) {
        return null
      }
    }

    function selectionContext() {
      var selection = window.getSelection()
      if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null
      var text = selection.toString()
      if (typeof text !== 'string' || text.trim().length === 0) return null
      var range = selection.getRangeAt(0)
      var node = range.commonAncestorContainer
      var element = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement
      if (element === null || element === undefined) return null
      // Never react to the composer, form fields, our own UI, or the app
      // chrome around the transcript (sidebar, header, menus, dialogs).
      if (
        closestOf(
          element,
          '[data-dsa-ui], input, textarea, [contenteditable="true"], [contenteditable=""], ' +
            'nav, aside, header, footer, button, [role="navigation"], [role="menu"], [role="dialog"], [role="tablist"]',
        ) !== null
      ) {
        return null
      }
      var rect = range.getBoundingClientRect()
      if (rect.width === 0 && rect.height === 0) return null
      var trimmed = text.trim()
      var quote = trimmed.length > 2000 ? trimmed.slice(0, 2000) : trimmed
      return {
        quote: quote,
        range: range,
        rect: rect,
        origin: guessOrigin(element),
      }
    }

    function guessOrigin(element) {
      // The user's own bubbles are the ones that carry the hover timestamp root
      // and no assistant class; fall back to the assistant side when the host
      // markup does not say.
      var row = closestOf(element, '[data-time-hover-root]')
      if (row !== null && row.querySelector('[class*="assistant"]') === null) return 'user'
      return 'assistant'
    }

    function toolbarGeometry(rect) {
      var top = rect.top - TOOLBAR_H - GAP
      if (top < 8) top = Math.min(rect.bottom + GAP, window.innerHeight - TOOLBAR_H - 8)
      var left = rect.left + rect.width / 2 - TOOLBAR_W / 2
      left = Math.max(8, Math.min(left, window.innerWidth - TOOLBAR_W - 8))
      return { top: Math.max(8, top), left: left }
    }

    function editorGeometry(rect) {
      var height = 190
      var fallback = { top: Math.round(window.innerHeight / 3), left: Math.round((window.innerWidth - EDITOR_W) / 2) }
      if (rect === null || rect === undefined) return fallback
      var top = rect.bottom + GAP
      if (top + height > window.innerHeight - 8) top = Math.max(8, rect.top - height - GAP)
      var left = Math.max(8, Math.min(rect.left, window.innerWidth - EDITOR_W - 8))
      return { top: top, left: left }
    }

    function openEditor(context) {
      if (context === null || context === undefined) return
      var quote = typeof context.quote === 'string' ? context.quote : ''
      var range = context.range ?? null
      store.editor = {
        quote: quote,
        range: range,
        origin: context.origin === 'user' ? 'user' : 'assistant',
        geometry: editorGeometry(context.rect),
        value: '',
        // Capture which occurrence of the quote this selection is while it is
        // still live: a streaming re-render between opening this editor and
        // saving it can detach the nodes the Range points at, and the position
        // is not answerable any more. null = unknown, and then no occurrence is
        // persisted for the record.
        occurrence: occurrenceOfRange(quote, range),
      }
      store.toolbar = null
      emit()
    }

    function closeEditor() {
      if (store.editor === null) return
      store.editor = null
      emit()
    }

    function saveEditor(note) {
      var editor = store.editor
      if (editor === null) return
      var range = editor.range
      var quote = editor.quote
      var origin = editor.origin
      // The occurrence to persist: the one captured when the editor opened (the
      // live selection is the one moment the place is known for certain), plus a
      // last chance here for the cases where that capture could not resolve and
      // the retained Range happens to still be live. A value that is not a finite
      // non-negative integer is sent as nothing at all, so the client half falls
      // back to the legacy creation-order table and no guessed ordinal is ever
      // pinned to the record. Computed BEFORE the editor closes, while the
      // selection is still available.
      var occurrence = editor.occurrence
      if (occurrence === null || occurrence === undefined) occurrence = occurrenceOfRange(quote, range)
      var stored = Number.isInteger(occurrence) && occurrence >= 0 ? occurrence : undefined
      closeEditor()
      if (store.sessionId === null) return
      mutate({
        action: 'create',
        sessionId: store.sessionId,
        annotation: {
          sessionId: store.sessionId,
          quote: quote,
          note: note,
          origin: origin,
          occurrence: stored,
        },
      }).then(function (body) {
        var created = body.annotation
        if (created !== undefined && range !== null) {
          store.ranges[created.id] = range
          syncHighlights()
          emit()
        }
      }).catch(function () {
        showToast(tr('toast.saveFailed'))
      })
      try {
        window.getSelection().removeAllRanges()
      } catch (error) {
        /* ignore */
      }
    }

    function onSelectionSettle() {
      if (store.editor !== null) return
      var context = selectionContext()
      if (context === null) {
        if (store.toolbar !== null) {
          store.toolbar = null
          emit()
        }
        return
      }
      store.toolbar = {
        quote: context.quote,
        range: context.range,
        origin: context.origin,
        rect: context.rect,
        geometry: toolbarGeometry(context.rect),
      }
      emit()
    }

    function onDocumentMouseDown(event) {
      var target = event.target
      if (closestOf(target, '[data-dsa-ui]') !== null) return
      if (store.popover !== null) store.popover = null
      if (store.editor !== null) closeEditor()
      if (store.toolbar !== null) {
        store.toolbar = null
        emit()
      }
    }

    function onViewportChange() {
      if (viewportFrame !== null) return
      viewportFrame = window.requestAnimationFrame(function () {
        viewportFrame = null
        store.scrollTick += 1
        // The popover is anchored to viewport coordinates: scrolling or
        // resizing would leave it pointing at nothing.
        store.popover = null
        emit()
        // Scrolling can bring the annotated message into the DOM.
        scheduleAnchorRetry()
      })
    }

    /* --------------------------------------------------------- rendering */

    var FONT = '13px/1.5 system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif'
    var CHIP_FONT = '12px/1.4 system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif'

    function stylesheet() {
      return [
        '::highlight(' + HIGHLIGHT_NAME + ') {',
        '  background-color: color-mix(in srgb, var(--dsw-alias-brand-primary) 22%, transparent);',
        '}',
        '[data-dsa-ui] { box-sizing: border-box; }',
        '[data-dsa-ui] * { box-sizing: border-box; }',
      ].join('\n')
    }

    function badgeList() {
      var numbers = allNumbers()
      var items = []
      store.annotations.forEach(function (annotation) {
        var rect = rangeRect(annotation.id)
        if (rect === null) return
        if (rect.bottom < -40 || rect.top > window.innerHeight + 40) return
        items.push({
          annotation: annotation,
          number: numbers[annotation.id],
          top: Math.max(2, rect.top - 9),
          left: Math.max(2, rect.left - 11),
          pending: annotation.status === 'pending',
        })
      })
      return items
    }

    function Badges() {
      useStore()
      var items = badgeList()
      if (items.length === 0) return null
      return h(
        'div',
        { 'data-dsa-ui': 'badges', style: { position: 'fixed', inset: 0, pointerEvents: 'none', zIndex: 2147483000 } },
        items.map(function (item) {
          return h(
            'button',
            {
              key: item.annotation.id,
              type: 'button',
              title: (item.pending ? tr('panel.pending') : tr('panel.delivered')) + ' · ' + item.annotation.quote.slice(0, 120),
              onClick: guard('toggle note popover', function () {
                togglePopover(item)
              }),
              style: {
                position: 'fixed',
                top: item.top + 'px',
                left: item.left + 'px',
                pointerEvents: 'auto',
                width: '18px',
                height: '18px',
                padding: 0,
                border: '1px solid var(--dsw-alias-bg-base)',
                borderRadius: '9px',
                font: '600 10px/1 system-ui, sans-serif',
                color: '#fff',
                cursor: 'pointer',
                background: item.pending ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-state-idle-primary)',
                boxShadow: '0 1px 3px rgba(0,0,0,.25)',
              },
            },
            String(item.number),
          )
        }),
      )
    }

    function SelectionToolbar() {
      useStore()
      var toolbar = store.toolbar
      if (toolbar === null) return null
      return h(
        'div',
        {
          'data-dsa-ui': 'toolbar',
          style: { position: 'fixed', top: toolbar.geometry.top + 'px', left: toolbar.geometry.left + 'px', zIndex: 2147483001 },
        },
        h(
          'button',
          {
            type: 'button',
            onMouseDown: function (event) {
              event.preventDefault()
            },
            onClick: guard('open editor', function () {
              openEditor(toolbar)
            }),
            style: {
              width: TOOLBAR_W + 'px',
              height: TOOLBAR_H + 'px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '5px',
              border: '1px solid var(--dsw-alias-border-l2)',
              borderRadius: '8px',
              background: 'var(--dsw-alias-bg-overlay)',
              color: 'var(--dsw-alias-label-primary)',
              font: CHIP_FONT,
              cursor: 'pointer',
              boxShadow: '0 4px 14px rgba(0,0,0,.18)',
            },
          },
          h('span', { 'aria-hidden': 'true', style: { fontSize: '12px' } }, '✎'),
          tr('toolbar.annotate'),
        ),
      )
    }

    function NoteEditor() {
      useStore()
      var editor = store.editor
      var key = editor === null ? '' : editor.quote + '|' + editor.geometry.top
      var valuePair = React.useState('')
      var value = valuePair[0]
      var setValue = valuePair[1]
      React.useEffect(
        function () {
          setValue('')
        },
        [key],
      )
      if (editor === null) return null
      var commit = guard('save annotation', function () {
        saveEditor(value.trim())
      })
      return h(
        'div',
        {
          'data-dsa-ui': 'editor',
          style: {
            position: 'fixed',
            top: editor.geometry.top + 'px',
            left: editor.geometry.left + 'px',
            width: EDITOR_W + 'px',
            zIndex: 2147483002,
            display: 'flex',
            flexDirection: 'column',
            gap: '8px',
            padding: '10px',
            border: '1px solid var(--dsw-alias-border-l2)',
            borderRadius: '10px',
            background: 'var(--dsw-alias-bg-overlay)',
            color: 'var(--dsw-alias-label-primary)',
            boxShadow: '0 10px 30px rgba(0,0,0,.22)',
            font: FONT,
          },
        },
        h('div', { style: { font: '600 12px/1.4 system-ui, sans-serif' } }, tr('editor.title')),
        h(
          'div',
          {
            style: {
              maxHeight: '52px',
              overflow: 'hidden',
              padding: '6px 8px',
              borderLeft: '3px solid var(--dsw-alias-brand-primary)',
              borderRadius: '4px',
              background: 'var(--dsw-alias-bg-layer-2)',
              color: 'var(--dsw-alias-label-secondary)',
              font: FONT,
            },
          },
          editor.quote.slice(0, 160) + (editor.quote.length > 160 ? '…' : ''),
        ),
        h('textarea', {
          autoFocus: true,
          value: value,
          placeholder: tr('editor.placeholder'),
          onChange: function (event) {
            setValue(event.target.value)
          },
          onKeyDown: function (event) {
            if (event.key === 'Escape') {
              event.preventDefault()
              event.stopPropagation()
              closeEditor()
              return
            }
            if (event.key === 'Enter' && event.shiftKey !== true) {
              event.preventDefault()
              event.stopPropagation()
              commit()
            }
          },
          style: {
            width: '100%',
            minHeight: '64px',
            resize: 'vertical',
            padding: '7px 8px',
            border: '1px solid var(--dsw-alias-border-l1)',
            borderRadius: '7px',
            background: 'var(--dsw-alias-bg-layer-1)',
            color: 'var(--dsw-alias-label-primary)',
            font: FONT,
            outline: 'none',
          },
        }),
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
          h(
            'button',
            {
              type: 'button',
              onClick: commit,
              style: {
                padding: '5px 14px',
                border: 'none',
                borderRadius: '7px',
                background: 'var(--dsw-alias-brand-primary)',
                color: '#fff',
                font: '600 12px/1.4 system-ui, sans-serif',
                cursor: 'pointer',
              },
            },
            tr('editor.save'),
          ),
          h(
            'button',
            {
              type: 'button',
              onClick: closeEditor,
              style: {
                padding: '5px 12px',
                border: '1px solid var(--dsw-alias-border-l1)',
                borderRadius: '7px',
                background: 'transparent',
                color: 'var(--dsw-alias-label-secondary)',
                font: '12px/1.4 system-ui, sans-serif',
                cursor: 'pointer',
              },
            },
            tr('editor.cancel'),
          ),
          h('span', { style: { color: 'var(--dsw-alias-label-secondary)', font: '11px/1.4 system-ui, sans-serif' } }, tr('editor.hint')),
        ),
      )
    }

    function Toast() {
      useStore()
      if (store.toast === null) return null
      return h(
        'div',
        {
          'data-dsa-ui': 'toast',
          style: {
            position: 'fixed',
            bottom: '96px',
            left: '50%',
            transform: 'translateX(-50%)',
            padding: '6px 14px',
            border: '1px solid var(--dsw-alias-border-l1)',
            borderRadius: '999px',
            background: 'var(--dsw-alias-bg-overlay)',
            color: 'var(--dsw-alias-label-primary)',
            font: CHIP_FONT,
            boxShadow: '0 6px 20px rgba(0,0,0,.18)',
            zIndex: 2147483003,
            pointerEvents: 'none',
          },
        },
        store.toast.message,
      )
    }

    function Overlay() {
      useStore()
      void store.scrollTick
      return h(
        Boundary,
        { label: 'overlay' },
        h(
          'div',
          { 'data-dsa-ui': 'overlay', style: { display: 'contents' } },
          h('style', null, stylesheet()),
          h(Badges, null),
          h(SelectionToolbar, null),
          h(NoteEditor, null),
          h(BadgePopover, null),
          h(Toast, null),
        ),
      )
    }

    /* --------------------------------------------------------- dock panel */

    function StatusPill(props) {
      var pending = props.status === 'pending'
      return h(
        'span',
        {
          style: {
            padding: '1px 7px',
            borderRadius: '999px',
            border: '1px solid ' + (pending ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-border-l1)'),
            color: pending ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-label-secondary)',
            font: '11px/1.6 system-ui, sans-serif',
            whiteSpace: 'nowrap',
          },
        },
        pending ? tr('panel.pending') : tr('panel.delivered'),
      )
    }

    function smallButton(label, onClick, tone) {
      return h(
        'button',
        {
          type: 'button',
          onClick: onClick,
          style: {
            padding: '3px 9px',
            border: '1px solid var(--dsw-alias-border-l1)',
            borderRadius: '6px',
            background: 'transparent',
            color: tone === 'danger' ? 'var(--dsw-alias-state-error-primary)' : 'var(--dsw-alias-label-secondary)',
            font: '11px/1.5 system-ui, sans-serif',
            cursor: 'pointer',
            whiteSpace: 'nowrap',
          },
        },
        label,
      )
    }

    /**
     * Put one already-delivered annotation back in the queue.
     *
     * The host only flips the persisted status; the block rides the next message
     * of the session again. `mutate` applies the returned session list, so the
     * row turns back into 待发送 — and since a pending annotation restarts the
     * poller, it follows the host's delivery confirmation on its own. A failure
     * is reported instead of swallowed.
     */
    function redeliverAnnotation(annotation) {
      mutate({ action: 'redeliver', id: annotation.id, sessionId: store.sessionId }).catch(function () {
        showToast(tr('toast.redeliverFailed'))
      })
    }

    function AnnotationRow(props) {
      var annotation = props.annotation
      var number = props.number
      var focused = props.focused === true
      var rowRef = React.useRef(null)
      React.useEffect(
        function () {
          var node = rowRef.current
          if (focused && node !== null && typeof node.scrollIntoView === 'function') {
            node.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
          }
        },
        [focused],
      )
      var editingPair = React.useState(false)
      var editing = editingPair[0]
      var setEditing = editingPair[1]
      var draftPair = React.useState(annotation.note)
      var draft = draftPair[0]
      var setDraft = draftPair[1]
      var copiedPair = React.useState(false)
      var copied = copiedPair[0]
      var setCopied = copiedPair[1]

      var save = function () {
        setEditing(false)
        mutate({ action: 'update', id: annotation.id, patch: { note: draft } }).catch(function () {
          showToast(tr('toast.saveFailed'))
        })
      }

      return h(
        'div',
        {
          ref: rowRef,
          style: {
            display: 'flex',
            gap: '9px',
            padding: '8px 10px',
            border: '1px solid ' + (focused ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-border-l1)'),
            borderRadius: '9px',
            background: 'var(--dsw-alias-bg-layer-1)',
          },
        },
        h(
          'div',
          {
            style: {
              flex: '0 0 auto',
              width: '18px',
              height: '18px',
              marginTop: '1px',
              borderRadius: '9px',
              background: annotation.status === 'pending' ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-state-idle-primary)',
              color: '#fff',
              font: '600 10px/18px system-ui, sans-serif',
              textAlign: 'center',
            },
          },
          String(number),
        ),
        h(
          'div',
          { style: { flex: '1 1 auto', minWidth: 0, display: 'flex', flexDirection: 'column', gap: '5px' } },
          h(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' } },
            h(StatusPill, { status: annotation.status }),
            h('span', { style: { color: 'var(--dsw-alias-label-secondary)', font: '11px/1.6 system-ui, sans-serif' } },
              annotation.origin === 'user' ? tr('panel.origin.user') : tr('panel.origin.assistant')),
            h('span', { style: { flex: '1 1 auto' } }),
            smallButton(copied ? tr('panel.copied') : tr('panel.copy'), function () {
              var write = navigator.clipboard && navigator.clipboard.writeText
              if (write) {
                write.call(navigator.clipboard, annotation.quote).then(function () {
                  setCopied(true)
                  setTimeout(function () { setCopied(false) }, 1500)
                }).catch(function () {})
              }
            }),
            isAnchored(annotation.id)
              ? null
              : h('span', {
                  style: {
                    color: 'var(--dsw-alias-label-secondary)',
                    font: '11px/1.6 system-ui, sans-serif',
                    whiteSpace: 'nowrap',
                  },
                  title: tr('panel.unanchoredHint'),
                }, tr('panel.unanchored')),
            smallButton(tr('panel.jump'), guard('jump to source', function () { jumpTo(annotation) })),
            annotation.status === 'delivered'
              ? smallButton(
                  tr('panel.redeliver'),
                  guard('redeliver annotation', function () { redeliverAnnotation(annotation) }),
                )
              : null,
            smallButton(tr('panel.edit'), function () {
              setDraft(annotation.note)
              setEditing(!editing)
            }),
            smallButton(tr('panel.delete'), function () {
              mutate({ action: 'delete', id: annotation.id, sessionId: store.sessionId }).catch(function () {})
            }, 'danger'),
          ),
          h(
            'div',
            {
              style: {
                padding: '5px 7px',
                borderLeft: '3px solid var(--dsw-alias-border-l2)',
                color: 'var(--dsw-alias-label-secondary)',
                font: FONT,
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                maxHeight: '76px',
                overflow: 'auto',
              },
            },
            annotation.quote.length > 400 ? annotation.quote.slice(0, 400) + '…' : annotation.quote,
          ),
          editing
            ? h(
                'div',
                { style: { display: 'flex', flexDirection: 'column', gap: '6px' } },
                h('textarea', {
                  autoFocus: true,
                  value: draft,
                  onChange: function (event) { setDraft(event.target.value) },
                  onKeyDown: function (event) {
                    if (event.key === 'Enter' && event.shiftKey !== true) {
                      event.preventDefault()
                      save()
                    }
                    if (event.key === 'Escape') {
                      event.preventDefault()
                      setEditing(false)
                    }
                  },
                  style: {
                    width: '100%',
                    minHeight: '52px',
                    padding: '6px 8px',
                    border: '1px solid var(--dsw-alias-border-l1)',
                    borderRadius: '7px',
                    background: 'var(--dsw-alias-bg-base)',
                    color: 'var(--dsw-alias-label-primary)',
                    font: FONT,
                    outline: 'none',
                  },
                }),
                h(
                  'div',
                  { style: { display: 'flex', gap: '6px' } },
                  smallButton(tr('editor.save'), save),
                  smallButton(tr('editor.cancel'), function () { setEditing(false) }),
                ),
              )
            : h(
                'div',
                {
                  style: {
                    color: annotation.note.length > 0 ? 'var(--dsw-alias-label-primary)' : 'var(--dsw-alias-label-secondary)',
                    font: FONT,
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                  },
                },
                annotation.note.length > 0 ? annotation.note : tr('panel.noNote'),
              ),
        ),
      )
    }

    /* ---------------------------------------------------- popover + tab */

    /** The note popover a numbered badge opens: read one annotation in place. */
    function BadgePopover() {
      useStore()
      var popover = store.popover
      if (popover === null) return null
      var annotation = null
      for (var i = 0; i < store.annotations.length; i += 1) {
        if (store.annotations[i].id === popover.id) { annotation = store.annotations[i]; break }
      }
      if (annotation === null) return null
      var numbers = allNumbers()
      return h(
        'div',
        {
          'data-dsa-ui': 'popover',
          style: {
            position: 'fixed',
            top: popover.top + 'px',
            left: popover.left + 'px',
            width: POPOVER_W + 'px',
            zIndex: 2147483002,
            display: 'flex',
            flexDirection: 'column',
            gap: '7px',
            padding: '10px',
            border: '1px solid var(--dsw-alias-border-l2)',
            borderRadius: '10px',
            background: 'var(--dsw-alias-bg-overlay)',
            color: 'var(--dsw-alias-label-primary)',
            boxShadow: '0 10px 30px rgba(0,0,0,.22)',
            font: FONT,
          },
        },
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: '6px' } },
          h('span', { style: { font: '600 12px/1.4 system-ui, sans-serif' } }, '#' + numbers[annotation.id]),
          h(StatusPill, { status: annotation.status }),
          h('span', { style: { color: 'var(--dsw-alias-label-secondary)', font: '11px/1.6 system-ui, sans-serif' } },
            annotation.origin === 'user' ? tr('panel.origin.user') : tr('panel.origin.assistant')),
          h('span', { style: { flex: '1 1 auto' } }),
          smallButton('✕', function () {
            store.popover = null
            emit()
          }),
        ),
        h(
          'div',
          {
            style: {
              maxHeight: '90px',
              overflow: 'auto',
              padding: '5px 7px',
              borderLeft: '3px solid var(--dsw-alias-border-l2)',
              color: 'var(--dsw-alias-label-secondary)',
              font: FONT,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
            },
          },
          annotation.quote,
        ),
        h(
          'div',
          {
            style: {
              color: annotation.note.length > 0 ? 'var(--dsw-alias-label-primary)' : 'var(--dsw-alias-label-secondary)',
              font: FONT,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
            },
          },
          annotation.note.length > 0 ? annotation.note : tr('panel.noNote'),
        ),
        h(
          'div',
          { style: { display: 'flex', gap: '6px' } },
          smallButton(tr('panel.jump'), guard('jump to source', function () { jumpTo(annotation) })),
          smallButton(tr('panel.openSidebar'), guard('open sidebar', function () { openSidebar(annotation.id) })),
          annotation.status === 'delivered'
            ? smallButton(
                tr('panel.redeliver'),
                guard('redeliver annotation', function () { redeliverAnnotation(annotation) }),
              )
            : null,
          smallButton(tr('panel.delete'), guard('delete annotation', function () {
            mutate({ action: 'delete', id: annotation.id, sessionId: store.sessionId }).catch(function () {})
          }), 'danger'),
        ),
      )
    }

    /** Guide/tab glyph: a speech bubble with two lines. */
    function TabIcon(props) {
      var size = props && Number.isFinite(props.size) ? props.size : 16
      return h(
        'svg',
        {
          viewBox: '0 0 16 16',
          width: size,
          height: size,
          className: props ? props.className : undefined,
          'aria-hidden': 'true',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.4,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        },
        h('path', { d: 'M2.5 3.5h11v7H8L5 13.5V10.5H2.5z' }),
        h('path', { d: 'M5.2 6.2h5.6M5.2 8.2h3.4' }),
      )
    }

    /* ------------------------------------------------- chip + sidebar body */

    /** Compact chip in the composer tool row, right before Send. */
    function Chip(props) {
      useStore()
      var sessionId = props.sessionId
      React.useEffect(function () { bindSession(sessionId) }, [sessionId])
      React.useEffect(function () { syncPolling() })
      if (sessionId === undefined || sessionId === null) return null
      if (store.annotations.length === 0 && store.error === null) return null
      var pending = store.annotations.filter(function (item) { return item.status === 'pending' }).length
      return h(
        'button',
        {
          type: 'button',
          title: tr('chip.title'),
          'aria-label': tr('chip.title'),
          onClick: guard('open sidebar', function () { openSidebar(null) }),
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            gap: '4px',
            height: '24px',
            padding: '0 8px',
            border: '1px solid ' + (pending > 0 ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-border-l1)'),
            borderRadius: '999px',
            background: pending > 0 ? 'color-mix(in srgb, var(--dsw-alias-brand-primary) 12%, transparent)' : 'transparent',
            color: pending > 0 ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-label-secondary)',
            font: CHIP_FONT,
            cursor: 'pointer',
            whiteSpace: 'nowrap',
          },
        },
        h('span', { 'aria-hidden': 'true' }, '✎'),
        pending > 0 ? '×' + pending : String(store.annotations.length),
      )
    }

    /** The right column body: every annotation of this session, managed. */
    function AnnotationPanel(props) {
      useStore()
      var sessionId = props.sessionId
      React.useEffect(function () { bindSession(sessionId) }, [sessionId])
      React.useEffect(function () { syncPolling() })
      if (sessionId === undefined || sessionId === null) return null
      var numbers = allNumbers()
      var ordered = store.annotations.slice().sort(function (a, b) { return a.createdAt - b.createdAt })
      var hasDelivered = ordered.some(function (item) { return item.status === 'delivered' })
      return h(
        'div',
        {
          'data-dsa-ui': 'panel',
          style: {
            display: 'flex',
            flexDirection: 'column',
            gap: '8px',
            height: '100%',
            minHeight: '0',
            overflow: 'auto',
            padding: '12px',
            font: FONT,
            color: 'var(--dsw-alias-label-primary)',
          },
        },
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' } },
          h('strong', { style: { font: '600 13px/1.5 system-ui, sans-serif' } }, tr('panel.title')),
          h('span', { style: { color: 'var(--dsw-alias-label-secondary)', font: '11px/1.5 system-ui, sans-serif' } }, String(ordered.length)),
          h('span', { style: { flex: '1 1 auto' } }),
          hasDelivered
            ? smallButton(tr('panel.clearDelivered'), function () {
                mutate({ action: 'clear-delivered', sessionId: store.sessionId }).catch(function () {})
              })
            : null,
          smallButton(tr('panel.refresh'), guard('refresh', function () { refresh() })),
        ),
        store.error !== null
          ? h('div', { style: { color: 'var(--dsw-alias-state-error-primary)', font: FONT } }, tr('panel.error') + store.error)
          : null,
        ordered.length === 0
          ? h('div', { style: { color: 'var(--dsw-alias-label-secondary)', font: FONT } }, tr('panel.empty'))
          : h(
              'div',
              { style: { display: 'flex', flexDirection: 'column', gap: '7px' } },
              ordered.map(function (annotation) {
                return h(AnnotationRow, {
                  key: annotation.id,
                  annotation: annotation,
                  number: numbers[annotation.id],
                  focused: store.focusId === annotation.id,
                })
              }),
            ),
        h('div', { style: { color: 'var(--dsw-alias-label-secondary)', font: '11px/1.5 system-ui, sans-serif' } }, tr('panel.hint')),
      )
    }

    /* -------------------------------------------------------------- apply */

    function ensureStyle() {
      if (document.getElementById(STYLE_ID) !== null) return
      var style = document.createElement('style')
      style.id = STYLE_ID
      style.textContent = stylesheet()
      document.head.appendChild(style)
    }

    function apply(ctx) {
      ctx.effect(function () {
        var disposeZh = ctx.locale.register('dsh-annotate', 'zh', ZH)
        var disposeEn = ctx.locale.register('dsh-annotate', 'en', EN)
        setTranslator(ctx.locale.bind('dsh-annotate'))
        emit()
        var unsubscribe = ctx.locale.subscribe(function () {
          setTranslator(ctx.locale.bind('dsh-annotate'))
          emit()
        })
        return function () {
          unsubscribe()
          disposeEn()
          disposeZh()
        }
      }, 'dsh-annotate: locale dictionaries')

      ctx.effect(function () {
        ensureStyle()
        return function () {
          var style = document.getElementById(STYLE_ID)
          if (style !== null) style.remove()
        }
      }, 'dsh-annotate: stylesheet')

      ctx.effect(function () {
        var settle = function () {
          onSelectionSettle()
        }
        var mouseDown = function (event) {
          onDocumentMouseDown(event)
        }
        var keyDown = function (event) {
          if (event.key === 'Escape' && store.popover !== null) {
            store.popover = null
            emit()
          }
        }
        var viewport = function () {
          onViewportChange()
        }
        var visibility = function () {
          if (document.visibilityState === 'visible') refresh()
        }
        // Older history and re-rendered messages arrive as DOM changes; watching
        // them is what lets a stale annotation find its quote again.
        var observer = null
        if (typeof MutationObserver === 'function') {
          observer = new MutationObserver(function () {
            scheduleAnchorRetry()
          })
          observer.observe(document.body, { childList: true, subtree: true })
        }
        document.addEventListener('mouseup', settle, true)
        document.addEventListener('keyup', settle, true)
        document.addEventListener('mousedown', mouseDown, true)
        document.addEventListener('keydown', keyDown, true)
        window.addEventListener('scroll', viewport, true)
        window.addEventListener('resize', viewport)
        window.addEventListener('focus', visibility)
        document.addEventListener('visibilitychange', visibility)
        return function () {
          document.removeEventListener('mouseup', settle, true)
          document.removeEventListener('keyup', settle, true)
          document.removeEventListener('mousedown', mouseDown, true)
          document.removeEventListener('keydown', keyDown, true)
          window.removeEventListener('scroll', viewport, true)
          window.removeEventListener('resize', viewport)
          window.removeEventListener('focus', visibility)
          document.removeEventListener('visibilitychange', visibility)
          if (pollTimer !== null) {
            clearInterval(pollTimer)
            pollTimer = null
          }
          if (observer !== null) observer.disconnect()
          if (anchorRetryTimer !== null) {
            clearTimeout(anchorRetryTimer)
            anchorRetryTimer = null
          }
          try {
            if (window.CSS && CSS.highlights) CSS.highlights.delete(HIGHLIGHT_NAME)
          } catch (error) {
            /* ignore */
          }
          store.listeners.clear()
        }
      }, 'dsh-annotate: document listeners')

      ctx.slots.inject('shell.overlay', function () {
        return ctx.slots.register({ name: 'shell.overlay', id: 'dsh-annotate.overlay', order: 60 }, Overlay)
      })

      // The chip is a compact control in the composer tool row, immediately
      // before the submit action.
      ctx.slots.inject('conversation.input.right', function () {
        return ctx.slots.register(
          { name: 'conversation.input.right', id: 'dsh-annotate.chip', order: 50 },
          Chip,
        )
      })

      // The panel body is a right-sidebar tab: one tab type (stage one) plus
      // the keyed body seat under the same id (stage two). `openTab` reveals
      // the column as part of opening, so the chip only has to name the kind.
      ctx.inject(['sidebarRightTabs', 'sidebarRight'], function (scoped) {
        var tabs = scoped.sidebarRightTabs
        var sidebar = scoped.sidebarRight
        if (sidebar !== undefined && sidebar !== null && typeof sidebar.openTab === 'function') {
          runtime.openTab = function (kind) {
            sidebar.openTab(kind)
          }
        }
        if (tabs === undefined || tabs === null || typeof tabs.register !== 'function') return
        scoped.effect(
          function () {
            // A registration failure must degrade to "no sidebar tab", never
            // take the whole client half down with it.
            var disposers = []
            try {
            disposers.push(tabs.register({
              id: TAB_ID,
              kind: TAB_ID,
              title: function () {
                return tr('tab.title')
              },
              guide: [
                {
                  id: TAB_ID,
                  order: 70,
                  title: function () {
                    return tr('tab.title')
                  },
                  description: function () {
                    return tr('tab.guide')
                  },
                  icon: TabIcon,
                },
              ],
            }))
            disposers.push(scoped.slots.inject('sidebar.right.pane.tab', function () {
              return scoped.slots.register({ name: 'sidebar.right.pane.tab', key: TAB_ID }, AnnotationPanel)
            }))
            } catch (error) {
              fail('register sidebar tab', error)
              disposers.forEach(function (dispose) {
                try { dispose() } catch (ignored) { /* unwind best effort */ }
              })
              disposers = []
            }
            return function () {
              disposers.forEach(function (dispose) {
                try { dispose() } catch (ignored) { /* unwind best effort */ }
              })
            }
          },
          'dsh-annotate: right sidebar tab',
        )
      })
    }

    return { inject: ['slots', 'locale'], apply: apply }
  },
})
