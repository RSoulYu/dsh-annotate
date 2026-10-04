# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
