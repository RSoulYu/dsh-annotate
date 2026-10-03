# dsh-annotate

> Select text in the DSH Web transcript, annotate it, and the host delivers the
> annotations **with the next message you send** — the model answers them by number.

[![ci](https://github.com/RSoulYu/dsh-annotate/actions/workflows/ci.yml/badge.svg)](https://github.com/RSoulYu/dsh-annotate/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

[简体中文](README.md) | **English (summary)**

This is a summary. The full documentation — including the injected block format,
the HTTP API, the data/privacy table and the complete list of limitations — lives
in the [Chinese README](README.md). The sections below cover everything a new
user or a reviewer needs.

---

## What it is

A pure plugin for DSH (DeepSeek Harness) Web. You select a sentence in a reply,
write a note (or leave it empty to mark the quote only), and keep typing your
question as usual. Right before your message reaches the model, the host appends
an annotation block to it:

```
—— 批注（共 1 处，编号 1）——

1. 原文：「the sentence you marked」
   批注：your note

请用「Annotation 1：…」的格式逐条回应；…
```

Nothing is written into the composer, and your own bubble still shows only what
you typed. `cordis.patch.yml` inserts exactly one host row; no DSH core file is
touched.

## Features

| | |
|---|---|
| Select to annotate | A small one-button toolbar appears above the selection; it is viewport-clamped and never overlaps the composer or the submit button |
| Note optional | Empty note = mark the quote only |
| Read in place | Click the numbered badge next to the quote for a popover with the quote, the note, and jump-to-source / open-in-sidebar / delete |
| No DOM surgery | Highlights use the CSS Custom Highlight API; message content is never modified |
| Composer chip | `✎ ×N` in the composer tool row, immediately before Send; rendered only when the session has annotations |
| Right-sidebar panel | A two-stage right-sidebar tab with edit / delete / jump / clear-delivered / refresh |
| Durable | `$DSH_HOME/annotations/annotations.json`, shared across sessions and restarts, outside every workspace |
| Stable numbering | Panel #3 is `Annotation 3` in the reply |
| Delivered once | Annotations are marked delivered when injected and never re-sent |
| Agent tool | `annotation` with `list` / `resolve` actions, for re-reading after a compaction |

## Install

```sh
dsh plugin --profile web add github:RSoulYu/dsh-annotate   # from GitHub
dsh plugin --profile web add /path/to/dsh-annotate         # from a local checkout
dsh plugin --profile web remove dsh-annotate               # uninstall
```

Changing `client.js` needs a browser hard refresh; changing `index.js` needs a
`dsh web` restart, because this profile ships with module HMR disabled
(`hmr.root: []`).

## Requirements

- DSH `0.2.0-rc.2` (Web profile). `0.1.x` is **not** supported: the plugin uses
  `conversation.input.right`, the two-stage right-sidebar tab registration and
  `ctx.sidebarRight.openTab`.
- Chromium 105+ for the highlight (everything else keeps working without it).
- The right-sidebar tab depends on `@deepseek-ai/dsh-client-ui-sidebar-right`
  being enabled.

## Strengths

- **Nothing can silently drop an annotation.** Delivery is decoupled from the
  composer, from the transcript DOM and from keyboard timing — the three usual
  causes of "I marked it but the model never saw it".
- **Zero intrusion.** No DSH core changes, no injected nodes inside messages, no
  key interception.
- **Readable model context.** One numbered block with quoted sources, and an
  explicit instruction not to restate the quotes.
- **Persistent and reviewable.** Annotations survive the send, the session and a
  restart; the agent can re-read them on demand.
- **Zero footprint when unused.** No annotations, no UI.
- **Survives a reload.** Quotes are re-located through a whitespace-normalized
  index, across node boundaries, in one pass over the document.
- **Fenced API.** Loopback `Host` plus a per-boot token that only the pages this
  process served ever see.

## Limitations

1. **The block is model-side context, not a session-log event.** Regenerating or
   forking a reply will not re-deliver it (use the `annotation` tool), and the
   transcript keeps no record of what you annotated.
2. **Host-half edits need a restart** (see above).
3. **Re-anchoring after a reload is quote-based.** Badges and highlights rely on
   a live `Range`; after a refresh the quote is relocated through a
   whitespace-normalized full-text index, so selections spanning several text
   nodes and whitespace differences both work. A quote that is no longer in the
   document at all (for example a message virtualized out of the transcript)
   still cannot be located — the panel always keeps the full quote.
4. **Web only.** There is no TUI build.
5. **Text only.** Text inside images or inside structured tool-call cards cannot
   be selected.
6. **Numbering is per session.**
7. **The local HTTP route is fenced, not private.** Two gates: the `Host` must be
   loopback (DNS rebinding), and the request must carry a per-boot token that is
   written only into the boot payload of pages this process served. A local
   process running as the same user can still read
   `~/.dsh/annotations/annotations.json` directly (mode `0600`).
8. **Plaintext storage** (`0600`). Sensitive text pasted into a note stays in
   `~/.dsh/annotations/` until you delete it.
9. **Verified on Linux only.** The code uses `node:*` builtins and browser APIs,
   so it should be portable, but macOS/Windows are untested.

## Development

```sh
node --check index.js && node --check client.js
node --test test/          # 23 tests: delivery, authorization, anchoring
```

The anchoring tests exercise the shipped code: the core is marked `@pure-anchor`
inside `client.js` and the test evaluates that exact slice, so there is no second
copy of the algorithm to drift.

The host half imports only `node:*` builtins — a workspace-installed bundle
cannot resolve `@deepseek-ai/*` packages at runtime. The browser half only
requires `react` from the browser module table.

## License

[MIT](LICENSE) © 2026 RSoulYu
