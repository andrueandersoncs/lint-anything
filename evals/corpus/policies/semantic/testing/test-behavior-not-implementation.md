---
# Each test, subtest, describe block, and test helper, fixture, or hook: its code, with the private members it touches, its mocks, and its assertions on calls as evidence.
select: |
  rg --files --hidden --sort path -g '*.{test,spec}.{ts,tsx,js}' -g '*_test.{ts,go,py}' -g 'test_*.py' -g '**/tests/**/*.py' -g '**/test/**/*.{ts,js}' |
  bun "$EVAL_STEPS/tests.ts" behavior |
  bun "$EVAL_STEPS/present.ts"
criteria:
  "true": "The test couples to internals by asserting on private fields, internal helper call sequences/counts, or mocking parts of the unit under test itself."
  "false": "The test verifies public behavior, or only mocks/stubs true external boundaries (network, database, clock, filesystem)."
---
Each question shows one item with its location and any context. Decide whether that item contains at least one violation of the rule below.
Return a calibrated probability that the answer is yes.

Rule:
# Test behavior, not implementation

Tests should check what the code under test does through its public interface. Report tests that assert on private or internal fields, on the exact sequence of internal helper calls, on how many times a non-boundary internal function was called, or that mock parts of the unit under test itself. Mocking or stubbing true external boundaries (network, database, clock, filesystem) and asserting on calls to them is fine.
