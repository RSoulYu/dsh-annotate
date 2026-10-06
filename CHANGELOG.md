# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.5.0] - 2026-10-06

### Fixed

- **Two annotations on the same sentence could be re-anchored onto the same
  occurrence.** After a reload, `reanchor` rebuilt the ranges that were lost and
  kept the per-quote occurrence counter **only over the annotations that had lost
  their range**. When the older of two annotations on one sentence still had a
  live range, the newer one was handed occurrence 0 and relocated onto the older
  one's text; the wrong `Range` was then cached in `store.ranges[<id>]`, so the
  highlight and the badge stayed on the wrong sentence until the next reload.
  `jumpTo`'s fallback had the same shape — it always looked for occurrence 0.

  There is now one pure function for the whole question:
  `quoteOccurrences(annotations)`, inside the `@pure-anchor` block, numbers every
  annotation of the session by creation order (compared on the whitespace-
  normalized quote, stable on equal timestamps, and one quote never affects
  another). `reanchor` builds that table once per pass and looks up each
  annotation's own ordinal instead of counting among the missing ones; `jumpTo`
  uses the same ordinal for its fallback instead of a fixed 0.

  Cost: two annotations of one quote now claim the 2nd, 3rd, … occurrence even
  when the earlier one's message is not loaded, so the later one can stay "source
  not in view" until its own occurrence renders — where the old counter could
  park it on the first occurrence that happened to exist. That is the intended
  trade: a missing highlight comes back on scroll, a highlight on the wrong
  sentence misleads.

  Verified: the anchoring test extracts the pure function from `client.js` and
  asserts creation order (two equal quotes → 0 and 1, different quotes
  independent, ties stable), and a regression test pins the reported case — older
  annotation already anchored, newer one missing — to the **second** occurrence.
  33/33 tests pass.

### Added

- **Redeliver a delivered annotation.** Delivery is once per annotation by
  design, so a delivered one could not be sent again; the only path back to the
  model was the `annotation` tool. Both the badge popover and the right-sidebar
  row now offer **重新投递 / Redeliver** on a `delivered` annotation, backed by a
  new `redeliver` action of the browser API: the record goes back to `pending`,
  its delivery receipt (`deliveredAt`/`deliveredTurn`) is cleared, `updatedAt` is
  refreshed, and the response is that session's fresh `{ annotations }` list —
  the same shape `update` returns. The next message you send carries the block
  again; injecting stays the `agent/pre-step` listener's job, `redeliver` only
  changes persisted state. An unknown id fails with
  `unknown annotation: <id>`, an already pending id is idempotent. The
  `annotation` tool now reports `revision: 6`.

  Cost: nothing is retracted. The earlier block is still in the session log, so
  redelivering really does hand that quote and note to the model a second time,
  and the transcript shows it again.

  A third cost is shared by both changes: their painted result can only be
  confirmed in a browser. The suite pins the pure ordinal table, the message
  shape and the persisted status — not where a highlight and a badge land in the
  transcript (0.5.0 changed that for a repeated quote), not what 【跳回原文】
  scrolls to, not whether 【重新投递】 appears on a delivered annotation and only
  there, and not the state flow behind it (delivered → pending → rides the next
  message → delivered again). Manual checks: two annotations on one sentence keep
  one highlight each after a reload; a later annotation whose message is not
  loaded yet appears on its own occurrence once it renders, not on the first;
  【重新投递】 shows up only on delivered annotations and follows the state flow
  above.

### Docs

- `README`/`README.en`: the feature list, the popover/panel action lists, the
  HTTP API table, the limitation about quote re-anchoring (including the
  drawing-only cost above) and the test counts describe both changes; the roadmap
  item that proposed redelivery is done.

[0.5.0]: https://github.com/RSoulYu/dsh-annotate/compare/v0.4.0...v0.5.0

## [0.4.0] - 2026-10-05

### Changed

- **The block is now a message of its own, so it no longer shows up in your own
  bubble.** Until 0.3.3 the block was appended to the `content` of the user's
  message. The chat draws an appended `user/message` as a bubble only when its
  `source.kind` is `user`, so that text rendered as part of what you sent. The
  block now travels as a **separate** `user/message` whose `source.kind` is
  `dsh-annotate`, inserted immediately after the message entering the step:

  - the chat classifies any non-`user` source kind as an injected-context row
    (`@deepseek-ai/dsh-client-ui-chat`, `messageDefinition` → `contextMessage`;
    `contextProducer` labels the row with the kind), so the transcript shows the
    block as an injected line and **your bubble keeps only what you typed**;
  - the message you sent is returned byte for byte — nothing is appended to its
    content.

  Everything the block promises is unchanged: it is still an appended, logged,
  model-visible `user/message` event, so the model still receives it together
  with the message you actually sent, regenerate/fork still re-reads it, and
  delivery is still confirmed only once the log publishes that message (0.3.3).
  The rendered block also lost its leading blank line, which only existed to
  separate it from your sentence inside a single message.

  Cost: the transcript gains one injected-context row, and the model now reads
  the block as injected context instead of as part of your message. Those are
  usually weighted the same, but the difference is real, and whether the row
  renders as intended can only be confirmed in a browser — a unit test can pin
  the message shape, not the drawing.

  Rollback: this is one commit on the `b/annotation-block-separate-message`
  branch; reverting the merge commit that brought it to `main` restores the
  previous in-bubble delivery.

  Verified: the injected message is asserted against the session's
  `user/message` contract (identified message, `role: "user"`, non-empty source
  kind, content array), the user's own message is asserted to come back
  unmodified, and the receipt-based delivery confirmation is re-tested against
  the new message — 28/28 tests pass.

### Docs

- `README`/`README.en`: the delivery description, the block section, the
  data/privacy table and the defect list now describe the separate injected
  message; the roadmap item that proposed this change is done.

[0.4.0]: https://github.com/RSoulYu/dsh-annotate/compare/v0.3.3...v0.4.0

## [0.3.3] - 2026-10-05

### Fixed

- **A delivery could be recorded as done while the block never reached the
  model.** The pre-step listener marked the pending annotations delivered as soon
  as it returned the rewritten message, but `agent/pre-step` is not the last step
  before the append: the loop checks its abort signal and then runs
  `prepareRequest`, and only after both does it append `decision.messages` to the
  session log. A turn stopped inside that window — or one whose request
  preparation failed — left the annotations marked "已送达" while the model had
  never seen them, and they were never sent again. The module doc claimed there
  was "nothing that can silently drop the block"; that was not true.

  Delivery is now **confirmed rather than assumed**. The host records the receipt
  of what it injected (the block's own header line, the annotation ids, and the
  `turn`/`step` it went into) and marks those annotations delivered only when
  `session/event` publishes the `user/message` that actually carries that text.
  `Session.append` dispatches its observers synchronously, so the confirmation
  lands before the request is built — no new marker is written into the message
  and no extra field is added to the log; the receipt is text the model reads
  anyway.

  When the step (`step/end`) or the turn (`turn/end`) ends without the receipt,
  the receipt is dropped and the annotations stay pending, so the next message
  carries them again — which is what "my annotation was never answered" should
  do. While one receipt is unconfirmed the session injects nothing further, so a
  block that did land cannot be duplicated.

  Cost: one `session/event` listener with an O(1) map lookup per event; the panel
  now shows "待发送" for the few hundred milliseconds between sending and the
  message entering the log instead of flipping early. One narrow duplicate window
  remains: if the process exits after the block reached the log but before the new
  status was flushed to disk, the next boot still reads those annotations as
  pending and sends them once more.

  Verified with 26/26 tests (`node --test`), including three new cases: injection
  alone is not delivery, an aborted turn re-sends on the next message, and an
  unconfirmed receipt blocks a second injection. The receipt match was also
  checked against real logged sessions: the rendered block is byte-identical to
  the `user/message` the loop appended, and every block-bearing message in the
  local history consists of the user's own text plus exactly one appended block.

### Docs

- `README`/`README.en`: the delivery description, the "delivered once" feature
  row, the defect list and the test inventory now describe the confirmed
  delivery, including the cost of the confirmation and the duplicate window.

[0.3.3]: https://github.com/RSoulYu/dsh-annotate/compare/v0.3.2...v0.3.3

## [0.3.2] - 2026-10-04

### Fixed

- **CI had been red on every push since 0.1.0, and the test command was the
  cause.** Each of the four `ci` runs failed. The *Host-half tests* step ran
  `node --test test/`, and Node 22 resolves a positional argument as a module
  path instead of a directory, so it exited 1 with
  `Cannot find module '.../test'`. Node 20 expands the same argument as a
  directory and passed — but the matrix defaults to fail-fast, so the 20 job was
  cancelled during setup and the run never reported that. Local runs could not
  catch it either: they use Node 26, which also accepts a directory.

  The workflow step and the `test` script now call `node --test` with **no**
  argument, which discovers `test/**` on Node 20, 22 and 26. Verified by running
  the full CI step list (syntax check, manifest sanity, tests) under Node
  `20.19.5` and `22.20.0`: 23/23 tests pass on both. `22.20.0` reproduces the old
  failure exactly (`pass 0`, `fail 1`, `MODULE_NOT_FOUND`).

  The matrix also sets `fail-fast: false`, so a version-specific failure reports
  both legs instead of hiding one — that cancellation is what made this take four
  pushes to notice.

  Cost: none at runtime; no plugin behaviour changed. The visible difference is
  that the repository's CI now actually goes green, which is what the README's
  "CI runs on every push" claim already implied.

### Docs

- `README`/`README.en` development sections now say `node --test` and explain
  why the path argument must not be passed, so the broken form is not copied
  back in.

[0.3.2]: https://github.com/RSoulYu/dsh-annotate/compare/v0.3.1...v0.3.2

## [0.3.1] - 2026-10-04

### Fixed

- **The documented behaviour of delivery was wrong, and it was wrong in the
  direction that matters.** Both READMEs claimed the block is "model-side
  context, not a session-log event" and that "your own bubble still shows only
  what you typed". Neither has ever been true: `agent/pre-step` returns the
  claimed `user/message` with the block appended to its `content`, and the loop
  appends exactly that message to the session log
  (`dsh-agent-loop/lib/index.js`, the single `user/message` append). The chat
  half then joins every `text` block of that message into one bubble string
  (`contentParts` → `UserStyleBubble`), so the block renders **inside your own
  bubble** and is re-sent on regenerate/fork.

  Verified against three delivered annotations in a local session log: each was a
  `user/message` with `source.kind: "user"`, `surfaceOp: "append"` and two text
  blocks — your text, then the block.

  The docs now state what actually happens, including the two consequences a
  user has to plan around: **deleting a delivered annotation does not retract the
  text from the transcript**, and **exporting or sharing that session carries the
  quoted text and the notes with it**. No runtime behaviour changed in this
  release — only the claims.

### Docs

- Recorded why "model-only, unlogged" is not an option rather than a choice:
  DSH requires model-visible content to use a logged channel, and the
  `ignorable: true` envelope that unknown stored events need cannot be set by a
  live `Session.append()`.
- Re-scoped the roadmap item that used to promise "regenerate/fork can see it"
  as the *upside* of strict mode (it is already true today) into what it really
  is: an appearance trade-off that would move the block out of your bubble into
  a separate injected-context row.

[0.3.1]: https://github.com/RSoulYu/dsh-annotate/compare/v0.3.0...v0.3.1

## [0.3.0] - 2026-10-03

### Added

- **Lazy re-anchoring.** A quote can only be located while its message is
  rendered, and the transcript loads history in pages: after a restart, an
  annotation on a message above the loaded window had no range until something
  forced a refresh. The browser half now retries localization on DOM changes and
  on scroll — debounced, rate limited, and skipped entirely while everything is
  anchored, so a finished transcript costs one array scan.
- **“Source not in view” in the panel.** A row whose quote is not currently
  reachable says so, with a tooltip explaining that scrolling to the reply makes
  the highlight and badge appear on their own.

### Changed

- `reanchor()` reports how many ranges it attached, and the retry pass repaints
  only on real progress. An unconditional repaint mutated the DOM, re-armed the
  observer that scheduled the pass, and would have spun on a quote that is simply
  not loaded yet.

### Docs

- Recorded why the block is not written into the session log: it would add
  visible transcript content, and a new event type cannot be appended at all —
  DSH accepts an unknown stored event only with an `ignorable: true` envelope,
  which a live `Session.append()` cannot set, so the session would refuse to
  reopen. The option remains on the roadmap as an explicitly-costed strict mode.

[0.3.0]: https://github.com/RSoulYu/dsh-annotate/compare/v0.2.0...v0.3.0

## [0.2.0] - 2026-10-03

### Added

- **Per-boot API token.** The host mints one random token per process and
  publishes it into the boot payload of every page it serves
  (`webserver/index-inject` → `__DSH_ANNOTATE__`); the browser half presents it
  on every request. A request is now accepted only when the `Host` is loopback
  **and** the token matches, so neither a cross-origin page nor a DNS-rebinding
  trick can reach the route. Before the first page is served the host falls back
  to the static marker header, which keeps a fresh install working while the
  browser half catches up.
- **Cross-node quote re-anchoring.** Quotes now resolve through a
  whitespace-normalized full-text index instead of a per-text-node `indexOf`, so
  a selection that spans `<strong>`, a code span or any other element boundary
  is found again after a reload, and indentation differences between the DOM and
  the copied text no longer break the match.
- **`Escape` closes the badge popover.**
- Tests for the anchoring core (`test/anchor.test.mjs`) and the authorization
  fence (`test/authorize.test.mjs`); the suite grew from 7 to 23.

### Changed

- **Re-anchoring is now one pass over the document.** The previous shape walked
  every text node once *per* annotation, which is quadratic on a long transcript;
  the index is built once and every missing quote is located against it.
- **Atomic writes survive platforms where `rename` will not replace a file.**
  The store write falls back to remove-then-rename on `EEXIST`/`EPERM`/`EACCES`
  instead of failing the save.

### Fixed

- `hostIsLocal()` is total: a request object without `headers` is refused rather
  than throwing inside the guard (found by the new authorization tests).

[0.2.0]: https://github.com/RSoulYu/dsh-annotate/compare/v0.1.0...v0.2.0

## [0.1.0] - 2026-10-03

First release. Verified against DSH `0.2.0-rc.2` on the Web profile.

### Added

- **Selection toolbar** — selecting transcript text opens a one-button
  `批注 / Annotate` toolbar in `shell.overlay`, placed above the selection and
  clamped to the viewport; it never overlaps the composer, the submit button or
  the app chrome.
- **Note editor** — `Enter` saves, `Shift+Enter` inserts a line break, `Esc`
  cancels; an empty note marks the quote only.
- **Numbered marks** — the quote is highlighted with the CSS Custom Highlight
  API (the message DOM is never mutated) and a numbered badge is drawn next to
  it, repositioned on scroll and resize.
- **Badge popover** — clicking a badge reads that annotation in place: number,
  delivery status, origin, quote, note, plus jump to source / open in sidebar /
  delete.
- **Composer chip** — a compact `✎ ×N` control in the composer tool row
  (`conversation.input.right`), immediately before the submit action.
- **Right-sidebar panel** — a `批注 / Annotations` page registered through the
  two-stage right-sidebar tab API, with per-annotation edit, delete, jump to
  source, and clear-delivered.
- **Delivery through `agent/pre-step`** — pending annotations are appended as
  one text block to the user message entering the step, separated from the
  user's own text by a blank line and a `—— 批注（共 N 处，编号 …）——` header.
  The block is delivered exactly once and is never written into the composer.
- **Host-side persistence** — `$DSH_HOME/annotations/annotations.json`, shared
  across sessions and restarts, outside every workspace.
- **`annotation` tool** — the agent can re-read annotations (`list`) or mark
  the ones it answered (`resolve`).
- **Local HTTP API** — `POST /plugins/dsh-annotate/api`, restricted to loopback
  hosts and gated behind a custom header.
- **Localisation** — UI text follows the DSH locale (`zh` / `en`).
- **Tests** — host-half delivery tests (`node --test test/`) and a GitHub
  Actions workflow running the syntax check and the suite.

### Notes

- The plugin is a workspace bundle: `cordis.patch.yml` inserts one Host row and
  `package.json` declares the browser half through `dsh.client`. No DSH core
  file is modified.
- The host half imports only `node:*` builtins, because a workspace-installed
  bundle cannot resolve `@deepseek-ai/*` packages at runtime.

[0.1.0]: https://github.com/RSoulYu/dsh-annotate/releases/tag/v0.1.0
