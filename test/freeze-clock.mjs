/**
 * Frozen wall clock for the test run.
 *
 * Loaded with `node --import ./test/freeze-clock.mjs --test`, exactly as the
 * design's §8.2 gate prescribes: with `Date.now()` pinned to one instant, the
 * whole suite must produce the same results as a normal run. Any new logic that
 * budgets or orders by the clock would diverge here, so an identical run is the
 * evidence that the jump budget is counted in pages / stalls / frames instead.
 *
 * It lives in `test/` and is never imported by the product halves.
 */

const FIXED = 1759968000000 // 2025-10-09T00:00:00Z
const realNow = Date.now

Date.now = () => FIXED

// `new Date()` with no argument reads the clock through the same channel.
const RealDate = Date
class FrozenDate extends RealDate {
  constructor(...args) {
    if (args.length === 0) super(FIXED)
    else super(...args)
  }
  static now() {
    return FIXED
  }
}
globalThis.Date = FrozenDate

// Hand the real reader back for anything that needs to prove the freeze is on.
globalThis.__dsaUnfrozenNow = realNow
