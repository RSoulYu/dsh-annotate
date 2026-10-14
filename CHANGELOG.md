# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.10.6] - 2026-10-14

### Fixed

- **The web UI would not open at all.** 0.10.5 shipped the browser half with
  `ctx.hostFace = testSeam` inside the shipping `apply()`. A client runtime
  fiber refuses that assignment — `cannot set property "hostFace" without
  provide` — so `apply` threw, the loader's entry went `FAILED`, and the boot
  aborted with `Failed to load plugins: dsh-annotate`. The page never reached
  the application: a reload of `dsh web` showed the boot card and nothing else,
  and restoring the working tree to the 0.10.1 bundle was the only thing that
  brought it back. Measured end to end in a real browser (headless Chromium
  against a scratch `DSH_HOME` whose plugin link pointed at the 0.10.5 tree):
  the boot fails on 0.10.5, deleting that one line restores it, and this release
  restores it with the seam moved.

  The seam now rides the object the factory returns — the module the loader
  seats, which the drive already holds — instead of the context. Its contents
  are unchanged, and no service is registered.

### Tests

- Two assertions in `test/host-contract.test.mjs` keep the rule the outage went
  around: the factory's module object must publish the seam, and the client half
  must never assign a property onto `ctx` at all. The suite's `ctx` is a plain
  object, which accepts any assignment — that is exactly why every test in this
  repository stayed green through the outage — so the fence is a source
  assertion, not a drive. Re-adding the removed line fails both (mutation
  control).

## [0.10.5] - 2026-10-14

### Fixed

- **The per-session limit of 400 did not hold, and a session could grow without
  bound.** The eviction in `AnnotationStore.create` was a
  `slice(0, overflow)` over the session's *delivered* records. `slice` returns
  **fewer** records than asked for when the pool is short, and the shortfall was
  never handled: the excess stayed on the list, past the ceiling, with nothing
  that would ever bring it back. The trigger is not "an all-pending session" —
  it is simply **an overflow larger than the pool of delivered records**, so it
  is reachable in ordinary use: click **"clear delivered"** once, the pool is
  empty, and from then on every create overflows it. It was measured, on the
  shipped code, at 401 records with an empty pool and still climbing at 461 —
  no self-correction at any point. Because `flush()` re-serializes the **whole**
  document on every write, unbounded growth is not just disk: every "save
  annotation" gets slower with the size of the session.

  `create` now decides against the **whole** overflow: it evicts the oldest
  delivered records when that pool can cover it (unchanged behaviour), and
  otherwise **refuses the create** — the new record is rolled back off the list,
  nothing is flushed, and the refusal **consumes no number and leaves no hole**:
  the next annotation still takes `highest-read + 1`, so a session's numbers
  never skip a value *because* of a refusal. (A refused create therefore does not
  advance the sequence the way an accepted one does. Whether the freed number
  itself comes back depends on the session: with every record carrying a stored
  `number`, the deleted maximum frees the top slot and the next annotation does
  take it; when the session still holds an **unnumbered** legacy record, the
  `numbering()` backfill hands that record the freed slot instead, so the
  highest read number is unchanged and the next annotation takes the following
  one. Both are the pre-existing `numbering()` semantics, untouched here.) This
  is a **user-visible
  behaviour change on one path**: where the old code accepted the write and
  returned HTTP 200, the session is now full and the write is refused with HTTP
  400. The browser half needs no change — it already rejects on `ok !== true`
  and shows "save failed" — and the server message now names the real cause
  (`session is at the 400-annotation limit; delete or clear delivered
  annotations to add more`) so it is distinguishable from a service that is
  down.

  The alternative — evicting pending records — was rejected outright: "pending
  annotations are never dropped" is the promise this plugin makes, and silently
  discarding a user's annotation is the worst failure it could have. Allowing
  the breach and merely warning about it was rejected too: without a real
  ceiling there is no convergence, which is the one thing the limit exists for.
  Refusing is the only option that keeps **both** halves — never lose an
  accepted annotation, and never grow without bound — and it says so honestly
  instead of pretending there is always room.

  The limit had **no test coverage at all**: the only test that mentioned 400
  exercised the number-backfill path, which is not a write path and never
  touches this branch. Six tests now pin the ceiling from both sides — the
  refusal, the repeat-refusal that proves there is no creep, the numbering that
  a refusal must not perturb, the eviction that must keep working, the mixed
  case where an overflow larger than the pool must not cost a single pending
  record, and the re-queue path that empties the pool — and
  `test/ceiling.mutations.sh` shows each of them going red when the fix is
  reverted, when it refuses one record too early, when the roll-back is
  skipped, and when a refusal leaks the number it was handed. That last control
  is why the numbering assertion states a **relation** — three refusals, then
  the next annotation must still take 400 — rather than one value: a leaked
  number leaves the first free value unchanged, so a single-value assertion
  holds under both implementations and guards nothing.

  **An already-breached document is not repaired.** A session that the old code
  had already pushed past 400 (the 461 measured above) stops growing from the
  first boot on this version and no pending record is ever deleted to shrink it
  — but it is **not** converged back to the ceiling either: it stays at its
  existing size and every further create against it is refused, because the
  eviction pool is what would have to absorb the overflow and the overflow now
  exceeds it. Such a session is recovered by the user, through the actions the
  refusal message names: delete annotations, or clear the delivered ones, until
  the session is back under the limit. This is deliberate — silently deleting
  annotations to make a number come out right is exactly the loss this plugin
  refuses to commit.

### Changed

- **`README.md` / `README.en.md`, "Data and privacy" table.** The capacity row
  said over-limit writes "clean the oldest delivered first and pending ones are
  never dropped", which silently implied the overflow could *always* be
  absorbed. The ceiling and the never-drop promise are both kept; the row now
  states the third case as well — when there is not enough delivered history to
  clean, a new annotation is refused and reported on the spot, and nothing that
  already exists is lost. The declaration now matches the implementation.

## [0.10.4] - 2026-10-13

### Fixed

- **A pending annotation could be marked delivered by a message the plugin
  never sent — losing the annotation for good.** Independent verification
  (`t3`) reported it, and it reproduces on the shipped code with no mutation at
  all. The in-process confirmation had two conditions joined by **OR**:
  a batch-token check, and the older `eventCarriesReceipt`, which is a plain
  `includes()` of the block's header line. That second leg looks at neither
  `source.kind` nor the token, so it alone could admit anything whose text
  contains `—— 批注（共 N 处，编号 …）——`: a plain user message quoting the block,
  an assistant reply repeating it, a tool result echoing it, or another
  batch's block carrying the same header under a different token. All four were
  measured — **the record flipped to `delivered` while the block was never in
  the log.** The header line cannot tell these apart, by construction: every
  session's first batch prints the same line (see 0.10.3 above).

  The two legs are now **one standard, and it is the one the cold-log path
  already used**: a `user/message` under the plugin's own `source.kind` whose
  text ends on THIS batch's token. `eventCarriesReceipt` and `receiptOf` are
  gone rather than kept as a fallback — a weaker second opinion that can answer
  alone is how this went wrong in the first place.

  This had **zero test coverage**: the verifier removed the leg's token gate and
  all 64 delivery tests stayed green. Four cases now pin it, each asserting the
  record stays `pending`, alongside the positive control that the real block
  still confirms — plus mutation `M6/X1` in `test/reconcile.mutations.sh`, which
  was invisible before and fails two tests now.

- **A block followed by any other text stopped being recognised, so it was sent
  a second time.** `tokenOf` and `idsOf` assumed the marker line was the last
  non-empty line of the text. A host that appends anything after the block — its
  own annotation, a wrapper — made the token unreadable, the block read as
  absent, and the annotation re-sent. Both now scan UP for the last non-empty
  line that STARTS WITH `批次`, which is what "the marker line" means
  independently of what follows it. This direction was conservative (a duplicate,
  never a loss), and mutation `M7` now covers it.

- Two comments were corrected where the implementation had drifted from what
  they claimed: the module header still described the header line as the
  delivery proof, `BATCH_MARKER` still called itself the *only* condition (the
  `source.kind` fence is equally required), and `markDelivered`'s note mentioned
  a "hold back to delivered" caller that does not exist.

## [0.10.3] - 2026-10-13

### Fixed

- **The duplicate-delivery window of README §7 is closed: a block that reached
  the session log is no longer sent a second time after a restart.** The window
  was `session.log` holding the block while the process died before
  `markDelivered` wrote the store. `inFlight` is a plain in-process `Map`, so
  the next boot started amnesiac, the records still read `pending`, and the same
  block went out again.

  The next boot now asks the **session log**, which outlives the process and is
  already the thing that decides a delivery. Right before it would send a
  session's pending annotations — never as a boot-time scan — it reads that
  session's raw event log through the host's public `sessionQuery` service and
  marks a batch delivered only when it finds the `user/message` that carries it.
  A host without that service (a TUI profile, an older build) loads and delivers
  exactly as 0.10.2 did, just without the reconciliation.

  This needed a real batch identity first, and that is the second half of the
  fix: `receiptOf` — the block's header line — is `—— 批注（共 N 处，编号 …）——`,
  decided by the batch size and the annotation numbers alone and therefore not
  unique. Every session's first batch prints the same line, a freed maximum
  number is deliberately reused (README §6), and the string appears 98 times
  across the sessions on the machine this was measured on — in tool results,
  assistant replies, and text users typed themselves. Reconciling against that
  line would have converted a duplicate delivery into a **silently swallowed
  annotation**, which is strictly worse. So each block now ends with
  `批次 <uuid> · <ids>`, the token is persisted onto the records before the
  block can reach the log, and every comparison is exact equality on that token
  (plus the plugin's own `source.kind` and the record list), never a substring
  match on the header.

  Two further rules keep the inference one-way and safe. A record remembers the
  batch it was **delivered** under and the reconciliation refuses a token that
  is already settled — without that, the first attempt's block, still sitting in
  the log, would confirm the second attempt after a re-queue; re-queues
  therefore mint a fresh token. And a failed or empty read changes **nothing**:
  an unreadable log, a missing service, an unpersisted session or a block
  removed by compaction all leave the records pending. Sending a block twice
  stays possible in exactly those cases, and that is the deliberate trade — a
  duplicate is the model reading it again, while a false delivery loses the
  user's annotation for good.

  Verified by `test/reconcile.test.mjs` (restart, no-restart, the M1/M2/M3/M5/M6
  misjudgement paths, and the fork-inherited prefix), by
  `test/real-host-drive.mjs`, which holds the assumptions against the real host
  and its real logs, and by `test/reconcile.mutations.sh`, whose five mutations
  each turn the drive red. The `annotation` tool reports revision 11.

## [0.10.2] - 2026-10-13

### Fixed

- **The host-shape fence ran nowhere.** CI set
  `DSH_ANNOTATE_HOST_ROOT=absent`, so all 22 string assertions — the mechanical
  fence against the host's public session face — were skipped in every run. The
  fence was only as strong as the machine that remembered to run it by hand. A
  new `host-shape` job installs the published host into an npm **install
  prefix** (pinned to `0.2.0-rc.2`) and runs the fence against it, with the skip
  line refused as a result: the job fails unless the log carries
  `host-shape: verified`. The root must be the prefix and not the package
  directory — every assertion's `file` already starts with
  `node_modules/@deepseek-ai/`, and npm hoists the sibling packages to
  `<prefix>/node_modules/@deepseek-ai/`. The pin matters too: a fence that
  follows `@latest` reddens the day upstream publishes whether or not anything
  drifted. A second, advisory job runs the same fence against `@alpha` with
  `continue-on-error`, so channel movement is visible without blocking.

- **A string fence cannot see a behavioural drift, and two of them were
  measured.** Deleting the two `notifier.markDirty()` calls inside the host's
  own `loadOlder()` — leaving every asserted string byte-identical — makes the
  window revision stop moving, so the plugin counts each successful page as a
  stall and the jump fails for the user. All 23 assertions stayed green. The
  same held for an early `return` inserted after the line one assertion pins.

- **H21 was a tautology** and is removed rather than downgraded.
  `"sessionId: SessionId"` matches 43 times in the runner bundle, so it could
  not fail for any slot change while still counting toward a "23 assertions
  verified" claim. H23, the anchored version that isolates the one slot entry
  that matters, stays and is strictly stronger; an assertion now fails if H21
  returns.

- **The frozen-clock gate the README names was not in CI.** The release gate —
  `node --import ./test/freeze-clock.mjs --test`, the evidence that the jump
  budget counts pages, stalls and frames instead of wall time — now runs in the
  check job.

### Added

- **`test/host-contract.test.mjs`** drives the real `runJump` / `jumpDeps` /
  `executeJump` against a behavioural host double that answers only through the
  public session face, so the two blind spots above have regression tests: a
  host whose `loadOlder()` does not advance the revision must report `stalled`,
  and a host that no-ops under its own `loadingOlder` guard must be waited for.
  Its one row that reads a real installation resolves its root from
  `DSH_ANNOTATE_HOST_ROOT` the way the shape fence does — a host that is merely
  missing is a failure there, and only an explicit `absent` skips.
  `test/host-contract.mutations.sh` is the counter-proof: M1 reproduces the
  invisible mutation (drive red, string fence green), and M4 closes a real
  coverage hole that the first pass of this work explained away as a weak
  mutant — the branch is reachable at `stalls === 2` and the mutant changes the
  outcome, so it is caught.

  The browser half republishes the host-face declarations as `ctx.hostFace` so
  the drive can reach the shipping functions rather than a copy. It is a local,
  non-exported object and the jump core is byte-identical (79 insertions, 0
  deletions). Known trade-off: it is written on the unconditional `apply()` path
  and never cleaned up, on a context the host wraps in a `get`-only proxy that
  accepts the assignment on this plugin's static bundle path. No other static
  plugin on this machine assigns to `ctx.<name>`, so it is a new pattern here
  rather than an established one.

## [0.10.1] - 2026-10-09

### Fixed

- **Clicking a numbered badge crashed the whole annotation overlay with React
  error #310 — "Rendered more hooks than during the previous render".** 0.10.0
  added the "closing this surface abandons a running jump" effect to
  `BadgePopover` and placed it *after* the component's two early
  `return null`s. The closed popover rendered two hooks (`useStore`'s
  `useState` + `useEffect`); the frame that opened it rendered three. React
  threw, the plugin's own `Boundary` caught the throw, and its fallback — the
  visible `批注插件出错：…` line — replaced the entire overlay: from the first
  badge click until the page was reloaded, the badges, the selection toolbar,
  the editor, the popover and the toast were all gone.

  Every hook now runs before the first early return, and the annotation id is
  captured up front so the effect itself stays unconditional. The abandon
  semantics are unchanged: a popover that closes or switches annotation cancels
  that annotation's jump, and only that one.

  No suite saw it because none of them rendered a component. The jump suites
  evaluate `new Function` slices of `client.js` and drive `runJump` through
  their own dependencies; `anchor` evaluates marked pure functions; `host` and
  `host-shape` assert persisted fields and host shapes. A hook-order error only
  exists as a *second* render, so nothing short of mounting the component could
  fail on it.

### Added

- **`test/popover-render.test.mjs` — the render fence this bug needed.** It
  evaluates the whole factory body of `client.js` (only the final
  `return { inject, … }` is replaced by a probe return), mounts the real
  `Overlay` with the real `react`/`react-dom` the host's browser module table
  serves (18.3.1, the version the DSH web profile pins) inside a real DOM
  (jsdom), and drives the plugin's own `togglePopover` entry point through three
  open/close rounds. It asserts that the popover surface renders while open and
  not while closed, that no frame reaches the crash boundary, and that React
  reports no change in hook order. Its second case is a mutation control: the
  same harness moves the hook back behind the early return in those bytes and
  must then reproduce the exact `批注插件出错：Rendered more hooks …` line — so a
  green run cannot mean "the harness stopped looking".

  The three dependencies are deliberately **not** in `package.json`: install
  them beside the checkout with
  `npm install --no-save --no-package-lock react@18.3.1 react-dom@18.3.1 jsdom@24`.
  The plugin keeps its zero-dependency manifest and the host profile never
  receives them. A missing dependency **fails** the suite; the only
  non-verifying path is the explicit `DSH_ANNOTATE_RENDER=absent`, which prints
  `popover render check: skipped by DSH_ANNOTATE_RENDER=absent` and must never
  be quoted as a verification. CI installs the three before the test step, and a
  following step fails the job unless that run printed
  `popover render check: verified with react 18.3.1 …`.

### Verification

- **A/B counter-proof, real renderer, shipping bytes.** Alternating 12 runs
  against `f9b9aa0` (0.10.0) and the fixed worktree: the shipping 0.10.0 bytes
  crashed on the open-popover frame **12/12** with
  `批注插件出错：Rendered more hooks than during the previous render.` and React's
  own diff (`1. useState / 2. useEffect / 3. undefined → useEffect`); the fixed
  bytes crashed **0/12** and rendered `[data-dsa-ui="popover"]` in every open
  frame and nothing in every closed one. Harness:
  `.dsh-annotate-render/verify.mjs` (react 18.3.1 + react-dom 18.3.1 + jsdom
  24.1.3); log: `.dsh-annotate-render/EVIDENCE.md`. The one environment
  stand-in is jsdom's missing `ResizeObserver`, which the plugin only uses while
  wiring listeners in `apply()` — a path that harness does not call.
- The repository suite is 150/150 locally (host shape fence included, DSH host
  present), stable over repeated runs.

[0.10.6]: https://github.com/RSoulYu/dsh-annotate/compare/v0.10.5...v0.10.6
[0.10.5]: https://github.com/RSoulYu/dsh-annotate/compare/v0.10.4...v0.10.5
[0.10.4]: https://github.com/RSoulYu/dsh-annotate/compare/v0.10.3...v0.10.4
[0.10.3]: https://github.com/RSoulYu/dsh-annotate/compare/v0.10.2...v0.10.3
[0.10.2]: https://github.com/RSoulYu/dsh-annotate/compare/v0.10.1...v0.10.2
[0.10.1]: https://github.com/RSoulYu/dsh-annotate/compare/v0.10.0...v0.10.1

## [0.10.0] - 2026-10-09

### Fixed

- **“Jump to source” did nothing when the quoted message was not in the page yet:
  it showed one toast and stopped.** The path now really jumps — the plugin asks
  the host for earlier history through the host's own public paging call and then
  lands on the quote. The transcript does not unmount messages by viewport (it
  renders every entry of the loaded event window into the DOM), so “the quote is
  not on the page” means its message is still above the loaded event window.

  - Loaded ⇒ scroll straight to the quote (byte-for-byte the 0.9.0 behaviour,
    including its refusal to accept a zero-box range).
  - Not loaded, but the host still has older history ⇒
    `ctx.sessions.binding(sessionId).session.loadOlder()` (the same call the
    host's own “load earlier” button makes) plus
    `session.getSnapshot()`'s `openState` / `hasMore` / `loadingOlder` and the
    event window's `revision` as the progress signal. The binding is resolved
    fresh on every jump and never cached: a binding is tied to one generation of
    a session, and a retained one would page the previous session.
  - Not loaded and not locatable ⇒ a **persistent** failure state: the row keeps
    the specific reason (the host provides no session / all loaded history was
    searched and the quote is not there / older history remains unloaded / the
    host returned no older history / the quote is inside a collapsed block), the
    button stays usable for a retry, and the element carries
    `data-dsa-jump="failed:<reason>"` with `data-dsa-jump-pages`. The toast still
    appears once, but it is no longer the only signal.
  - `loadOlder()` is a silent no-op while the host reports `loadingOlder === true`,
    so the loop reads `getSnapshot().loadingOlder` first and waits instead of
    re-requesting at full speed; the wait carries its own frame budget
    (two page-waits' worth of frames, `JUMP_TICKS_PER_PAGE × 2`), so a window
    that stays busy and silent reports `stalled` rather than waiting forever.
    The frozen decision table still judges `loadingOlder` before the stall
    counter — the budget is a bound on the phase that table cannot bound, not a
    change to the table — and the reveal phase carries one of the same kind
    (`JUMP_REVEAL_TRIES`), so repeated reveals that draw nothing end in `folded`.
    Both budgets are departures from the frozen design's §4.4 wording, approved by
    the captain's ruling (`RULING.md`, supplementary rulings 4 and 6): the
    decision table's eight branches, their order, the three constants and the
    five reason values are all unchanged, and the report records what departed,
    why, and who approved it.
  - Budgets: at most 60 pages per jump (`budget`), and three requests in a row
    without a window change is `stalled`. The new logic reads no wall clock — the
    budget is pages / stalls / frames — so a frozen `Date.now()` produces the
    same run.
  - A quote that is **already loaded and drawn** is scrolled to without asking
    the host for anything. A session service that is missing, unbindable or not
    open therefore costs nothing in that case — the mount-independent first step
    of the decision table runs before any host access, exactly as in 0.9.0 — and
    is reported as `no-session` only when older history really would have to be
    loaded.

### Changed

- **No persistent field is added**: `index.js` is unchanged, and a record is
  still `{ id, sessionId, quote, note, status, createdAt, updatedAt,
  deliveredAt, deliveredTurn, origin, occurrence, number }`. There is therefore
  no migration and no legacy-record fallback branch. The only new state is a
  runtime one, `store.jump = { id, gen, phase, reason, pages }`, kept beside
  `store.toast` and never written to disk.
- While a jump runs, the row shows “loading earlier messages…” and its button is
  disabled against re-entry; both are restored when the jump settles.

### Added

- **Host-shape assertions** (`test/host-shape.test.mjs`, 22 entries copied
  verbatim plus one anchored addition, H23). The suite reads the host's own
  source (`root = DSH_ANNOTATE_HOST_ROOT ?? the deployment path`) and asserts the
  public shapes the jump depends on: `ctx.sessions` in the client API catalogue,
  the `binding` / `session` / `eventSource` signatures, `loadOlder()`,
  `openState` / `hasMore` / `loadingOlder`, `revision`, and two negative facts
  (the transcript holds no `IntersectionObserver`, and the chat view never reads
  `viewRequest`). The frozen list is not reworded; H23 is added because H21's
  substring occurs 43 times in the runner bundle and therefore cannot notice one
  slot losing `sessionId`: H23 anchors the same assertion to the
  `sidebar.right.pane.tab` entry itself. If the host changes shape the suite
  fails loudly instead of staying green. A missing host root also fails; the only
  non-verifying path is an explicit `DSH_ANNOTATE_HOST_ROOT=absent`, which must
  print `host shape check: skipped by DSH_ANNOTATE_HOST_ROOT=absent`. GitHub CI
  runs without a host and sets that variable in the workflow; release evidence
  uses a local strict run instead (23/23 assertions, exit 0).
- **`test/jump-bytes.test.mjs` drives the SHIPPING bytes.** The other jump suite
  evaluates `new Function` slices of `client.js` and hands `runJump` its own
  dependencies, so it never executed `jumpDeps` / `executeJump` / `jumpTo` — and
  the 0.10.0 development round shipped a `loadOlder` collaborator that called an
  undefined identifier while that suite stayed green. This suite evaluates the
  whole factory body (only the final `return { inject: … }` is replaced by a
  probe return) and asserts on the real wiring: with the quote outside the
  loaded window and `hasMore === true`, the host's `loadOlder()` is called at
  least once and the run then lands or reports its reason; a mounted quote jumps
  with no session service at all; a busy window is waited on and never
  re-requested; the page and reveal budgets terminate. A mutation back to the
  broken shape turns it red — see `.dsh-annotate-jump/reverse-proofs.mjs`.
- `test/jump.test.mjs`: the three paths, the five failure reasons, the in-flight
  trap (a busy window is never re-requested), the stall and page budgets, the
  session-switch abort and the missing-service degradation — all asserted against
  the frozen decision table.
- `test/freeze-clock.mjs`: the `Date.now()`-frozen run.

[0.10.0]: https://github.com/RSoulYu/dsh-annotate/compare/v0.9.0...v0.10.0

## [0.9.0] - 2026-10-09

### Fixed

- **A record written before 0.8.0 carries no `number` on disk, so it was still
  numbered by position: deleting an earlier legacy annotation moved every later
  one.** 0.8.0 made the number an identity for records created from then on
  (`AnnotationStore.create` writes `max(what the session reads) + 1`,
  `normalizeRecord` keeps it), but the records already on disk carried no such
  field, so `numbering()` derived their value from `createdAt` order on every
  read — the defect 0.8.0 had just closed came back the moment the deleted
  annotation was older than 0.8.0. Reproduced on a copy of a real store:
  deleting the earliest annotation of a 20-record session moved a surviving
  record from 20 to 19.

  The host half now **backfills the missing numbers once, when it loads the
  store** (`AnnotationStore.backfillNumbers`, called from `load()` after the
  document is parsed and before the store is marked loaded):

  - only a record whose stored value is missing or invalid (not an integer of at
    least 1) is written; a value already on disk is never changed, and the
    backfill never adds, removes or reorders a record, never touches another
    field, and never trims the per-session limit;
  - the value written is exactly what `numbering()` already reported for that
    record — the one function every projection reads — so **no annotation's
    number changes**: a session with no stored numbers is still `1..N` in
    creation order, and a mixed session keeps its stored values and fills the
    legacy ones with the smallest free positions, exactly as before;
  - numbering stays per session, and a duplicated stored value keeps its
    definite reading (the earliest record in `createdAt` order keeps the value,
    the others keep reading the free position, and neither is rewritten);
  - because every read and write path awaits `load()` first, the backfill is
    complete before the first `flush()` of the boot.

### Added

- **A one-shot copy of the store before the backfill writes anything.** The
  document is copied, byte for byte, to
  `$DSH_HOME/annotations/annotations.json.migrate-0.9.0.bak` (mode `0600`)
  before a single in-memory number is changed; an existing backup is kept
  verbatim and no second one is created. If that copy cannot be written the
  backfill is abandoned for this boot — the store is left exactly as it was, a
  warning names the step, and the next boot retries. A failed store write is
  equally safe: the document is written to a temp file and renamed, and the
  in-memory backfill is rolled back, so the file on disk keeps its pre-migration
  bytes and a later flush cannot persist the rolled-back numbers either.

### Changed

- The `annotation` tool now reports `revision: 10` (`REVISION` 9 → 10) and
  `package.json` version and both READMEs' version badge: `0.8.0` → `0.9.0`.
  Both READMEs' numbering row now says the pre-0.8.0 records are backfilled once
  at plugin start (so the "session-stable" promise covers them too), the
  limitation that lists what is per session no longer says legacy records walk
  the positional path, and the storage row names the backup file.
- Why **0.9.0** and not a patch: every record in the store starts carrying a
  `number`, and one more file appears next to it — a visible change to persisted
  data and to the storage footprint, the same class of change 0.6.0 and 0.8.0
  shipped as minor.

[0.9.0]: https://github.com/RSoulYu/dsh-annotate/compare/v0.8.0...v0.9.0

## [0.8.0] - 2026-10-08

### Fixed

- **An annotation's number was a position recomputed on every read, not an
  identity — so deleting one annotation, or pressing 【清空已送达】/"clear
  delivered", silently renumbered every annotation that was still there.**
  `numbering()` sorted the records by `createdAt` and handed out `1..N` over the
  records that existed at that moment, while its own comment promised that
  "Annotation 4" always means the same annotation and both READMEs promised the
  panel's 3 is the model's `Annotation 3`. The browser half was already written
  for a stored number — `allNumbers()` prefers `item.number` and only falls back
  to the position — but nothing ever sent one: `normalizeRecord()` dropped the
  field and `AnnotationStore.create()` never wrote it, so every projection
  carried a freshly derived position: the browser half's `item.number` branch
  held for every record (its condition was true every time), and the `index + 1`
  fallback beside it was the branch that never ran.

  A number is now **assigned once, at creation, and persisted with the record**,
  next to `occurrence`:

  - `normalizeRecord` keeps an optional `number` and accepts only a
    `Number.isInteger(value) && value >= 1` (the same rule shape as the existing
    `asOccurrence`; a string, a fraction, a zero, a negative, `NaN` or an object
    becomes `undefined` and is cleaned off the record rather than trusted);
  - `AnnotationStore.create` writes `max(every number the session already reads,
    persisted and derived) + 1`, and `1` for an empty session — the new record is
    not part of that maximum, so its own derived position cannot be skipped over;
  - `numbering()` reports the stored value and derives a position only for
    records that have none: in `createdAt` order each takes the smallest positive
    integer no persisted number already owns (a duplicate value in a hand-edited
    file cannot make two records read the same).

  A session in which no record carries a persisted number is still numbered
  `1..N` in creation order — byte for byte what 0.7.0 produced — and every
  projection the host sends (`toClient`, all `handleApi` cases, the delivery
  block, the `annotation` tool) keeps reading the number from `numbering()`, so
  the wire shape is unchanged. `toClient` now carries the invariant the browser
  half depends on: **every record of every projection reads a positive integer
  `number`, never `undefined`** (all six browser-facing cases are pinned by a
  test), so the badge, the popover and the sidebar always show the number the
  delivered block means. The browser half's `allNumbers()` already preferred
  `item.number`; its positional fallback was rewritten to apply this same
  derivation instead of `index + 1`, because the two disagree in a mixed session
  (stored #5 plus two legacy records: the smallest free positions are 1 and 2,
  while `index + 1` would say 2 and 3 and point `Annotation 2` at the wrong
  record) — a projection that did omit the field now degrades to the host's own
  answer rather than to a different one.

  Costs, deliberately accepted (the three the iteration brief names):

  1. Numbers are **no longer contiguous** — delete number 1 and the survivors
     still read 2 and 3; stable beats contiguous. They are also **not a
     monotonically growing counter**: the value is `max(what the session still
     reads) + 1`, so a session that keeps creating and deleting keeps its numbers
     bounded instead of pushing them up forever. A number a surviving record still
     reads is never handed to a new annotation, and reuse exists on exactly one
     narrow edge — deleting the record that holds the session's **current
     maximum** frees that number for the next annotation (delete 3 from 1, 2, 3
     and the next annotation is 3 again; delete 2 and the next one is 4, so a
     **non-maximum number is never reused**).
  2. A record written before 0.8.0 carries no `number` on disk and still walks the
     old positional path, so deleting an *earlier legacy* record still moves it
     forward — the same trade 0.6.0 made for `occurrence` (old records keep the old
     path). Deleting and re-creating such an annotation pins a real number.
  3. **Reverting to a version before 0.8.0 wipes the persisted `number` values.**
     The older `normalizeRecord` rebuilds every record from a fixed key set and
     `flush` rewrites the whole document, so one write from an older host half
     leaves the file without the field and those records fall back to positional
     numbers. The same mechanism would later wipe any added per-session state (an
     absolute no-reuse counter, for instance), which is one more reason this
     release did not add one. Roll back only if you accept losing the numbering.

  And, as with the fields before it, the drawing surface still cannot be verified
  automatically: the suite pins the stored field, the pure numbering, the client
  table and every API projection, so the visible result needs a browser check by
  hand — create three annotations, delete the first one, and the two remaining
  badges must still read 2 and 3 (the next message's block must say `编号 2、3`,
  not `编号 1、2`).

### Changed

- The `annotation` tool now reports `revision: 9` (`REVISION` 8 → 9).
- `package.json` version, both READMEs' version badge: `0.7.0` → `0.8.0`. Both
  READMEs' numbering row now says the number is **allocated at creation and
  persisted** (so it cannot drift when other annotations are deleted or the
  delivered ones are cleared), and the limitation that lists what is per session
  spells out the three costs above: numbers stop being contiguous (and are not a
  counter that grows without bound), a surviving record's number is never handed
  to a new annotation (the freed current maximum is the one exception), records
  written before 0.8.0 keep the positional path, and rolling back to 0.7.0 or
  older erases the stored numbers.
- Why **0.8.0** and not a patch: this adds a new optional persisted identity
  field to the stored document, which is exactly what 0.6.0 did for `occurrence`
  — and that release went minor. The stored shape gains an optional key, and the
  numbers a session reads change for any session that mixes records from both
  versions (they skip values instead of counting), both observable to a reader.

[0.8.0]: https://github.com/RSoulYu/dsh-annotate/compare/v0.7.0...v0.8.0

## [0.7.0] - 2026-10-07

### Fixed

- **An annotation added while the model was still answering was delivered at once,
  with no message from the user to ride.** `agent/pre-step` fires for *every* step
  of a turn, and every step used to inject the block, so a fresh annotation was
  picked up by the very next step of a turn that had already been running —
  reported live, with the block landing on step 24 of a turn in which the user
  sent nothing.

  Delivery is now gated on what the step actually carries: the block goes out only
  when the batch the step **claimed** (`payload.messages`, the array the loop
  hands to every `agent/pre-step` listener and returns as the enter decision)
  contains a message whose `source.kind` is `user` — that is, **input attributed
  to the user**. The criterion is deliberately `source.kind`, and neither `role`
  nor `step === 1`: `createUserMessage` gives the `user` *role* to the loop's own
  runtime context and to plugin notices alike (`runtime-context`, `goal`,
  `tool-jobs`, …), and an automatic continuation round also lands on a step 1, so
  either test would re-open this exact defect. The verdict comes from the claimed
  batch rather than from `decision.messages`, which a later listener may have
  added to; the block is still injected into `decision.messages`. The old
  `role === 'user'` fallback — which would happily hang the block on a job notice
  — is gone: with no user-attributed host on the list, nothing is injected and a
  warning is logged instead.

  "Attributed to the user" is attribution, not the literal keystroke: relaying
  plugins write `source.kind === 'user'` too — `/plan <text>` steers the text you
  just typed (claimed by a later step of the same turn), `/goal` re-injects its
  attachments, agent-teams replays a slash command, and a subagent delegation
  prompt is `user` in the child session that receives it.

  Cost: an annotation added **while a turn is running** now waits for your next
  message instead of riding the step the model is already executing. Until then it
  stays "pending" (the `annotation` tool can still read it on demand), and no
  non-user step will take it away.

- **A numbered badge could be drawn on top of the composer — and, being
  clickable, take the click meant for the input box.** The badges live in a fixed,
  full-viewport layer, so nothing in the page layout stopped them from landing on
  the composer. `badgeList` now derives the page's vertical occlusion band once
  per render (`badgeBand` / `badgeOcclusionBand`, both inside the `@pure-anchor`
  slice) and drops any entry whose **badge box** (`badgeBox`: the 18 px badge at
  `max(2, rect.top - 9)`) overlaps it. The bottom edge subtracts the composer
  height the host publishes (`--dsh-composer-height`, read off
  `[data-conversation-scroll]`, falling back to the host's own `152px` default)
  from the measured transcript-scroller bottom; the head edge is the scroller's
  own top. An unreadable source contributes no edge, so nothing is guessed. The
  coordinates are never adjusted to dodge the band, and the vertical
  out-of-view filter, the scroll-away/scroll-back behavior and the overlay's
  pointer-events contract are unchanged.

  Costs, deliberately accepted: (a) an entry whose **badge box** falls inside the
  band is **not drawn at all** rather than nudged — a badge moved out of the way
  would read as an annotation that moved — so a quote whose top has scrolled
  behind the composer (or above the transcript head) loses its badge for that
  scroll position and can only be reached from the sidebar for the moment; a quote
  that merely runs *under* the composer while its badge stays clear keeps its
  badge, because the drawn box is what is judged; (b) with an extreme window the
  band's two edges can invert — 0.7.0 then drops the head edge and keeps the
  composer edge instead of inventing a second edge, so only a composer taller than
  the viewport itself (its top edge above the viewport) hides every badge — a
  known limitation; (c) the drawing side cannot be verified automatically: the
  suite pins the pure functions, so the visible result needs a browser check by
  hand — scroll a quote behind the composer (the badge should disappear while the
  composer stays clickable), scroll back (it should reappear in place, same
  number, same spot), and make the composer taller (the disappearing threshold
  should move with it).

### Changed

- `package.json`'s `description` and both READMEs now promise delivery **with the
  next message you send whose input is attributed to you**, instead of "the next
  message you send" full stop, and say that automatic continuation rounds
  (`source.kind === 'goal'`) and other plugin-injected messages never consume
  annotations. The `annotation` tool's own description ("delivered automatically
  with the next user message") already held under the gate, so it is unchanged.
  The two READMEs' delivery timing, badge and test-count sections were brought in
  line with the behavior above (0.7.0 adds 8 host cases and rewrites the badge
  cases; `node --test` reports 67 tests). Re-anchoring, jump-to-source and receipt
  confirmation were not touched.

[0.7.0]: https://github.com/RSoulYu/dsh-annotate/compare/v0.6.0...v0.7.0

## [0.6.0] - 2026-10-06

### Fixed

- **Two annotations on the same spot of a quote that appears once: the second one
  could never anchor.** 0.5.0 made re-anchoring give every annotation its own
  occurrence, computed from creation order over equal quotes
  (`quoteOccurrences`). That is right when the two annotations were made on two
  different occurrences — but it invents a wrong ordinal when they were made on
  the *same* one: with the quote present once, the second annotation was handed
  occurrence 1, `locateQuote` found nothing there, and the row kept reading
  「原文未在视图中」/ "source not in view" for good — there is no second occurrence
  to scroll to.

  The occurrence is now **captured at creation time and persisted with the
  record**. The browser half still holds the live selection `Range` at that
  moment, which is the only place the truth exists: the editor captures it as it
  opens, while the selection is still live and before a streaming re-render can
  detach what the Range points at, `occurrenceAt(index, quote, position)` (new,
  inside the `@pure-anchor` block) answers "how many occurrences lie entirely
  before this (segment, offset) position", and `saveEditor` sends it as
  `occurrence` (a non-negative integer) in the `create` request — recomputing it
  once before the editor closes when the early capture could not resolve, and
  sending no field at all when the position stays unknown, so the legacy fallback
  takes over instead of a guessed ordinal being pinned to the record. The host
  half keeps the value through all four links — `normalizeRecord` accepts an
  optional `occurrence` and keeps only a finite non-negative integer (a string, a
  fraction, a negative, `NaN` or an object becomes `undefined`, and nothing
  throws), `AnnotationStore.create` and `case 'create'` pass it through, and
  `toClient` returns it — so a reload still knows where each annotation was made.

  `reanchor` and `jumpTo` now locate each annotation at the occurrence stored on
  its own record, and fall back to the creation-order table only for records that
  do not carry one (everything written by 0.5.0 and older). The fallback table is
  built among those legacy records alone: a record that knows its own occurrence
  must not consume an ordinal and push an older record somewhere else. Both
  reported scenarios are pinned by tests: one occurrence, annotated twice at the
  same spot → both records say 0 and both anchor there; two occurrences, each
  annotated once → 0 and 1, each on its own place (the 0.5.0 fix, unchanged).

  Cost: records written before 0.6.0 keep the old creation-order guess, so a
  0.5.0 session whose second annotation landed on an already-annotated single
  occurrence still reads "source not in view" until that annotation is re-created.
  The same guess fails in the other direction as soon as one session mixes
  versions: with the quote present **twice**, a legacy record (no `occurrence`
  field) that was made on the **second** occurrence is handed ordinal 0 by the
  fallback table and silently lands on the **first** one — 0.5.0 did the same with
  the same input, so this is the residual cost of not having captured the value
  back then, not a 0.6.0 regression（0.5.0 同输入亦如此，非本次回归）. Deleting that
  annotation and re-creating it on the spot stores the true ordinal and pins it.
  代价：**浏览器绘制面无法自动验证** —— 高亮与徽标最终落在哪一处、【跳回原文】
  滚到哪，只能在浏览器里人工确认；单测钉住的是纯函数与持久化字段，不是绘制。

### Added

- **A regression test that pins "the log confirms; the abort does not
  un-deliver".** `test/host.test.mjs` now drives the whole sequence:
  `agent/pre-step` injects the block, the log publishes the `user/message` that
  carries it (the record flips to `delivered`), and then
  `turn/end { reason: { kind: 'aborted' } }` arrives — the record must still read
  `delivered`, and the next message must not carry it again. That behaviour was
  already the design ("delivered" is confirmed by the log, never assumed); it was
  only described by a narrow-window test plus a comment that read "the stop
  button aborted the turn before the loop appended the message". The comment
  conflated two different situations and is now precise: the pending case is the
  narrow window between `agent/pre-step` returning and the message reaching the
  log, *not* what pressing stop does in general.

- **Host-half coverage for the new field.** `create` persists the occurrence and
  hands it back in both projections; a malformed value is dropped without failing
  the request; a record shaped like a 0.5.0 file (no `occurrence` key at all)
  still loads, lists and is delivered exactly as before. The `annotation` tool now
  reports `revision: 7`.

### Docs

- `README`/`README.en`: the feature table, the HTTP `create` payload, the stored
  JSON shape, the re-anchoring limitation (which now explains the creation-time
  capture, the legacy fallback and the drawing-only cost) and the test count
  (33 → 46).

[0.6.0]: https://github.com/RSoulYu/dsh-annotate/compare/v0.5.0...v0.6.0

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
