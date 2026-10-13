#!/usr/bin/env bash
# Mutation controls for test/reconcile.test.mjs and test/host.test.mjs.
#
# The duplicate-delivery fix is only worth its green if a semantically broken
# version of it turns the drive red. Three mutations are applied — one per
# mechanism the fix rests on — and the reverse direction as well, so a fix that
# "closes the window" by swallowing annotations cannot pass either.
#
# The save/restore is a byte copy, not `git checkout`, so it works on an
# uncommitted working tree and never touches unrelated changes.
#
# Each mutation is an exact-string edit that raises when the target moved, so a
# mutation that applied nothing is reported instead of passing silently.
#
# Usage:  bash test/reconcile.mutations.sh
# Exit:   0 when every mutation was caught and the clean run was green.

set -uo pipefail

cd "$(dirname "$0")/.." || exit 2

fail=0
SAVED="$(mktemp)"
cp index.js "$SAVED"
restore() { cp "$SAVED" index.js; }
trap 'restore; rm -f "$SAVED" "$MUTATOR"' EXIT

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
s = s.replace('__MUTATED__', '')
p.write_text(s)
print('  applied:', '$name')
"; then
    return 0
  fi
  echo "  !! could not apply $name"
  fail=1
  return 1
}

MUTATOR="$(mktemp)"

# apply_file <name> <python file>: the same contract as apply(), for a mutation
# whose body needs its own quoting rules.
apply_file() {
  local name="$1" body="$2"
  if python3 -c "
import pathlib
p = pathlib.Path('index.js')
s = p.read_text()
exec(open('$body').read())
p.write_text(s)
print('  applied:', '$name')
"; then
    return 0
  fi
  echo "  !! could not apply $name"
  fail=1
  return 1
}

# The mutated tree must still parse, or the run proves nothing about semantics.
check_syntax() {
  if ! node --check index.js >/dev/null 2>&1; then
    echo "    !! the mutated file does not parse; mutation is malformed"
    fail=1
    return 1
  fi
  return 0
}

# run_suite <suite>: tallies plus the suite's exit status (124 = timed out).
run_suite() {
  local suite="$1" out
  out="$(timeout 180 node --test "$suite" 2>&1)"
  local status=$?
  printf '%s\n' "$out" | grep -E '^(ℹ (tests|pass|fail))' | sed 's/^/    /'
  if [ "$status" -eq 124 ]; then
    echo "    (timed out: the mutated drive spins - a real failure, but a weak proof)"
    return 124
  fi
  return "$status"
}

expect_caught() {
  local label="$1" suite="$2"
  run_suite "$suite"
  if [ "$?" -eq 0 ]; then
    echo "    !! NOT CAUGHT by $suite: $label"
    fail=1
  else
    echo "    caught by $suite ($label)"
  fi
}

expect_green() {
  local label="$1" suite="$2"
  run_suite "$suite"
  if [ "$?" -ne 0 ]; then
    echo "    !! expected green under $label: $suite"
    fail=1
  else
    echo "    green under $label ($suite)"
  fi
}

# --- baseline ---------------------------------------------------------------
note "clean tree: the delivery suites must be green"
expect_green "clean" test/reconcile.test.mjs
expect_green "clean" test/host.test.mjs

# --- M1 ---------------------------------------------------------------------
# The fix itself: the reconciliation does not run. This is 0.10.2, and it is
# the mutation the README §7 window describes.
note "M1 - the restart reconciliation is never called"
apply "M1 reconciliation disabled" "
old = '      await reconcile(sessionQuery(), store, sessionId)'
new = '      // MUTATION M1\n__MUTATED__'
assert s.count(old) == 1, ('target appears %d times' % s.count(old))
s = s.replace(old, new)
"
if check_syntax; then expect_caught "M1" test/reconcile.test.mjs; fi
restore

# --- M2 ---------------------------------------------------------------------
# The identity the fix rests on: the block's own token. Dropping the comparison
# is the "trust the header line" design the recon report measured as unsafe —
# every session's first batch prints the same header.
note "M2 - the batch token is not compared (the header-line design)"
apply "M2 the token fence is removed" "
old = '    if (tokenOf(part.text) !== token) continue'
new = '    // MUTATION M2\n__MUTATED__'
assert s.count(old) == 1, ('target appears %d times' % s.count(old))
s = s.replace(old, new)
"
if check_syntax; then expect_caught "M2" test/reconcile.test.mjs; fi
restore

# --- M3 ---------------------------------------------------------------------
# The ledger: without it, an old block still in the log confirms a batch that
# came after it — the "swallow the annotation" direction.
note "M3 - the ledger gate is removed"
apply "M3 the ledger gate is removed" "
old = '      if (!batch.all || claimed.has(token)) continue'
new = '      if (!batch.all) continue\n      // MUTATION M3\n__MUTATED__'
assert s.count(old) == 1, ('target appears %d times' % s.count(old))
s = s.replace(old, new)
"
if check_syntax; then expect_caught "M3" test/reconcile.test.mjs; fi
restore

# --- M4 ---------------------------------------------------------------------
# The conservative direction. A failed read is NOT evidence of a delivery;
# marking one is exactly the trade the whole design refuses.
note "M4 - a failed log read is treated as proof of delivery"
# The target is the two lines that make up the whole failure path, matched by a
# python file rather than a nested string so the backslash quoting cannot rot.
cat > "$MUTATOR" <<'PYMUT'
old = "    return 0\n  } catch (error) {"
assert s.count("could not reconcile") == 1, "the failure path moved"
old = "    store.logger?.warn?.(\'dsh-annotate: could not reconcile"
at = s.index(old)
end = s.index("return 0", at) + len("return 0")
s = s[:at] + (
    "    for (const record of store.pending(sessionId)) {\n"
    "      await store.markDelivered([record.id], undefined, { batch: asToken(record.batchId) })\n"
    "    }\n"
    "    return 1"
) + s[end:]
PYMUT
apply_file "M4 a failed read marks delivered" "$MUTATOR"
if check_syntax; then expect_caught "M4" test/reconcile.test.mjs; fi
restore

# --- M5 ---------------------------------------------------------------------
# The re-send. Pinned by the older suite, which is the point: the crash fix must
# not have bought itself by making the ordinary retry path stop working.
note "M5 - an unlanded block is remembered as delivered anyway"
apply "M5 the stamp writes delivered" "
old = '      record.batchId = batch\n      record.updatedAt = Date.now()\n      changed = true'
new = '      record.batchId = batch\n      record.status = \"delivered\"\n      record.updatedAt = Date.now()\n      changed = true\n      // MUTATION M5\n__MUTATED__'
assert s.count(old) == 1, ('target appears %d times' % s.count(old))
s = s.replace(old, new)
"
if check_syntax; then expect_caught "M5" test/reconcile.test.mjs; fi
restore

# --- M6 (verify-a's X1) ------------------------------------------------------
# The in-process leg. This is the mutation verify-a reported as INVISIBLE: with
# the gate reduced to the old substring test on the header line, all 64 delivery
# tests stayed green. It is the defect that motivated this whole repair round
# (it silently confirmed deliveries the plugin never made), so it is pinned here
# permanently — the four P0 cases in reconcile.test.mjs are its guard.
note "M6/X1 - the in-process leg falls back to a substring of the header line"
cat > "$MUTATOR" <<'PYMUT'
old = (
    "      const provesBlock =\n"
    "        event?.data?.source?.kind === BLOCK_SOURCE_KIND && messageDefinesToken(event.data, flight.batch)\n"
    "      if (!provesBlock) return"
)
assert s.count(old) == 1, "the in-process gate moved"
s = s.replace(old,
    "      // MUTATION M6/X1: no source.kind, no token.\n"
    "      const header = String(flight.block).split('\\n').find((line) => line.trim().length > 0)\n"
    "      const provesBlock = Array.isArray(event?.data?.content) && event.data.content.some(\n"
    "        (part) => part?.type === 'text' && typeof part.text === 'string' && part.text.includes(header),\n"
    "      )\n"
    "      if (!provesBlock) return")
PYMUT
apply_file "M6/X1 the header line is the receipt again" "$MUTATOR"
if check_syntax; then expect_caught "M6/X1" test/reconcile.test.mjs; fi
restore

# --- M7 ---------------------------------------------------------------------
# P1, in the direction it was found: the marker is recognised only when it
# happens to be the last non-empty line, so a block followed by anything stops
# being recognised and the annotation is sent a second time.
note "M7 - the marker line is only found at the very end of the text"
cat > "$MUTATOR" <<'PYMUT'
old = """    const line = lines[i].trim()
    if (line.length === 0 || !line.startsWith(BATCH_MARKER)) continue
    return canonicalToken(line)"""
assert s.count(old) == 1, "the tokenOf marker scan moved"
s = s.replace(old, """    if (lines[i].trim().length === 0) continue
    return canonicalToken(lines[i])""")
PYMUT
apply_file "M7 tokenOf takes the last non-empty line" "$MUTATOR"
if check_syntax; then expect_caught "M7" test/reconcile.test.mjs; fi
restore

note "restored"
exit "$fail"
