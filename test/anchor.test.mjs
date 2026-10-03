/**
 * Browser-half quote anchoring.
 *
 * The anchoring core lives inside `client.js`, which is a ModuleLoader bundle
 * rather than a module. The test therefore extracts the slice between the
 * `@pure-anchor` markers and evaluates exactly that source, so what runs here is
 * the shipped code — there is no second copy to drift out of sync.
 *
 * Run with: node --test test/
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const source = await readFile(new URL('../client.js', import.meta.url), 'utf8')
const from = source.indexOf('/* @pure-anchor')
const to = source.indexOf('/* @pure-anchor-end */')
assert.ok(from !== -1 && to > from, 'client.js must carry the @pure-anchor markers')

const { normalizeQuote, buildAnchorIndex, locateQuote } = new Function(
  `${source.slice(from, to)}\nreturn { normalizeQuote, buildAnchorIndex, locateQuote }`,
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
