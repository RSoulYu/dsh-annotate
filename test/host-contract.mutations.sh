#!/usr/bin/env bash
# Mutation controls for test/host-contract.test.mjs.
#
# The drive in host-contract.test.mjs is only worth its green if a semantically
# changed jump core turns it red. This script applies mutations of the jump
# core, runs both host suites, and restores client.js. The save/restore is a
# byte copy, not `git checkout`, so it works on an uncommitted working tree and
# never touches unrelated changes.
#
# Each mutation is an exact-string edit that raises if the target moved, so a
# mutation that applied nothing is reported instead of passing silently.
#
# Usage:  bash test/host-contract.mutations.sh
# Exit:   0 when every mutation was caught and the clean run was green.

set -uo pipefail

cd "$(dirname "$0")/.." || exit 2

fail=0
SAVED="$(mktemp)"
cp client.js "$SAVED"
restore() { cp "$SAVED" client.js; }
trap 'restore; rm -f "$SAVED"' EXIT

note() { printf '\n=== %s ===\n' "$*"; }

# apply <name> <python body>; the body reads `s` and must leave it mutated,
# raising on anything but exactly one match.
apply() {
  local name="$1" body="$2"
  if python3 -c "
import pathlib
p = pathlib.Path('client.js')
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
  local suite="$1" out
  out="$(timeout 120 node --test "$suite" 2>&1)"
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
note "clean tree: the host suites must be green"
expect_green "clean" test/host-contract.test.mjs
expect_green "clean" test/host-shape.test.mjs

# --- M1 ---------------------------------------------------------------------
# The mutation the recon report measured as invisible to every string check:
# the window's revision stops being read, so a host that pages silently no
# longer counts a stall.
note "M1 - the jump core stops reading the window revision"
apply "M1 revision is never read" "
old = '        if (deps.revision() === before) stalls += 1'
new = '        if (false) stalls += 1'
assert s.count(old) == 1, ('target appears %d times' % s.count(old))
s = s.replace(old, new)
"
expect_caught "M1" test/host-contract.test.mjs

# ...and the string fence cannot see it. This is the point of the whole file.
note "M1 - and the 22 string assertions stay green, which is the blind spot"
run_suite test/host-shape.test.mjs
if [ "$?" -eq 0 ]; then
  echo "    host-shape verified every assertion while the jump core was broken"
else
  echo "    host-shape could not run here (no host installation)"
fi
restore

# --- M2 ---------------------------------------------------------------------
# The in-flight guard: a busy window must be waited for, never re-requested.
note "M2 - the in-flight guard pages instead of waiting"
apply "M2 busy window is paged" "
old = \"      if (state.loadingOlder === true) return { action: 'wait' }\"
new = \"      if (state.loadingOlder === true) return { action: 'page' }\"
assert s.count(old) == 1, ('target appears %d times' % s.count(old))
s = s.replace(old, new)
"
expect_caught "M2" test/host-contract.test.mjs
restore

# --- M3 ---------------------------------------------------------------------
# The stall counter reset: only a window that really moved may clear it.
note "M3 - every page counts as a stall, even an advancing one"
apply "M3 an advancing page no longer clears the counter" "
old = '        if (deps.revision() === before) stalls += 1'
new = '        if (true) stalls += 1'
assert s.count(old) == 1, ('target appears %d times' % s.count(old))
s = s.replace(old, new)
"
expect_caught "M3" test/host-contract.test.mjs
restore

# --- M4 ---------------------------------------------------------------------
# The reset itself, in the other direction. This mutation was reported as
# "not caught" during the FIRST hardening round, with the wrong explanation
# that the branch only ever sees `stalls === 0`; the verification report §5
# disproved that (a silent, silent, advance cadence reaches stalls === 2).
# It is kept here permanently, because it is the regression that first slipped
# through and it is cheap to re-check.
note "M4 - the stall counter is never reset by an advancing page"
apply "M4 the reset is removed" "
old = '        else stalls = 0'
new = '        else stalls = stalls'
assert s.count(old) == 1, ('target appears %d times' % s.count(old))
s = s.replace(old, new)
"
expect_caught "M4" test/host-contract.test.mjs
restore

note "restored"
exit "$fail"
