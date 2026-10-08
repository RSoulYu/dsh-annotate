/**
 * Browser-half quote anchoring.
 *
 * The anchoring core lives inside `client.js`, which is a ModuleLoader bundle
 * rather than a module. The test therefore extracts the slice between the
 * `@pure-anchor` markers and evaluates exactly that source, so what runs here is
 * the shipped code — there is no second copy to drift out of sync.
 *
 * Run with: node --test
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const source = await readFile(new URL('../client.js', import.meta.url), 'utf8')
const from = source.indexOf('/* @pure-anchor')
const to = source.indexOf('/* @pure-anchor-end */')
assert.ok(from !== -1 && to > from, 'client.js must carry the @pure-anchor markers')

const {
  normalizeQuote,
  buildAnchorIndex,
  locateQuote,
  quoteOccurrences,
  occurrenceAt,
  storedOccurrence,
  wantedOccurrences,
  badgeBox,
  badgeBand,
  badgeVisibleIn,
  BADGE_SIDE,
} = new Function(
  `${source.slice(from, to)}\nreturn { normalizeQuote, buildAnchorIndex, locateQuote, quoteOccurrences, occurrenceAt, storedOccurrence, wantedOccurrences, badgeBox, badgeBand, badgeVisibleIn, BADGE_SIDE }`,
)()

/** Build the segment list the browser side would hand to the index. */
function segmentsOf(...texts) {
  return texts.map((text) => ({ text }))
}

/** Flatten a match into segment/offset coordinates so assertions read like a comment. */
function resolve(match) {
  if (match === null) return null
  return { start: [match.start.s, match.start.o], end: [match.end.s, match.end.o] }
}

/** Convenience: locate one quote in freshly built segments. */
function find(segments, quote, wanted = 0) {
  return resolve(locateQuote(buildAnchorIndex(segments), quote, wanted))
}

/** A (segment, offset) position, in the coordinates the browser side hands over. */
function at(s, o) {
  return { s, o }
}

test('normalizeQuote collapses whitespace the way a copied selection does', () => {
  assert.equal(normalizeQuote('  a\n\n  b\tc  '), 'a b c')
  assert.equal(normalizeQuote(null), '')
  assert.equal(normalizeQuote(undefined), '')
  assert.equal(normalizeQuote('already clean'), 'already clean')
})

test('a quote inside one segment resolves to that segment', () => {
  assert.deepEqual(find(segmentsOf('the quick brown fox'), 'quick'), { start: [0, 4], end: [0, 8] })
})

test('a quote that spans several text nodes still resolves', () => {
  // The rendered DOM splits "quick brown" across <strong> and the text after it;
  // a per-node indexOf can never find this.
  const segments = segmentsOf('the ', 'quick', ' brown', ' fox')
  assert.deepEqual(find(segments, 'quick brown'), { start: [1, 0], end: [2, 5] })
})

test('whitespace differences between DOM text and the copied quote do not matter', () => {
  const segments = segmentsOf('alpha\n      beta   gamma')
  assert.deepEqual(find(segments, normalizeQuote('alpha beta gamma')), { start: [0, 0], end: [0, 23] })
})

test('repeated quotes are addressable by occurrence', () => {
  const segments = segmentsOf('same here', ' and ', 'same here')
  assert.deepEqual(find(segments, 'same here', 0).start, [0, 0])
  assert.deepEqual(find(segments, 'same here', 1).start, [2, 0])
  assert.equal(find(segments, 'same here', 2), null)
})

test('a missing or empty quote resolves to null instead of throwing', () => {
  const segments = segmentsOf('nothing to see')
  const index = buildAnchorIndex(segments)
  assert.equal(locateQuote(index, 'absent', 0), null)
  assert.equal(locateQuote(index, '', 0), null)
  assert.equal(locateQuote(index, null, 0), null)
  assert.equal(locateQuote(index, 'nothing', 5), null)
})

test('the separator space created between segments maps to no segment', () => {
  // 'foo ' then 'bar' normalizes to 'foo bar': the space exists in the haystack
  // but belongs to neither node, so it must never start or end a match.
  const segments = segmentsOf('foo ', 'bar')
  const index = buildAnchorIndex(segments)
  assert.equal(index.text, 'foo bar')
  assert.equal(index.map[3], null)
  assert.deepEqual(resolve(locateQuote(index, 'foo bar', 0)), { start: [0, 0], end: [1, 2] })
})

test('a whitespace run straddling two segments still separates the words', () => {
  assert.deepEqual(find(segmentsOf('Hello ', 'world'), 'Hello world'), { start: [0, 0], end: [1, 4] })
})

test('segments concatenate exactly as the DOM does', () => {
  // Two text nodes with no whitespace between them are adjacent in the rendered
  // document too ('   lead' + 'trail   ' renders as '   leadtrail   '), so a
  // synthetic separator would invent a word break the user never saw.
  const segments = segmentsOf('   lead', 'trail   ')
  const index = buildAnchorIndex(segments)
  assert.equal(index.text, 'leadtrail')
  assert.equal(index.map[0].s, 0)
  assert.equal(index.map[index.map.length - 1].s, 1)
})

test('an empty segment list is handled', () => {
  const index = buildAnchorIndex([])
  assert.equal(index.text, '')
  assert.equal(locateQuote(index, 'anything', 0), null)
})

test('quoteOccurrences numbers equal quotes by creation order, for every annotation', () => {
  // The table is built over the whole session, so it does not care whether an
  // annotation still has a live range — only `reanchor`'s caller knows that.
  // 0.6.0 makes this the FALLBACK path: records that captured their own
  // occurrence at creation are believed instead (see `wantedOccurrences`).
  const annotations = [
    { id: 'b', quote: 'same here', createdAt: 200 },
    { id: 'a', quote: 'same here', createdAt: 100 },
    { id: 'c', quote: 'same here', createdAt: 300 },
    { id: 'd', quote: 'another sentence', createdAt: 400 },
  ]
  assert.deepEqual({ ...quoteOccurrences(annotations) }, { a: 0, b: 1, c: 2, d: 0 })

  // Same timestamp: the input order is preserved (stable sort), so the record
  // the host listed first keeps the earlier occurrence.
  const tieA = { id: 'x', quote: 'tie', createdAt: 500 }
  const tieB = { id: 'y', quote: 'tie', createdAt: 500 }
  assert.deepEqual({ ...quoteOccurrences([tieB, tieA]) }, { y: 0, x: 1 })
})

test('an already anchored older sibling does not push the later annotation onto the first occurrence', () => {
  // Two annotations of one sentence, rendered twice (segments 0 and 2). The
  // older one (a) already has a live range, so only the newer one (b) is
  // relocated. The old code counted occurrences among the MISSING annotations
  // only, which gave b ordinal 0 and highlighted a's sentence; with the table,
  // b owns ordinal 1 and lands on the second occurrence.
  const annotations = [
    { id: 'a', quote: 'same here', createdAt: 100 },
    { id: 'b', quote: 'same here', createdAt: 200 },
  ]
  const segments = segmentsOf('same here', ' and ', 'same here')
  const occurrences = quoteOccurrences(annotations)
  assert.equal(occurrences.a, 0)
  assert.equal(occurrences.b, 1)
  assert.deepEqual(find(segments, 'same here', occurrences.a), { start: [0, 0], end: [0, 8] })
  assert.deepEqual(find(segments, 'same here', occurrences.b), { start: [2, 0], end: [2, 8] })
})

test('quoteOccurrences normalizes before comparing and tolerates odd input', () => {
  const occurrences = quoteOccurrences([
    { id: 'a', quote: 'alpha\n   beta', createdAt: 1 },
    { id: 'b', quote: 'alpha beta', createdAt: 2 },
    { id: 'c', quote: null, createdAt: 3 },
    { id: 'd', quote: '', createdAt: 4 },
  ])
  // The two spellings of the same sentence are one quote with two occurrences;
  // every quote seen for the first time starts at 0.
  assert.deepEqual({ ...occurrences }, { a: 0, b: 1, c: 0, d: 1 })
  assert.deepEqual({ ...quoteOccurrences([]) }, {})
  assert.deepEqual({ ...quoteOccurrences(undefined) }, {})
})

/* ------------------------------------------- creation-time occurrence (0.6.0) */

test('occurrenceAt answers with the occurrence a position sits on', () => {
  const index = buildAnchorIndex(segmentsOf('same here', ' and ', 'same here'))
  // The first occurrence: its first character, the middle of it, its last one.
  assert.equal(occurrenceAt(index, 'same here', at(0, 0)), 0)
  assert.equal(occurrenceAt(index, 'same here', at(0, 4)), 0)
  assert.equal(occurrenceAt(index, 'same here', at(0, 8)), 0)
  // The second occurrence.
  assert.equal(occurrenceAt(index, 'same here', at(2, 0)), 1)
  assert.equal(occurrenceAt(index, 'same here', at(2, 7)), 1)
  // One character past the first occurrence: that one is over, so the second is
  // the answer — the position belongs to no occurrence of its own yet.
  assert.equal(occurrenceAt(index, 'same here', at(0, 9)), 1)
})

test('occurrenceAt counts the occurrences that lie entirely before the position', () => {
  const index = buildAnchorIndex(segmentsOf('lead same here tail'))
  // "same here" ends at offset 13; 18 is the last character of the segment.
  assert.equal(occurrenceAt(index, 'same here', at(0, 18)), 1)
  // A position in a later segment, past every occurrence: the total count. A
  // caller asking for that many occurrences simply gets a miss from
  // `locateQuote`, which is the safe answer for a position nothing can anchor.
  const twice = buildAnchorIndex(segmentsOf('same here', ' and ', 'same here'))
  assert.equal(occurrenceAt(twice, 'same here', at(3, 0)), 2)
  // A position before the first occurrence is occurrence 0.
  assert.equal(occurrenceAt(index, 'same here', at(0, 0)), 0)
})

test('occurrenceAt maps positions in collapsed whitespace like the following character', () => {
  const index = buildAnchorIndex(segmentsOf('same here', ' and ', 'same here'))
  // Segment 1 is whitespace only, so it owns no character of the haystack; a
  // selection starting in it still means the occurrence that follows.
  assert.equal(occurrenceAt(index, 'same here', at(1, 0)), 1)
  assert.equal(occurrenceAt(index, 'same here', at(1, 4)), 1)
})

test('occurrenceAt is safe on empty quotes, absent quotes and odd positions', () => {
  const index = buildAnchorIndex(segmentsOf('nothing to see'))
  assert.equal(occurrenceAt(index, '', at(0, 0)), 0)
  assert.equal(occurrenceAt(index, null, at(0, 0)), 0)
  assert.equal(occurrenceAt(index, 'absent', at(0, 0)), 0)
  assert.equal(occurrenceAt(index, 'nothing', null), 0)
  assert.equal(occurrenceAt(index, 'nothing', undefined), 0)
  // The quote is normalized inside, so a raw selection still works.
  assert.equal(occurrenceAt(index, '  nothing\n  to  ', at(0, 0)), 0)
})

test('storedOccurrence accepts only a finite non-negative integer', () => {
  assert.equal(storedOccurrence({ occurrence: 0 }), 0)
  assert.equal(storedOccurrence({ occurrence: 7 }), 7)
  for (const bad of ['1', -1, 1.5, Number.NaN, Infinity, -Infinity, null, undefined, {}, [], true]) {
    assert.equal(storedOccurrence({ occurrence: bad }), null, `${String(bad)} must not be trusted`)
  }
  assert.equal(storedOccurrence(undefined), null)
  assert.equal(storedOccurrence(null), null)
})

test('wantedOccurrences believes the occurrence captured at creation', () => {
  // The reported regression, at the pure layer: the quote appears ONCE and two
  // annotations were made on that one place. Both captured 0, so both locate to
  // it; the creation-order table would have handed the second one ordinal 1,
  // which does not exist, and it would read "source not in view" forever.
  const annotations = [
    { id: 'a', quote: 'only once', occurrence: 0, createdAt: 100 },
    { id: 'b', quote: 'only once', occurrence: 0, createdAt: 200 },
  ]
  const segments = segmentsOf('only once')
  const wanted = wantedOccurrences(annotations)
  assert.equal(wanted.a, 0)
  assert.equal(wanted.b, 0)
  assert.deepEqual(find(segments, 'only once', wanted.a), { start: [0, 0], end: [0, 8] })
  assert.deepEqual(find(segments, 'only once', wanted.b), { start: [0, 0], end: [0, 8] })
})

test('wantedOccurrences keeps the 0.5.0 two-spot case working', () => {
  // The quote appears twice and the two annotations were made on the two
  // different places: the captured ordinals 0 and 1 must stay 0 and 1.
  const annotations = [
    { id: 'a', quote: 'same here', occurrence: 0, createdAt: 100 },
    { id: 'b', quote: 'same here', occurrence: 1, createdAt: 200 },
  ]
  const segments = segmentsOf('same here', ' and ', 'same here')
  const wanted = wantedOccurrences(annotations)
  assert.equal(wanted.a, 0)
  assert.equal(wanted.b, 1)
  assert.deepEqual(find(segments, 'same here', wanted.a), { start: [0, 0], end: [0, 8] })
  assert.deepEqual(find(segments, 'same here', wanted.b), { start: [2, 0], end: [2, 8] })
})

test('records without a usable occurrence fall back to the creation-order table', () => {
  // Read back from a 0.5.0 JSON, or written by a hostile client: every record
  // that does not carry a finite non-negative integer is numbered the old way,
  // among those records only, in creation order.
  const annotations = [
    { id: 'old', quote: 'legacy', createdAt: 100 },
    { id: 'next', quote: 'legacy', createdAt: 200 },
    { id: 'str', quote: 'legacy', occurrence: '1', createdAt: 300 },
    { id: 'neg', quote: 'legacy', occurrence: -1, createdAt: 400 },
    { id: 'frac', quote: 'legacy', occurrence: 1.5, createdAt: 500 },
    { id: 'nan', quote: 'legacy', occurrence: Number.NaN, createdAt: 600 },
    { id: 'inf', quote: 'legacy', occurrence: Number.POSITIVE_INFINITY, createdAt: 700 },
    { id: 'null', quote: 'legacy', occurrence: null, createdAt: 800 },
  ]
  const wanted = wantedOccurrences(annotations)
  assert.deepEqual(
    ['old', 'next', 'str', 'neg', 'frac', 'nan', 'inf', 'null'].map((id) => wanted[id]),
    [0, 1, 2, 3, 4, 5, 6, 7],
  )
})

test('a record that knows its occurrence does not consume a fallback ordinal', () => {
  const annotations = [
    { id: 'first', quote: 'same here', createdAt: 100 },
    { id: 'captured', quote: 'same here', occurrence: 0, createdAt: 200 },
    { id: 'later', quote: 'same here', createdAt: 300 },
  ]
  const wanted = wantedOccurrences(annotations)
  assert.equal(wanted.captured, 0, 'the captured value is used as it is')
  // The table is built over the two legacy records alone, so `later` is their
  // second quote: 1 — not 2, which is what counting `captured` too would give.
  assert.equal(wanted.first, 0)
  assert.equal(wanted.later, 1)
  assert.deepEqual({ ...wantedOccurrences([]) }, {})
  assert.deepEqual({ ...wantedOccurrences(undefined) }, {})
})

/* ------------------------------------------- badge overlay visibility ---- */

/** A quote rect in the viewport coordinates rangeRect() hands the badge builder. */
function rectOf(top, bottom, left = 40) {
  return { top, bottom, left }
}

/** The badge box for a 40px-tall quote starting at `top`. */
function boxAt(top) {
  return badgeBox(rectOf(top, top + 40))
}

test('the extracted slice reaches for no DOM at all', () => {
  // The slice is evaluated as it ships, so a DOM member access in it would only
  // show up in the browser. Guard it here: the browser half reads the page.
  assert.doesNotMatch(
    source.slice(from, to),
    /\b(document|window|getComputedStyle|requestAnimationFrame|navigator|localStorage)\s*\./,
  )
})

test('the box that is judged is the box the renderer is given', () => {
  assert.deepEqual(badgeBox(rectOf(300, 340)), { top: 291, left: 29, right: 47, bottom: 309 })
  assert.equal(BADGE_SIDE, 18, 'the painted size is still 18px')
  // Clamped near the viewport edges exactly like the coordinates were before.
  assert.equal(badgeBox(rectOf(-100, 30)).top, 2)
  assert.equal(badgeBox(rectOf(-100, 30, 0)).left, 2)
  assert.equal(badgeBox(null), null)
  assert.equal(badgeBox(undefined), null)
})

test('a quote whose badge would sit on the input box gets no badge', () => {
  // 900px viewport, a 152px composer: the input box starts at 748.
  const band = badgeBand(152, 900, Number.NaN)
  assert.equal(band.bottom, 748)
  // The badge for a quote starting at 748 spans [739, 757]: over the input box.
  assert.equal(badgeVisibleIn(boxAt(748), band), false, 'the badge itself is over the input box')
  assert.equal(badgeVisibleIn(boxAt(760), band), false, 'entirely inside the band')
  assert.equal(badgeVisibleIn(boxAt(100), band), true, 'well above the composer')
})

test('a quote that only runs under the composer keeps its badge', () => {
  // The straddle case: the quote's rect overlaps the band, the badge box does
  // not. The badge is what is drawn and clicked, so it stays — judging the whole
  // rect would hide a badge that covers nothing.
  const band = badgeBand(152, 900, Number.NaN)
  const rect = rectOf(700, 760)
  assert.equal(badgeVisibleIn(rect, band), false, 'the coarse rect rule hides it')
  assert.equal(badgeBox(rect).bottom, 709)
  assert.equal(badgeVisibleIn(badgeBox(rect), band), true, 'but the drawn box clears the composer')
})

test('a badge box exactly at the band edge is still drawn', () => {
  const band = badgeBand(152, 900, Number.NaN)
  // box.bottom = rect.top + 9, so a quote starting at 739 ends the box on 748.
  assert.equal(badgeBox(rectOf(739, 900)).bottom, 748)
  assert.equal(badgeVisibleIn(boxAt(739), band), true, 'bottom on the edge')
  assert.equal(badgeVisibleIn(boxAt(739.5), band), false, 'half a pixel into the band hides it')
})

test('a missing composer height falls back to the host default of 152px', () => {
  for (const missing of [Number.NaN, undefined, null, 0, -1, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, '152px']) {
    assert.equal(
      badgeBand(missing, 900, Number.NaN).bottom,
      900 - 152,
      `${String(missing)} must fall back to the host default`,
    )
  }
  // A readable value is used verbatim: not rounded, not replaced by the default.
  assert.equal(badgeBand(208, 900, Number.NaN).bottom, 900 - 208)
})

test('the bottom edge comes from the measured transcript bottom', () => {
  // Measured: the scroller ends at 880 and the composer is 152 high, so the
  // input box starts at 728 — not at 748, which the viewport alone would say.
  const measured = badgeBand(152, 900, Number.NaN, 880)
  assert.deepEqual(measured, { bottom: 728 })
  assert.equal(badgeVisibleIn(boxAt(730), measured), false, 'hidden at the composer that is really there')
  assert.equal(badgeVisibleIn(boxAt(730), badgeBand(152, 900, Number.NaN)), true, 'the viewport-only edge would have drawn it')
  // No measured bottom: the viewport is the source again.
  assert.deepEqual(badgeBand(152, 900, Number.NaN, Number.NaN), { bottom: 748 })
  // Neither readable: no bottom edge at all, nothing is hidden on a guess.
  assert.deepEqual(badgeBand(152, Number.NaN, Number.NaN, Number.NaN), {})
})

test('the transcript top edge crops the head, and is skipped when unreadable', () => {
  const head = badgeBand(152, 900, 64)
  assert.deepEqual(head, { bottom: 748, top: 64 })
  assert.equal(badgeVisibleIn(boxAt(40), head), false, 'the box would be painted above the transcript body')
  assert.equal(badgeVisibleIn(boxAt(64), head), false, 'a badge floats above its quote, so the body edge is not enough')
  assert.equal(badgeVisibleIn(boxAt(73), head), true, 'box top exactly on the body edge')
  assert.equal(badgeVisibleIn(boxAt(80), head), true, 'inside the transcript')

  const noHead = badgeBand(152, 900, Number.NaN)
  assert.deepEqual(noHead, { bottom: 748 }, 'no header height is invented')
  assert.equal(badgeVisibleIn(boxAt(-200), noHead), true, 'uncropped head: the out-of-view filter owns it')
})

test('a collapsed band keeps its bottom edge alone', () => {
  // Scroller top at 800 with its bottom at 880 and a 152px composer: the head
  // edge would land past the composer, so it is dropped rather than hiding every
  // badge for an area nothing covers.
  assert.deepEqual(badgeBand(152, 900, 800, 880), { bottom: 728 })
  assert.deepEqual(badgeBand(152, 900, 728, 880), { bottom: 728 }, 'top == bottom is collapsed too')
  assert.deepEqual(badgeBand(152, 900, 727, 880), { bottom: 728, top: 727 }, 'one pixel of band keeps both edges')
})

test('an unmeasurable viewport keeps the previous behaviour', () => {
  const band = badgeBand(152, Number.NaN, Number.NaN)
  assert.deepEqual(band, {}, 'no readable source, no edge')
  assert.equal(badgeVisibleIn(boxAt(0), band), true, 'nothing is hidden on a guess')
})

test('badgeVisibleIn is safe on absent and degenerate input', () => {
  const band = badgeBand(152, 900, 64)
  assert.equal(badgeVisibleIn(null, band), false, 'nothing is anchored, so there is no badge')
  assert.equal(badgeVisibleIn(undefined, band), false)
  for (const degenerate of [{ top: Number.NaN, bottom: Number.NaN }, { top: 10 }, { bottom: 20 }, {}]) {
    assert.equal(badgeVisibleIn(degenerate, band), true, 'unknown geometry never hides a badge')
  }
  assert.equal(badgeVisibleIn({ top: 800, bottom: 700 }, band), false, 'an inverted box is still an interval in the band')
  for (const absentBand of [null, undefined, {}, { top: Number.NaN, bottom: Number.NaN }, { bottom: '748px' }]) {
    assert.equal(badgeVisibleIn({ top: 900, bottom: 918 }, absentBand), true, 'no readable edge, no crop')
  }
  // A degenerate rect still produces a box, and neither call throws.
  const degenerateBox = badgeBox(rectOf(Number.NaN, Number.NaN))
  assert.equal(Number.isFinite(degenerateBox.top), false)
  assert.equal(badgeVisibleIn(degenerateBox, band), true)
})

/* ---------------------------------------- overlay rendering contract ----- */

/** The source of one client.js function, found by name (line numbers drift). */
function sourceOf(name) {
  const start = source.indexOf(`function ${name}(`)
  assert.notEqual(start, -1, `client.js must still define ${name}()`)
  let depth = 0
  for (let i = source.indexOf('{', start); i < source.length; i += 1) {
    if (source[i] === '{') depth += 1
    else if (source[i] === '}') {
      depth -= 1
      if (depth === 0) return source.slice(start, i + 1)
    }
  }
  throw new Error(`unterminated ${name}()`)
}

test('the badge builder judges the drawn box and keeps the out-of-view filter', () => {
  const body = sourceOf('badgeList')
  assert.match(body, /rect\.bottom < -40 \|\| rect\.top > window\.innerHeight \+ 40/, 'the vertical filter is unchanged')
  assert.match(body, /var box = badgeBox\(rect\)/, 'the box is built once, by the shared helper')
  assert.match(body, /if \(!badgeVisibleIn\(box, band\)\) return/, 'the drawn box is what is judged')
  assert.match(body, /top: box\.top/, 'the judged box supplies the rendered top')
  assert.match(body, /left: box\.left/, 'the judged box supplies the rendered left')
  assert.match(body, /side: BADGE_SIDE/, 'the judged size is the painted size')
  assert.doesNotMatch(body, /rect\.top - 9|rect\.left - 11/, 'no second copy of the offsets to drift from')
})

/* ------------------------------------- session-stable numbering (0.8.0) --- */

test('allNumbers uses the number the host persisted instead of the position', () => {
  const body = sourceOf('allNumbers')
  const numbersOf = (annotations) => new Function('store', `${body}\nreturn allNumbers`)({ annotations })()

  // 0.8.0 assigns a number once, at creation, and persists it, so a survivor
  // keeps its identity when an earlier annotation is deleted: 1 and 5 must stay
  // 1 and 5 rather than slide to 1 and 2. This is the badge half of the
  // "session-stable numbering" promise (the host half is pinned in
  // test/host.test.mjs), and it holds because every record the client ever holds
  // comes from a host projection, which always carries the field.
  assert.deepEqual(
    {
      ...numbersOf([
        { id: 'a', createdAt: 100, number: 1 },
        { id: 'b', createdAt: 200, number: 5 },
      ]),
    },
    { a: 1, b: 5 },
  )

  // A record without the field keeps the fallback — and that fallback is the
  // host's own derivation, not `index + 1`. This is the fixture the contract
  // names as the counterexample: a stored 5 plus two legacy records means the
  // positions 1 and 2, so the panel and the delivered block agree; `index + 1`
  // would have said 2 and 3 and pointed `Annotation 2` at the wrong record.
  assert.deepEqual(
    {
      ...numbersOf([
        { id: 'stored', createdAt: 100, number: 5 },
        { id: 'l1', createdAt: 200 },
        { id: 'l2', createdAt: 300 },
      ]),
    },
    { stored: 5, l1: 1, l2: 2 },
  )

  // A malformed or duplicated value is not an identity: it is ignored and the
  // record takes a free position instead (the host would not send one; the field
  // is optional), and two records never read the same number.
  assert.deepEqual({ ...numbersOf([{ id: 'a', createdAt: 100, number: '3' }]) }, { a: 1 })
  assert.deepEqual({ ...numbersOf([{ id: 'a', createdAt: 100, number: 1.5 }]) }, { a: 1 })
  assert.deepEqual(
    {
      ...numbersOf([
        { id: 'first', createdAt: 100, number: 2 },
        { id: 'second', createdAt: 200, number: 2 },
      ]),
    },
    { first: 2, second: 1 },
  )
  // A session with no stored number at all is still 1..N in creation order.
  assert.deepEqual({ ...numbersOf([{ id: 'a', createdAt: 100 }, { id: 'b', createdAt: 200 }]) }, { a: 1, b: 2 })
})

test('the badge overlay keeps its float contract and reads both measured edges', () => {
  const badges = sourceOf('Badges')
  assert.match(badges, /pointerEvents: 'none'/, 'the overlay stays click-through')
  assert.match(badges, /pointerEvents: 'auto'/, 'the badge itself stays clickable')
  assert.match(badges, /width: item\.side \+ 'px'/)
  assert.match(badges, /height: item\.side \+ 'px'/)
  assert.doesNotMatch(badges, /'18px'/, 'no second copy of the size to drift from the criterion')
  const band = sourceOf('badgeOcclusionBand')
  assert.match(band, /querySelector\('\[data-conversation-scroll\]'\)/, 'the transcript scroller is measured')
  assert.match(band, /measured\.top/, 'its top is the head edge')
  assert.match(band, /measured\.bottom/, 'its bottom anchors the composer edge')
  assert.match(sourceOf('composerHeight'), /--dsh-composer-height/, 'the composer height comes from the host property')
  assert.match(sourceOf('badgeBox'), /BADGE_SIDE/, 'the box size comes from the shared constant')
})
