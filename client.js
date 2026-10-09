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

    /** Handles the services hand back once they activate. */
    /**
     * Handles the services hand back once they activate, plus the one knobs a
     * test needs to run the shipping code without a browser: `frameScheduler`
     * replaces the animation-frame clock for `jumpTick` (the default is
     * `requestAnimationFrame`, then `setTimeout`).
     */
    var runtime = { openTab: null, sessions: null, frameScheduler: null }

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
      'panel.jump.loading': '正在加载更早的原文…',
      'panel.jump.failed.noSession': '宿主没有提供当前会话，无法定位原文',
      'panel.jump.failed.absent': '本会话的历史已全部加载，仍未找到这句原文（可能已被编辑或压缩删除，或它在另一个视图/会话里）',
      'panel.jump.failed.budget': '还有更早的历史没有加载；再点一次「跳回原文」会接着往前找',
      'panel.jump.failed.stalled': '宿主没有返回更早的历史（已停止重试）',
      'panel.jump.failed.folded': '原文在当前折叠的回复块里，尚未展开',
      'panel.jump.failed.viewHint': '若原文在另一个视图（对话/轨迹）里，请先切回该视图再试',
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
      'panel.jump.loading': 'Loading earlier messages…',
      'panel.jump.failed.noSession': 'The host session is unavailable, so the source cannot be located.',
      'panel.jump.failed.absent': 'All loaded history has been searched; the quoted text was not found (it may have been edited or compacted away, or it lives in another view or session).',
      'panel.jump.failed.budget': 'Older history remains unloaded; press “Jump to source” again to keep searching backwards.',
      'panel.jump.failed.stalled': 'The host returned no older history (retrying stopped).',
      'panel.jump.failed.folded': 'The source sits inside a collapsed block that did not open.',
      'panel.jump.failed.viewHint': 'If the source lives in the other view (Chat/Trajectory), switch back to it and try again.',
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
      /** The one in-flight jump (`{id, gen, phase, reason, pages}`), or null. Never persisted. */
      jump: null,
      /** Bumped whenever a jump is started or abandoned, so an old loop dies on its next step. */
      jumpGen: 0,
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
        // A jump belongs to one session: switching away abandons it before the
        // loop can page history in a session the user has left.
        clearJump()
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

    /**
     * The number each of this session's annotations reads, by id.
     *
     * Since 0.8.0 the host assigns a number once, at creation, and persists it;
     * every projection it sends carries the field, so a record that has one keeps
     * it (`item.number`). This is the same rule the host's own `numbering()`
     * applies, on purpose: in a session that mixes stored numbers with older
     * records the two must agree, or the panel would show a number the delivered
     * `Annotation N` block does not mean.
     *
     * A record WITHOUT a usable number — anything written before 0.8.0, or a
     * projection from a host half that does not send the field — takes the
     * smallest positive integer the stored numbers do not already own, walking
     * creation order and reserving each value as it is handed out. Falling back
     * to `index + 1` here would disagree with that: stored #5 plus two legacy
     * records gives the positions 1 and 2, while `index + 1` would say 2 and 3.
     *
     * @returns an id → number table (no prototype, so an id cannot collide with
     *   an `Object.prototype` member).
     */
    function allNumbers() {
      var ordered = store.annotations.slice().sort(function (a, b) {
        return a.createdAt - b.createdAt
      })
      var numbers = Object.create(null)
      var taken = Object.create(null)
      ordered.forEach(function (item) {
        var value = item.number
        // The host's own acceptance rule: an integer of at least 1, nothing else.
        if (typeof value !== 'number' || !Number.isFinite(value) || value < 1 || Math.floor(value) !== value) return
        if (taken[value] === true) return
        numbers[item.id] = value
        taken[value] = true
      })
      var next = 1
      ordered.forEach(function (item) {
        if (numbers[item.id] !== undefined) return
        while (taken[next] === true) next += 1
        numbers[item.id] = next
        taken[next] = true
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
     * Jump-to-source core.
     *
     * The transcript does not unmount messages by viewport: chat renders every
     * entry of the loaded event window, so a quote is missing from the DOM only
     * when its message is outside that window — the host's own paging. The host
     * exposes one public way to widen the window, `session.loadOlder()`, and one
     * public progress signal, the event window's `revision`. The step function
     * below is the whole decision table; the driver counts pages, stalls and
     * frames. No wall clock is read: the budget is pages / stalls / frames, so a
     * frozen `Date.now()` changes nothing here.
     */

    /** A single jump asks for at most this many pages before reporting `budget`. */
    var JUMP_MAX_PAGES = 60
    /** This many consecutive requests without a revision change is `stalled`. */
    var JUMP_MAX_STALLS = 3
    /** Frames to wait for an in-flight page (or a reveal) before counting a stall. */
    var JUMP_TICKS_PER_PAGE = 60
    /**
     * Consecutive reveal attempts on matches that still draw nothing.
     *
     * A reveal costs one frame and, unlike a page, cannot be bounded by the
     * stall counter: `locate()` hands back a fresh match each round when the
     * DOM keeps producing new zero-box nodes, and `revealed` is re-earned for
     * every new match by design. Without this cap that sequence never ends.
     */
    var JUMP_REVEAL_TRIES = 2
    /**
     * Total frames the wait phase may spend while the loaded window stays busy
     * and silent.
     *
     * Two page-waits: one is the normal in-flight duration, two means nothing
     * came back. Same unit as `JUMP_TICKS_PER_PAGE`, so the budget stays
     * frames-based and a frozen wall clock changes nothing.
     */
    var JUMP_WAIT_BUDGET = 2 * JUMP_TICKS_PER_PAGE

    var JUMP_ACTIONS = ['land', 'reveal', 'page', 'wait', 'fail']
    var JUMP_REASONS = ['no-session', 'absent', 'stalled', 'budget', 'folded']

    /** The i18n key that must be readable in the panel for one failure reason. */
    var JUMP_REASON_KEYS = {
      'no-session': 'panel.jump.failed.noSession',
      absent: 'panel.jump.failed.absent',
      stalled: 'panel.jump.failed.stalled',
      budget: 'panel.jump.failed.budget',
      folded: 'panel.jump.failed.folded',
    }

    /**
     * The persistent label for one jump state, or null when there is no state
     * to show. Every failure reason maps to a key of its own, which is what
     * keeps the failed path from being a lone toast: the panel row renders this
     * key for as long as the state lasts.
     */
    function jumpStateLabelKey(phase, reason) {
      if (phase === 'failed') {
        var key = JUMP_REASON_KEYS[reason]
        return key === undefined ? 'toast.jumpFailed' : key
      }
      if (phase === 'locating' || phase === 'paging') return 'panel.jump.loading'
      return null
    }

    /** Whether one phase is still working, i.e. the row's button must not re-enter. */
    function jumpBusy(phase) {
      return phase === 'locating' || phase === 'paging'
    }

    /**
     * The opening call: is the session face usable at all?
     *
     * `binding === undefined` and a window that is not open are the two shapes
     * of "no session". Anything else leaves the verdict to {@link jumpStep}.
     */
    function jumpSlot(input) {
      if (input === null || input === undefined) return { action: 'fail', reason: 'no-session' }
      if (input.binding !== true || input.open !== true) return { action: 'fail', reason: 'no-session' }
      return jumpStep(input)
    }

    /**
     * One step of the jump state machine.
     *
     * The order of the tests is part of the contract: a located quote is judged
     * first (land, or reveal and then `folded`), then session health, then the
     * in-flight guard — `loadOlder()` is a silent no-op while the host reports
     * `loadingOlder`, so a step in that state must wait, never re-request — then
     * history exhaustion and finally the budget. Inputs are re-read from the
     * live host state before every step by the driver.
     *
     * @param input `{ hit, visible, revealed, binding, open, hasMore, loadingOlder, pages, stalls }`.
     * @returns `{ action }` with `action ∈ JUMP_ACTIONS`, plus `reason` on `fail`.
     */
    function jumpStep(input) {
      var state = input === null || input === undefined ? {} : input
      if (state.hit === true) {
        if (state.visible === true) return { action: 'land' }
        if (state.revealed !== true) return { action: 'reveal' }
        return { action: 'fail', reason: 'folded' }
      }
      if (state.binding !== true || state.open !== true) return { action: 'fail', reason: 'no-session' }
      if (state.loadingOlder === true) return { action: 'wait' }
      if (state.hasMore !== true) return { action: 'fail', reason: 'absent' }
      if (state.stalls >= JUMP_MAX_STALLS) return { action: 'fail', reason: 'stalled' }
      if (state.pages >= JUMP_MAX_PAGES) return { action: 'fail', reason: 'budget' }
      return { action: 'page' }
    }

    /**
     * Drive one jump to its terminal step.
     *
     * Everything that touches the page is injected, so the counting rules (one
     * page per `page` step, a stall per request that does not move the window,
     * a stall per reveal frame without a box) are exercised directly by the
     * suite instead of only by hand in a browser.
     *
     * Counting rules, frozen: `page` increments `pages` before the request and
     * then clears or increments `stalls` from the revision change; `wait` moves
     * neither and only spends frames; `reveal` only flips `revealed` and spends
     * one tick; `land` and `fail` end the run. A stale `gen` ends the run too.
     *
     * One net is added on top of the table. The table judges the in-flight guard
     * (`loadingOlder`) before the stall counter — correctly, because that state
     * must be waited for instead of re-requested — so a host that reports a page
     * in flight forever would be waited on forever: no `page` step ever runs, so
     * no stall is ever counted. Waiting therefore has its own frame budget
     * (the same {@link JUMP_TICKS_PER_PAGE}); when it runs out with the window
     * still silent and still busy, the host is not coming back and the run
     * reports `stalled` instead of hanging.
     *
     * @param deps `{ gen, current(), locate(), visible(), revealed(), reveal(), tick(frames), state(), loadOlder(), revision(), lastRevision }`.
     * @returns the terminal `{ action, reason, pages, stalls }`.
     */
    async function runJump(deps) {
      var pages = 0
      var stalls = 0
      var waitedFrames = 0
      var revealTries = 0
      var revealed = deps.revealed()
      var lastElement = null
      for (;;) {
        if (deps.gen !== deps.current()) return { action: 'abandoned', reason: null, pages: pages, stalls: stalls }
        var hit = deps.locate()
        if (hit !== lastElement) {
          // A different match than last time: its own reveal has to be earned.
          // `revealTries` deliberately does NOT reset here — a new match every
          // step is exactly the case the budget exists for, so the tries must
          // accumulate across the whole reveal streak. Only landing (below)
          // starts a fresh streak.
          lastElement = hit
          revealed = false
        }
        var state = deps.state()
        var output = jumpSlot({
          hit: hit !== null,
          visible: hit === null ? false : deps.visible() === true,
          revealed: revealed,
          binding: state.binding === true,
          open: state.open === true,
          hasMore: state.hasMore === true,
          loadingOlder: state.loadingOlder === true,
          pages: pages,
          stalls: stalls,
        })
        if (output.action === 'land' || output.action === 'fail') {
          return { action: output.action, reason: output.reason === undefined ? null : output.reason, pages: pages, stalls: stalls }
        }
        if (output.action === 'reveal') {
          revealTries += 1
          if (revealTries > JUMP_REVEAL_TRIES) {
            // Revealed repeatedly and still nothing is drawn: this is the
            // `folded` outcome, reached through the budget instead of a hang.
            return { action: 'fail', reason: 'folded', pages: pages, stalls: stalls }
          }
          revealed = true
          deps.reveal()
          await deps.tick(1)
          continue
        }
        if (output.action === 'wait') {
          var beforeWait = deps.revision()
          await deps.tick(JUMP_TICKS_PER_PAGE)
          if (deps.gen !== deps.current()) return { action: 'abandoned', reason: null, pages: pages, stalls: stalls }
          if (deps.revision() !== beforeWait) {
            // The page landed after all: whatever silence was counted is over.
            waitedFrames = 0
            stalls = 0
          } else {
            waitedFrames += JUMP_TICKS_PER_PAGE
            if (waitedFrames >= JUMP_WAIT_BUDGET) {
              // Busy and silent for two whole wait budgets: the host is not
              // coming back, and no page step will ever run to count a stall.
              return { action: 'fail', reason: 'stalled', pages: pages, stalls: stalls }
            }
          }
          deps.lastRevision = deps.revision()
          continue
        }
        // 'page'
        pages += 1
        waitedFrames = 0
        var before = deps.revision()
        await deps.loadOlder()
        await deps.tick(1)
        if (deps.gen !== deps.current()) return { action: 'abandoned', reason: null, pages: pages, stalls: stalls }
        deps.lastRevision = before
        if (deps.revision() === before) stalls += 1
        else stalls = 0
      }
    }

    /*
     * Quote anchoring core, plus the geometry the badge overlay decides with.
     * Kept free of any DOM reference so it can be exercised directly by the
     * test suite: the browser side only builds the segment list, turns the
     * returned offsets back into a Range, and reads the occlusion edges off the
     * page.
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

    /*
     * Badge overlay visibility.
     *
     * The numbered badges are painted into a fixed, full-viewport layer, so
     * nothing in the page layout stops them from landing on the input box —
     * where, being clickable, they steal clicks from it. The transcript is
     * never re-laid out for this, so the same rule the selection side already
     * applies ("never react to the composer") is applied to drawing: an entry
     * whose badge box is covered is not drawn at all.
     */

    /** The host's own fallback for `--dsh-composer-height`, used verbatim. */
    var COMPOSER_HEIGHT_FALLBACK = 152

    /** The badge's painted size, and how far its box sits above/left of the quote. */
    var BADGE_SIDE = 18
    var BADGE_TOP_GAP = 9
    var BADGE_LEFT_GAP = 11

    /**
     * The box a badge for `rect` is actually painted in, in viewport coordinates.
     *
     * Both the visibility rule and the coordinates handed to the renderer come
     * from here, so the box that is judged is the box that is drawn: the gap and
     * the size live in one place, and changing either moves the test with the
     * paint instead of drifting away from it.
     *
     * @param rect `{ top, left }` of the quote in viewport coordinates, or null.
     * @returns `{ top, left, right, bottom }`, or null when nothing is anchored.
     */
    function badgeBox(rect) {
      if (rect === null || rect === undefined) return null
      var top = Math.max(2, rect.top - BADGE_TOP_GAP)
      var left = Math.max(2, rect.left - BADGE_LEFT_GAP)
      return { top: top, left: left, right: left + BADGE_SIDE, bottom: top + BADGE_SIDE }
    }

    /**
     * The band of the viewport the badge overlay must keep out of.
     *
     * Only edges backed by a readable source are produced; nothing is guessed:
     *
     *   - the bottom edge is taken from the bottom of the transcript scroller
     *     when it can be measured, and from the viewport only when it cannot;
     *     that edge is the composer's own top, because the composer sits at the
     *     bottom of the scroller. The composer's published height (read by
     *     `composerHeight()`) is what moves it up, and an unusable height falls
     *     back to the host's own default, never to a number of ours;
     *   - the transcript scroller's top edge, when it can be measured, is the
     *     head edge. No header height is ever invented, so an unreadable edge
     *     simply leaves the head uncropped.
     *
     * A band that has collapsed (`top >= bottom`, e.g. a scroller shorter than
     * the composer) keeps its bottom edge alone: a head edge that reaches at or
     * past the composer would hide every badge for an area that is not covered
     * at all.
     *
     * Pure on purpose: the browser half parses the custom property and measures
     * the page, this function only does the arithmetic.
     *
     * @param composerHeight parsed `--dsh-composer-height`, or a non-finite or
     *   non-positive value when it is absent.
     * @param viewportHeight height of the viewport in CSS pixels, used for the
     *   bottom edge only when `contentBottom` cannot be measured.
     * @param contentTop top edge of the transcript scroller in viewport
     *   coordinates, or a non-finite value when it cannot be measured.
     * @param contentBottom bottom edge of the transcript scroller in viewport
     *   coordinates, or a non-finite value when it cannot be measured.
     * @returns `{ top?, bottom? }` in viewport coordinates; an absent field
     *   means "no readable source for that edge".
     */
    function badgeBand(composerHeight, viewportHeight, contentTop, contentBottom) {
      var band = {}
      var anchor = Number.isFinite(contentBottom) ? contentBottom : viewportHeight
      if (Number.isFinite(anchor)) {
        var composer = Number.isFinite(composerHeight) && composerHeight > 0 ? composerHeight : COMPOSER_HEIGHT_FALLBACK
        band.bottom = anchor - composer
      }
      if (Number.isFinite(contentTop)) band.top = contentTop
      if (band.top !== undefined && band.bottom !== undefined && band.top >= band.bottom) delete band.top
      return band
    }

    /**
     * Whether a badge may be drawn at all: does its own box clear the band?
     *
     * The box is what the user sees and clicks, so that is what is judged — a
     * badge hanging over the input box would be painted there and, being
     * clickable, would take the click meant for the composer. A quote whose rect
     * merely runs under the composer while its badge stays clear keeps its
     * badge: only the drawn box decides. An entry is dropped as soon as that box
     * overlaps an occlusion edge — dropped, never nudged: a badge moved out of
     * the way reads as an annotation that moved.
     *
     * Missing information never hides a badge, which is the behaviour this
     * overlay had before: a null box means nothing is anchored (and the caller
     * skips the entry anyway), an absent or unreadable edge contributes no crop.
     * The vertical out-of-view filter that lives in the caller is a separate
     * rule and stays there.
     *
     * @param box `{ top, bottom }` of the badge in viewport coordinates (see
     *   {@link badgeBox}), or null.
     * @param band result of {@link badgeBand}, or anything without readable edges.
     * @returns true when the box lies entirely outside the band.
     */
    function badgeVisibleIn(box, band) {
      if (box === null || box === undefined) return false
      var top = box.top
      var bottom = box.bottom
      if (!Number.isFinite(top) || !Number.isFinite(bottom)) return true
      // min/max rather than top/bottom: a box is an interval, and reading it as
      // one keeps a malformed (inverted) box from slipping past the crop.
      var low = Math.min(top, bottom)
      var high = Math.max(top, bottom)
      var edges = band === null || band === undefined ? {} : band
      if (Number.isFinite(edges.bottom) && high > edges.bottom) return false
      if (Number.isFinite(edges.top) && low < edges.top) return false
      return true
    }

    /* @pure-anchor-end */

    /**
     * Wait one frame: the injected clock when a test provides one, else the
     * page's own animation frame, else a timer.
     *
     * It lives below the slice on purpose: `test/anchor.test.mjs` asserts the
     * shipped slice never reaches for a DOM member, so the only frame-clock
     * access stays out here.
     */
    function frameSchedule(callback) {
      if (runtime.frameScheduler !== null && typeof runtime.frameScheduler === 'function') {
        runtime.frameScheduler(callback)
        return
      }
      if (typeof window.requestAnimationFrame === 'function') {
        window.requestAnimationFrame(callback)
        return
      }
      setTimeout(callback, 0)
    }

    /**
     * Wait `frames` animation frames.
     *
     * Frames, not milliseconds: the budget must behave identically under a
     * frozen wall clock.
     */
    function jumpTick(frames) {
      var left = frames
      return new Promise(function (resolve) {
        var step = function () {
          left -= 1
          if (left <= 0) {
            resolve()
            return
          }
          frameSchedule(step)
        }
        frameSchedule(step)
      })
    }

    /**
     * The jump core and the dictionaries, published on the module object.
     *
     * The browser half is a ModuleLoader bundle, not a module, so a test can
     * only reach it by evaluating the `@pure-anchor` slice. This object is built
     * from those same declarations and handed back to whoever loads the module,
     * so the two can be compared: the slice the suite runs cannot silently drift
     * away from the one that ships. Nothing here touches the DOM.
     */
    var coreExports = {
      JUMP_MAX_PAGES: JUMP_MAX_PAGES,
      JUMP_MAX_STALLS: JUMP_MAX_STALLS,
      JUMP_TICKS_PER_PAGE: JUMP_TICKS_PER_PAGE,
      JUMP_REVEAL_TRIES: JUMP_REVEAL_TRIES,
      JUMP_ACTIONS: JUMP_ACTIONS,
      JUMP_REASONS: JUMP_REASONS,
      JUMP_REASON_KEYS: JUMP_REASON_KEYS,
      jumpStep: jumpStep,
      jumpSlot: jumpSlot,
      jumpStateLabelKey: jumpStateLabelKey,
      jumpBusy: jumpBusy,
      runJump: runJump,
    }

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

    /** The nearest element at or above `node` (text nodes have no box of their own). */
    function elementOf(node) {
      if (node === null || node === undefined) return null
      if (node.nodeType === Node.ELEMENT_NODE) return node
      return node.parentElement === undefined ? null : node.parentElement
    }

    /** Read a box without letting a layout hiccup break the jump. */
    function rectOf(element) {
      if (element === null || element === undefined || typeof element.getBoundingClientRect !== 'function') return null
      try {
        return element.getBoundingClientRect()
      } catch (error) {
        return null
      }
    }

    /**
     * Whether a located quote has a box of its own.
     *
     * A quote inside `hidden="until-found"` content is still in the DOM — that
     * is the platform's lazy *rendering*, not removal — so it can be matched by
     * the text walker while measuring as a zero box. Zero means "located but not
     * drawn", which is a state the jump has to resolve rather than scroll to.
     */
    function isDrawn(range) {
      if (range === null || range === undefined || range.startContainer === undefined) return false
      if (range.startContainer.isConnected !== true) return false
      var rect = rectOf(elementOf(range.startContainer))
      if (rect === null) return false
      return rect.width !== 0 || rect.height !== 0
    }

    /**
     * Reveal the collapsed block a located quote sits in.
     *
     * The host collapses turn-process members with the platform
     * `hidden="until-found"` attribute and reveals them from the
     * `beforematch` event (`dsh-client-ui-chat`: `useSearchableHidden`). That
     * event is the documented trigger for this attribute, so dispatching it is
     * the host's own reveal path rather than a guess about its DOM.
     *
     * @returns true when an element that carries the attribute was found.
     */
    function revealFold(range) {
      var node = range === null || range === undefined ? null : elementOf(range.startContainer)
      if (node === null || typeof node.closest !== 'function') return false
      var folded = null
      try {
        folded = node.closest('[hidden="until-found"]')
      } catch (error) {
        folded = null
      }
      if (folded === null || folded === undefined) return false
      try {
        folded.dispatchEvent(new Event('beforematch', { bubbles: true }))
      } catch (error) {
        return false
      }
      return true
    }

    /**
     * Scroll the located quote to the middle of the view.
     *
     * `scrollIntoView` scrolls every scrollable ancestor, so calling it for an
     * element inside a scrollable block (a code block, a table) drags the
     * transcript along. When the element itself is not scrollable, the nearest
     * scrollable ancestor is scrolled by hand first, and the transcript is the
     * fallback. Anything unreadable falls back to the plain call, which is the
     * behaviour this had before.
     */
    function scrollIntoViewCentered(element) {
      if (element === null || element === undefined || typeof element.scrollIntoView !== 'function') return
      var target = element
      var parent = element.parentElement
      while (parent !== null && parent !== undefined) {
        var style = typeof window.getComputedStyle === 'function' ? window.getComputedStyle(parent) : null
        var overflow = style === null ? '' : style.overflowY
        if (overflow === 'auto' || overflow === 'scroll') {
          if (parent.clientHeight < parent.scrollHeight) {
            var box = rectOf(parent)
            var own = rectOf(element)
            if (box !== null && own !== null) {
              parent.scrollTop += own.top - box.top - (box.height - own.height) / 2
              target = element.closest('[data-conversation-scroll]') || null
            }
          }
          break
        }
        parent = parent.parentElement
      }
      if (target === null) return
      try {
        target.scrollIntoView({ block: 'center', behavior: 'smooth' })
      } catch (error) {
        try {
          target.scrollIntoView()
        } catch (ignored) {
          /* scrolling is best-effort; the highlight is still applied */
        }
      }
    }

    /**
     * The host's session binding for the session being jumped in, read fresh.
     *
     * Never cached: a binding is tied to one generation of a materialized
     * session, so a retained reference would drive the *previous* session's
     * `loadOlder`. Absent service, absent binding and a real throw all answer
     * the same way, `{ok:false, why}`, because a jump must degrade, not throw.
     */
    function sessionLookup() {
      if (store.sessionId === null) return { ok: false, binding: null, why: 'no session' }
      var sessions = runtime.sessions
      if (sessions === null || sessions === undefined || typeof sessions.binding !== 'function') {
        return { ok: false, binding: null, why: 'the host provides no sessions service' }
      }
      try {
        var binding = sessions.binding(store.sessionId)
        if (binding === null || binding === undefined) return { ok: false, binding: null, why: 'the host has no binding for this session' }
        return { ok: true, binding: binding, why: null }
      } catch (error) {
        return { ok: false, binding: null, why: error && error.message ? error.message : String(error) }
      }
    }

    /** One page of the host's own progress signal, or null when unreadable. */
    function windowRevision(binding) {
      try {
        var source = binding === null || binding === undefined ? null : binding.eventSource
        if (source === null || source === undefined || typeof source.getSnapshot !== 'function') return null
        var snapshot = source.getSnapshot()
        if (snapshot === null || snapshot === undefined) return null
        return typeof snapshot.revision === 'number' ? snapshot.revision : null
      } catch (error) {
        return null
      }
    }

    /** The three public snapshot fields the step table judges, or nulls when unreadable. */
    function sessionSnapshot(binding) {
      var empty = { open: null, hasMore: null, loadingOlder: null }
      try {
        var session = binding === null || binding === undefined ? null : binding.session
        if (session === null || session === undefined || typeof session.getSnapshot !== 'function') return empty
        var snapshot = session.getSnapshot()
        if (snapshot === null || snapshot === undefined) return empty
        return { open: snapshot.openState, hasMore: snapshot.hasMore, loadingOlder: snapshot.loadingOlder }
      } catch (error) {
        return empty
      }
    }

    /**
     * Wait `frames` animation frames (a timer when the frame clock is missing).
     *
     * Frames, not milliseconds: the budget must behave identically under a
     * frozen wall clock.
     */
    /** The state one jump step judges, read from the live host face. */
    function jumpStateOf(binding) {
      if (binding === null) return { binding: false, open: false, hasMore: false, loadingOlder: false }
      var snapshot = sessionSnapshot(binding)
      return {
        binding: true,
        open: snapshot.open === 'open',
        hasMore: snapshot.hasMore === true,
        loadingOlder: snapshot.loadingOlder === true,
      }
    }

    /** This annotation's jump state, or null — a jump is shown on its own row only. */
    function jumpOf(id) {
      return store.jump !== null && store.jump.id === id ? store.jump : null
    }

    /** The occurrence one annotation is located at, from the record or the fallback table. */
    function wantedOrdinal(id) {
      var wanted = wantedOccurrences(store.annotations)[id]
      return wanted === undefined ? 0 : wanted
    }

    /**
     * The quote's Range right now: the retained one, else a fresh search.
     *
     * Shared by the host-independent first step and by the paging driver, so
     * both judge the same thing: the retained range while its node is still
     * connected (which also keeps the match's identity stable across steps),
     * otherwise one `findQuoteRange` pass at this annotation's own occurrence.
     */
    function locateJumpRange(wanted) {
      var range = store.ranges[wanted.id]
      if (range !== undefined && range.startContainer !== undefined && range.startContainer.isConnected === true) return range
      var found = findQuoteRange(wanted.quote, wanted.ordinal)
      if (found !== null) store.ranges[wanted.id] = found
      return found
    }

    /**
     * Land on a located quote and end the jump.
     *
     * Path 1's user-visible result, unchanged from 0.9.0: scroll the quote to
     * the middle of its scrollport, repaint the highlights, clear the jump
     * state. A node that is in the DOM with a non-zero box needs no host, so
     * this is reachable with no session service at all.
     */
    function landJump(id, gen) {
      store.jump = null
      syncHighlights()
      var range = store.ranges[id]
      scrollIntoViewCentered(range === undefined ? null : elementOf(range.startContainer))
      emit()
    }

    /** Every runJump collaborator a real jump needs; also what a missing service short-circuits. */
    function jumpDeps(gen, wanted) {
      var holder = { lastRevision: null }
      var located = null
      return {
        gen: gen,
        current: function () { return store.jumpGen },
        locate: function () {
          located = locateJumpRange(wanted)
          return located
        },
        visible: function () { return isDrawn(located) },
        revealed: function () { return false },
        reveal: function () { revealFold(located) },
        tick: function (frames) { return jumpTick(frames) },
        state: function () {
          var lookup = sessionLookup()
          if (!lookup.ok) return { binding: false, open: false, hasMore: false, loadingOlder: false }
          return jumpStateOf(lookup.binding)
        },
        /**
         * One page of the host's own history, through the host's own verb.
         *
         * The binding is resolved at the moment of the call and never cached: a
         * binding belongs to one generation of a materialized session, and a
         * retained one would page a session that is gone (§4.2 rule 1). If the
         * face disappears mid-jump, this returns without paging and the next
         * step reports `no-session` (or keeps waiting while the host is busy),
         * so a vanished host degrades instead of throwing.
         */
        loadOlder: function () {
          var lookup = sessionLookup()
          if (!lookup.ok) return
          var session = lookup.binding.session
          if (session === null || session === undefined || typeof session.loadOlder !== 'function') return
          return session.loadOlder()
        },
        revision: function () {
          var lookup = sessionLookup()
          if (!lookup.ok) return holder.lastRevision
          var revision = windowRevision(lookup.binding)
          return revision === null ? holder.lastRevision : revision
        },
        get lastRevision() { return holder.lastRevision },
        set lastRevision(value) { holder.lastRevision = value },
      }
    }

    /**
     * Run one jump: locate, page the host's history in, scroll, or fail loudly.
     *
     * The failed states are terminal until the next click: the row keeps the
     * reason, the button stays usable, and the diagnostic attributes stay on
     * the element, so a dead-looking click always leaves something to read and
     * something to press again.
     */
    async function executeJump(wanted, gen) {
      // The frozen table's first line, run before anything host-shaped is
      // touched: a quote that is already loaded and drawn is scrolled to with
      // no session service at all. 0.9.0 had no such dependency, and a missing
      // `sessions` service must not cost a capability that never needed it.
      var first = jumpStep({
        hit: false,
        visible: false,
        revealed: false,
        binding: true,
        open: true,
        hasMore: true,
        loadingOlder: false,
        pages: 0,
        stalls: 0,
      })
      if (first.action === 'page') {
        var located = locateJumpRange(wanted)
        if (located !== null && isDrawn(located)) {
          landJump(wanted.id, gen)
          return
        }
      }
      var lookup = sessionLookup()
      if (!lookup.ok) {
        finishJump(wanted.id, gen, { action: 'fail', reason: 'no-session', pages: 0 }, lookup.why)
        return
      }
      var outcome = await runJump(jumpDeps(gen, wanted))
      if (outcome.action === 'abandoned') return
      finishJump(wanted.id, gen, outcome, null)
    }

    /**
     * The one place a jump ends.
     *
     * Success clears the state and moves the view; a failure keeps the reason
     * (and the page budget it burned) on the annotation's row, keeps the button
     * usable for a retry, and echoes the same sentence once as a toast — the
     * toast is allowed, being the only signal is not.
     */
    function finishJump(id, gen, outcome, why) {
      if (gen !== store.jumpGen) return
      if (outcome.action === 'land') {
        landJump(id, gen)
        return
      }
      var reason = outcome.reason === null || outcome.reason === undefined ? 'absent' : outcome.reason
      if (why !== null && why !== undefined) console.warn('[dsh-annotate] jump to source:', reason, why)
      store.jump = { id: id, gen: gen, phase: 'failed', reason: reason, pages: outcome.pages === undefined ? 0 : outcome.pages }
      showToast(tr(jumpStateLabelKey('failed', reason)))
    }

    /**
     * Jump to one annotation's quote.
     *
     * Path 1 (already in the loaded window) scrolls straight there, exactly as
     * 0.9.0 did. Path 2 (the message is above the window) widens the window with
     * the host's own public `loadOlder()` before locating again. Path 3 has no
     * route at all and leaves the persistent, retryable failure state built by
     * {@link finishJump} instead of a toast and nothing else.
     */
    function jumpTo(annotation) {
      var gen = store.jumpGen + 1
      store.jumpGen = gen
      store.jump = { id: annotation.id, gen: gen, phase: 'locating', reason: null, pages: 0 }
      var wanted = {
        id: annotation.id,
        quote: annotation.quote,
        ordinal: wantedOrdinal(annotation.id),
      }
      emit()
      executeJump(wanted, gen).catch(function (error) {
        fail('jump to source', error)
        finishJump(wanted.id, gen, { action: 'fail', reason: 'stalled', pages: 0 }, null)
      })
    }

    /**
     * Abandon the running jump, if any.
     *
     * Bumping the generation is what stops the loop: its next step sees a stale
     * `gen` and returns without touching the store, so a session switch or a
     * closed panel cannot leave a jump running against the wrong session.
     */
    function clearJump() {
      store.jumpGen += 1
      if (store.jump !== null) {
        store.jump = null
        emit()
      }
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

    /**
     * The composer height the host publishes, in CSS pixels, or NaN.
     *
     * `@deepseek-ai/dsh-client-ui-conversation` (lib/client.js, the
     * ResizeObserver that watches the composer seat) sets
     * `--dsh-composer-height` on the transcript scroller element itself, so that
     * element is asked first; the document root is asked too, because a host
     * that publishes the value globally would be found there. NaN means "no
     * readable source": {@link badgeBand} then uses the host's own default
     * (`@deepseek-ai/dsh-client-ui-chat` writes
     * `bottom: calc(var(--dsh-composer-height, 152px) + 16px)`) instead of a
     * value of ours.
     */
    function composerHeight() {
      var elements = [document.querySelector('[data-conversation-scroll]'), document.documentElement]
      for (var i = 0; i < elements.length; i += 1) {
        var element = elements[i]
        if (element === null || element === undefined) continue
        var value = parseFloat(getComputedStyle(element).getPropertyValue('--dsh-composer-height'))
        if (Number.isFinite(value) && value > 0) return value
      }
      return Number.NaN
    }

    /**
     * The occlusion band of the current page, read once per render.
     *
     * The scroller is measured for both edges: its top is the head edge, and its
     * bottom less the composer height is where the composer starts. The viewport
     * height is passed along only as the fallback for a page where the scroller
     * cannot be measured at all.
     */
    function badgeOcclusionBand() {
      var scroller = document.querySelector('[data-conversation-scroll]')
      var measured = scroller === null ? null : scroller.getBoundingClientRect()
      return badgeBand(
        composerHeight(),
        window.innerHeight,
        measured === null ? Number.NaN : measured.top,
        measured === null ? Number.NaN : measured.bottom,
      )
    }

    function badgeList() {
      var numbers = allNumbers()
      var items = []
      // One band per render: the composer and the transcript body sit at the same
      // place for every annotation, so the page is asked once.
      var band = badgeOcclusionBand()
      store.annotations.forEach(function (annotation) {
        var rect = rangeRect(annotation.id)
        if (rect === null) return
        if (rect.bottom < -40 || rect.top > window.innerHeight + 40) return
        // The box that is judged is the box that is painted: badgeBox() supplies
        // both. Its coordinates are never adjusted to dodge the occlusion — a
        // badge moved out of the way reads as an annotation that moved.
        var box = badgeBox(rect)
        if (box === null) return
        if (!badgeVisibleIn(box, band)) return
        items.push({
          annotation: annotation,
          number: numbers[annotation.id],
          top: box.top,
          left: box.left,
          side: BADGE_SIDE,
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
                width: item.side + 'px',
                height: item.side + 'px',
                padding: 0,
                border: '1px solid var(--dsw-alias-bg-base)',
                borderRadius: item.side / 2 + 'px',
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

    function smallButton(label, onClick, tone, disabled) {
      var off = disabled === true
      return h(
        'button',
        {
          type: 'button',
          onClick: onClick,
          disabled: off,
          style: {
            padding: '3px 9px',
            border: '1px solid var(--dsw-alias-border-l1)',
            borderRadius: '6px',
            background: 'transparent',
            color: tone === 'danger' ? 'var(--dsw-alias-state-error-primary)' : 'var(--dsw-alias-label-secondary)',
            font: '11px/1.5 system-ui, sans-serif',
            cursor: off ? 'default' : 'pointer',
            opacity: off ? 0.55 : 1,
            whiteSpace: 'nowrap',
          },
        },
        label,
      )
    }

    /**
     * The persistent line one jump state puts on its own annotation.
     *
     * While the jump works, this is the busy label, so no toast has to stand in
     * for progress. When it failed, this is the reason sentence plus, for the
     * reasons where it is true, the hint that the quote may live in the other
     * view. The element carries `data-dsa-jump="<phase>:<reason>"` and the page
     * budget it burned, which is what makes a failure readable in DevTools
     * instead of being a sentence that vanished after 1.4 seconds.
     */
    function JumpStatus(props) {
      var jump = props.jump
      if (jump === null || jump === undefined) return null
      var label = jumpStateLabelKey(jump.phase, jump.reason)
      if (label === null) return null
      var failed = jump.phase === 'failed'
      var attributes = {
        style: {
          color: failed ? 'var(--dsw-alias-state-error-primary)' : 'var(--dsw-alias-label-secondary)',
          font: '11px/1.6 system-ui, sans-serif',
        },
      }
      if (failed) {
        attributes['data-dsa-jump'] = 'failed:' + jump.reason
        attributes['data-dsa-jump-pages'] = String(jump.pages)
      } else {
        attributes['data-dsa-jump'] = jump.phase
      }
      var children = [tr(label)]
      if (failed && (jump.reason === 'absent' || jump.reason === 'no-session')) {
        children.push(h('div', { style: { color: 'var(--dsw-alias-label-secondary)' } }, tr('panel.jump.failed.viewHint')))
      }
      return h('div', attributes, children)
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
      var jump = jumpOf(annotation.id)
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
      // Unmounting the surface that shows a running jump abandons it: the loop
      // stops at its next step instead of paging history the user cannot see.
      // Only this annotation's jump is touched, so a list refresh that unmounts
      // some other row never cancels the jump the user is watching.
      React.useEffect(
        function () {
          return function () {
            if (jumpOf(annotation.id) !== null) clearJump()
          }
        },
        [annotation.id],
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
            smallButton(tr('panel.jump'), guard('jump to source', function () { jumpTo(annotation) }), undefined, jumpBusy(jump === null ? null : jump.phase)),
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
          h(JumpStatus, { jump: jump }),
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
      // Same rule as the panel row: closing the surface that shows a running
      // jump abandons that jump, and only that one.
      React.useEffect(
        function () {
          return function () {
            if (jumpOf(annotation.id) !== null) clearJump()
          }
        },
        [annotation.id],
      )
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
        h(JumpStatus, { jump: jumpOf(annotation.id) }),
        h(
          'div',
          { style: { display: 'flex', gap: '6px' } },
          smallButton(
            tr('panel.jump'),
            guard('jump to source', function () { jumpTo(annotation) }),
            undefined,
            jumpBusy(store.jump !== null && store.jump.id === annotation.id ? store.jump.phase : null),
          ),
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
          clearJump()
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

      // The jump needs the host's own session face to widen the loaded history
      // window (`loadOlder`) and to read its progress (`revision`). `sessions`
      // is a public client service (the client API catalogue lists it) and the
      // host's own chat and trajectory views reach it exactly this way; the
      // injection is declared here rather than in `package.json`, so a host that
      // does not offer it simply leaves the jump on its honest failure path.
      ctx.inject(['sessions'], function (scoped) {
        if (scoped.sessions !== undefined && scoped.sessions !== null) runtime.sessions = scoped.sessions
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

    return { inject: ['slots', 'locale'], apply: apply, core: coreExports }
  },
})
