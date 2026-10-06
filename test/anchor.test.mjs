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
} = new Function(
  `${source.slice(from, to)}\nreturn { normalizeQuote, buildAnchorIndex, locateQuote, quoteOccurrences, occurrenceAt, storedOccurrence, wantedOccurrences }`,
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
