#!/usr/bin/env bash
# Mutation controls for the per-session ceiling fix in index.js.
#
# The new host tests are only worth their green if reverting the fix turns them
# red. Four mutations are applied, one at a time, each restored after it runs:
#
#   1. no-ceiling   — the pre-fix eviction body, where `slice(0, overflow)` over
#      a short pool silently leaves the excess on the list;
#   2. refuse-early — a create that refuses even when the pool COULD have
#      covered the overflow, so the "eviction still works" test is shown to do
#      real work rather than agreeing with any refusal at all;
#   3. no-rollback  — the refusal is kept but the rejected record is left on the
#      list, so "nothing is written" has to fail on the state, not the file;
#   4. number-leak  — the refusal consumes the number it was handed: the record
#      stays but is hidden from the ceiling count and the list projection, so
#      length, limit and delete paths all look normal and ONLY the number
#      sequence differs. That is the shape a single-value assertion cannot see,
#      which is why the assertion now states a relation and this control exists.
#
# The save/restore is a byte copy, not `git checkout`, so it works on an
# uncommitted working tree and never touches unrelated changes.
#
# Each mutation is an exact-string edit that raises if the target moved, so a
# mutation that applied nothing is reported instead of passing silently.
#
# Usage:  bash test/ceiling.mutations.sh
# Exit:   0 when every mutation was caught and the clean run was green.

set -uo pipefail

cd "$(dirname "$0")/.." || exit 2

fail=0
SAVED="$(mktemp)"
cp index.js "$SAVED"
restore() { cp "$SAVED" index.js; }
trap 'restore; rm -f "$SAVED"' EXIT

note() { printf '\n=== %s ===\n' "$*"; }

# apply <name> <python body>; the body reads `s` and must leave it mutated,
# raising on anything but exactly one match.
apply() {
  local name="$1" body="$2"
  if python3 -c "
import pathlib
p = pathlib.Path('index.js')
s = p.read_text()
$body
p.write_text(s)
print('  applied:', '$name')
"; then
    return 0
  fi
  echo "  !! could not apply $name"
  fail=1
  return 1
}

# run_suite <suite>: tallies plus the suite's exit status (124 = timed out).
run_suite() {
  local suite="$1" out status
  out="$(timeout 180 node --test "$suite" 2>&1)"
  status=$?
  printf '%s\n' "$out" | grep -E '^(ℹ (tests|pass|fail))' | sed 's/^/    /'
  if [ "$status" -eq 124 ]; then
    echo "    (timed out - a real failure, but a weak proof)"
    return 124
  fi
  return "$status"
}

expect_caught() {
  local name="$1" status="$2"
  if [ "$status" -eq 0 ]; then
    echo "  !! NOT CAUGHT: $name stayed green under mutation"
    fail=1
  else
    echo "  caught: $name turned the suite red (exit $status)"
  fi
}

# ---------------------------------------------------------------- clean run
note "clean run (no mutation)"
run_suite test/host.test.mjs
clean_status=$?
if [ "$clean_status" -ne 0 ]; then
  echo "  !! the unmutated suite is not green - fix that before trusting any mutation"
  fail=1
else
  echo "  clean run is green"
fi

# ------------------------------------------------- mutation 1: revert the fix
# Restore the exact pre-fix body: an unconditional `slice(0, overflow)` over the
# delivered pool with no branch for "the pool is too small".
note "mutation 1: revert to the pre-fix eviction (slice, no refusal branch)"
if apply "revert-to-slice" "
old = '''      const overflow = forSession.length - MAX_PER_SESSION
      // Oldest delivered first; pending records are never dropped. The pool is
      // measured before anything is evicted, because the question the next
      // branch asks is whether that pool can absorb the WHOLE overflow.
      const evictable = forSession
        .filter((item) => item.status === 'delivered')
        .sort((a, b) => a.createdAt - b.createdAt)
      if (overflow > evictable.length)'''
assert s.count(old) == 1, 'anchor drifted'
new = '''      const overflow = forSession.length - MAX_PER_SESSION
      const evictable = forSession
        .filter((item) => item.status === 'delivered')
        .sort((a, b) => a.createdAt - b.createdAt)
      if (false)'''
s = s.replace(old, new)
"; then
  run_suite test/host.test.mjs
  expect_caught "reverting the refusal branch" "$?"
fi
restore

# --------------------------------------- mutation 2: refuse one record too early
# Off-by-one on the other side: treat a pool that covers the overflow EXACTLY as
# too small. The eviction test must catch this; a test suite that only checked
# "over-limit writes fail" would happily accept it.
note "mutation 2: refuse one record too early (overflow >= evictable)"
if apply "refuse-too-early" "
old = 'if (overflow > evictable.length) {'
assert s.count(old) == 1, 'anchor drifted'
s = s.replace(old, 'if (overflow >= evictable.length) {')
"; then
  run_suite test/host.test.mjs
  expect_caught "refusing one record too early" "$?"
fi
restore

# ------------------------------------- mutation 3: do not roll the record back
# Keep the refusal but leave the rejected record on the list: the ceiling then
# leaks by exactly one per refused create.
note "mutation 3: refuse but skip the roll-back"
if apply "no-rollback" "
old = '''        this.state.annotations = this.state.annotations.filter((item) => item.id !== record.id)
        throw new Error('''
assert s.count(old) == 1, 'anchor drifted'
s = s.replace(old, '''        throw new Error(''')
"; then
  run_suite test/host.test.mjs
  expect_caught "refusing without rolling the record back" "$?"
fi
restore

# --------------------------- mutation 4: the refusal still consumes a number
# This is the F2 control. It leaves the rejected record on the list (so the
# sequence advances by one per refusal) while still hiding it from the ceiling
# count — the session length and the delete path stay intact, so ONLY the
# number sequence differs. That is precisely the shape the old single-refusal
# assertion could not see; the strengthened one must catch it.
note "mutation 4: a refusal leaks its number (rejected record still counts)"
if apply "number-leak" "
old = '''        this.state.annotations = this.state.annotations.filter((item) => item.id !== record.id)
        throw new Error('''
assert s.count(old) == 1, 'anchor drifted'
s = s.replace(old, '''        record.ghost = true
        throw new Error(''')
old2 = 'const forSession = this.state.annotations.filter((item) => item.sessionId === record.sessionId)'
assert s.count(old2) == 1, 'anchor drifted'
s = s.replace(old2, 'const forSession = this.state.annotations.filter((item) => item.sessionId === record.sessionId && item.ghost !== true)')
"; then
  run_suite test/host.test.mjs
  expect_caught "a refusal that leaks its number" "$?"
fi
restore

# ------------------------------------------------------------- final clean run
note "final clean run (index.js restored)"
run_suite test/host.test.mjs
final_status=$?
if [ "$final_status" -ne 0 ]; then
  echo "  !! the restore did not come back green"
  fail=1
fi

# ---------------------------------------------- sanity: the fences leave no trace
# The two direction fences (A/B) mutate client.js / index.js and restore them
# from a temp copy. Assert the tree is byte-clean before we hand it back, so a
# restore that silently failed is reported here instead of being mistaken for
# someone's edit.
note "working tree is clean of stray mutation residue"
if git diff --quiet index.js; then
  echo "  index.js matches HEAD (the fix is committed) or carries only the fix"
else
  echo "  note: index.js differs from HEAD — expected while the fix is uncommitted"
fi
if git diff --quiet client.js; then
  echo "  client.js is byte-identical to HEAD"
else
  echo "  !! client.js differs from HEAD — a fence did not restore it"
  fail=1
fi

printf '\n'
if [ "$fail" -eq 0 ]; then
  echo "ALL MUTATIONS CAUGHT; index.js restored and green."
else
  echo "MUTATION CONTROL FAILED - see the !! lines above."
fi
exit "$fail"
