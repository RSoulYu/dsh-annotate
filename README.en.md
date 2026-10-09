# dsh-annotate

**Select text in the DSH Web transcript, annotate it, and it rides your next message to the model — answered by number.**

[![ci](https://github.com/RSoulYu/dsh-annotate/actions/workflows/ci.yml/badge.svg)](https://github.com/RSoulYu/dsh-annotate/actions/workflows/ci.yml) [![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE) [![version](https://img.shields.io/badge/version-0.9.0-green.svg)](CHANGELOG.md)

[简体中文](README.md) | **English** · [CHANGELOG](CHANGELOG.md)

## What it is

When a long answer raises a question about two or three specific sentences, you normally have to copy the quotes into the composer by hand. This plugin closes that gap:

1. **Select a sentence** in the transcript and write an annotation (or leave it empty to just mark the text);
2. Keep typing and press enter as usual — **no manual quoting**;
3. Before your message reaches the model, the plugin appends the annotation block **as its own separate message**;
4. The model answers them one by one as `Annotation 1: …`.

A pure plugin: `cordis.patch.yml` inserts a single Host row and touches no file of DSH itself.

## Install

```sh
dsh plugin --profile <profile> add github:RSoulYu/dsh-annotate
dsh plugin --profile <profile> remove dsh-annotate    # uninstall
```

Requires DSH `0.2.0-rc.2` (the slots and two-stage registration contracts it uses follow 0.2.x; `0.1.x` is not supported). After changing `client.js` a browser hard refresh is enough; after changing `index.js` restart `dsh web`.

## Usage

| Action | How |
|---|---|
| Add | Select text → click the floating "annotate" button → type → `Enter` to save (`Shift+Enter` newline, `Esc` cancel) |
| Read | Click the **numbered badge** beside the quote for an in-place card: number, status, quote, note, plus jump-to-quote / open in sidebar / redeliver / delete |
| Manage | Click the `✎ ×N` chip at the right of the composer toolbar to open the sidebar "Annotations" tab: edit / delete / jump / redeliver / clear delivered / refresh |
| Send | Just type and press enter. An injected-context line appears in the transcript — **your own bubble still contains only your own words** |

On the model side the `annotation` tool is available: `list` to re-read, `resolve` to mark as answered (especially useful once context has been compacted).

## Capabilities

| Capability | Description |
|---|---|
| Non-invasive | Touches no file of DSH, injects no node into the message DOM, hijacks no keystroke (`Enter` is consumed only while the annotation editor has focus); with no annotations, nothing of this plugin is on screen |
| Quote highlighting | Uses the **CSS Custom Highlight API** and never rewrites the rendered message node tree |
| Cross-session persistence | Annotations live host-side, surviving sessions and restarts without polluting any workspace; the chip and sidebar list come back at once, and highlights and badges re-anchor by quote |
| Session-stable numbering | A number is **allocated once, at creation, and persisted with the record**: deleting another annotation or clicking "clear delivered" never renumbers one that is still there, so number 3 in the panel is `Annotation 3` in the model's reply — they never drift apart. An annotation written before 0.8.0 carries no number and is **backfilled once at plugin start** (an automatic copy of the store is kept beside it first), so older annotations no longer move either |
| Deliver once | An annotation is marked delivered; a delivered one can be sent back to pending with **Redeliver** to ride the next message again |
| Correct with repeated quotes | The quote's occurrence index is captured at creation time and persisted, and re-anchoring prefers it |

## How it works

```
selection ─▶ annotations stored host-side ─▶ agent/pre-step appends a separate message ─▶ model answers by number
                                                 └─ session/event confirms "delivered"
```

Delivery only counts a step whose received input is **attributed to you** (`source.kind`): an annotation added mid-turn is not picked up by the step already running, and neither automatic continuation rounds nor job notices consume it. **Delivery is confirmed only when that message actually reaches the session log** — abort before that and the annotations fall back to pending.

Every extension point used is a documented DSH service or slot contract (`agent/pre-step`, `session/event`, `ctx.tools.register`, `webServer.register`, `shell.overlay`, `conversation.input.right`, `sidebar.right.pane.tab`, `ctx.locale`) — no upstream patching, so the blast radius on a DSH upgrade stays small.

## Data and privacy

| Item | Detail |
|---|---|
| Storage | `$DSH_HOME/annotations/annotations.json`, mode `0600`; written to a temp file then `rename`d, concurrent writes serialized; before backfilling numbers it writes `annotations.json.migrate-0.9.0.bak` beside the store (mode `0600`, an existing copy is kept and no second one is created) |
| Capacity | At most 400 per session; beyond that the oldest delivered annotations are cleaned first and pending ones are never dropped |
| Length | Quote 2000 chars, note 4000 chars (truncated); request body capped at 512 KiB |
| API auth | Loopback `Host` plus a one-time token minted per boot and injected only into pages this process serves |
| Network | **No outbound requests at all** — it writes local files and serves the local browser only |

## Limitations

1. **The annotation block is a separate message in the session log, not your words.** Your message's `content` is not changed by a single byte; the block renders as an injected-context line. Two consequences: **deleting a delivered annotation does not retract it from the transcript**, and **exporting or sharing that session carries the quotes and notes with it** (the plugin itself makes no outbound requests — it depends only on what you do with the session). Conversely, regenerating a reply makes the model see the block again.
2. **Host-side changes need a restart.** `client.js` only needs a refresh; `index.js` needs `dsh web` restarted.
3. **Re-anchoring after a refresh is quote-based.** Matching uses a whitespace-normalized full-text index, so selections spanning nodes and whitespace differences are recovered; a quote not present in the current page (virtualized away, say) is labelled "quote not in view" and filled in when you scroll to it. **The browser rendering surface cannot be verified automatically** — unit tests pin the pure functions and persisted fields only.
4. **Platform and scope.** Web only (no TUI/terminal build); text only — text inside images and structured content in tool cards cannot be selected (plain text in tool output can). Numbering is per session: the first annotation of a session is 1, and it is not continuous across sessions. A number is an identity **allocated at creation and never changed afterwards**: deleting an annotation or clicking "clear delivered" never renumbers one that is still there (so numbers are **no longer contiguous**). A new number is "the highest one still read + 1" — not a counter that never looks back, so a session that keeps creating and deleting does not push its numbers up without bound; it can never collide with a record that is still there, and the one historical number that can come back is the one freed by deleting the **current maximum** (delete 3 from 1, 2, 3 and the next annotation is 3 again; delete 2 and the next one is 4, so a **non-maximum number is never reused**). **A record written before 0.8.0 carries no `number` and is backfilled once, at plugin start** — the value written is the one it already read by position, so deleting an earlier legacy record no longer moves it; the backfill runs once, leaves a copy of the store beside it first, and if it cannot write that copy it writes nothing this boot and retries on the next start. One rollback cost comes with it: **reinstalling a version before 0.8.0 erases the stored `number` values** (the older host rebuilds every record from a fixed key set and rewrites the whole document), and those annotations fall back to positional numbering. Rolling back to 0.8.0 keeps the backfilled numbers but never backfills newly appearing legacy records; reinstalling 0.9.0 backfills again (an existing backup is never overwritten).
5. **Delivery happens only on a step that carries input attributed to you.** The test is whether the step's claimed input contains a message whose `source.kind === 'user'`, not whether you literally typed it. The cost: **an annotation added mid-turn waits for your next real message**. There is a narrow duplicate window — the block is already in the log but the process exits before writing "delivered", so it is sent once more on the next start.
6. **Local data boundary.** Loopback `Host` plus the one-time token keep other pages and scripts on the same machine out; but **a local process running as the same user can still read the JSON file directly** — that is a file-permission boundary, outside this plugin's scope. Notes are stored in plaintext (`0600`); anything sensitive you paste stays in cleartext under `$DSH_HOME/annotations/` until you delete it by hand or from the panel.
7. **Environment.** Highlighting needs the CSS Custom Highlight API (Chromium 105+); without it you simply lose the background tint and nothing else. The code uses only `node:*` and browser APIs, but it has **not been tested on macOS or Windows**.
8. **Badge occlusion clipping.** When the badge itself would land in the composer (or conversation header) occlusion band, that badge is **not rendered at all and is never moved off its anchor** — you can still jump to, edit, delete or redeliver it from the sidebar tab. At extreme window sizes the band's two edges invert; the handling drops the header edge and keeps only the composer edge.

## Development

```sh
node --check index.js && node --check client.js   # syntax check
node --test                                       # unit tests (auto-discovers test/)
```

> Do **not** pass `test/` as a path argument: Node 22 treats it as a module path to `require` and exits immediately.

CI runs on Node 20 and 22. The `anchor` suite tests **the shipped code itself**: the core functions are fenced in `client.js` under `@pure-anchor` and the tests evaluate that source directly, so there is no "green suite, different implementation in production" gap. For troubleshooting, look for the `[dsh-annotate]` prefix in the browser console — every interaction handler has a fallback that logs and shows a visible notice rather than failing silently.

## License

[MIT](LICENSE) © 2026 RSoulYu
