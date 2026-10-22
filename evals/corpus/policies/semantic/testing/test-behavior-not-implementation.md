---
# Each test, subtest, describe block, and test helper, fixture, or hook: its code, with the private members it touches, its mocks, and its assertions on calls as evidence.
select: |
  for f do shift; case $f in *.test.ts|*.test.tsx|*.test.js|*.spec.ts|*.spec.tsx|*.spec.js|*_test.ts|*_test.go|*_test.py|test_*.py|*/test_*.py|tests/*.py|*/tests/*.py|test/*.ts|test/*.js|*/test/*.ts|*/test/*.js) set -- "$@" "$f";; esac; done
  [ $# -gt 0 ] || exit 0
  bun "$EVAL_STEPS/tests.ts" behavior "$@" |
  bun "$EVAL_STEPS/present.ts"
criteria:
  "true": "The item contains at least one complete violation of the rule."
  "false": "The item follows the rule, or the rule governs nothing in it."
---
Each question shows one item with its location and any context. Decide whether that item contains at least one violation of the rule below.
Return a calibrated probability that the answer is yes.

Rule:
# Test behavior, not implementation

Tests should check what the code under test does through its public interface. Report tests that assert on private or internal fields, on the exact sequence of internal helper calls, on how many times a non-boundary internal function was called, or that mock parts of the unit under test itself. Mocking or stubbing true external boundaries (network, database, clock, filesystem) and asserting on calls to them is fine.
