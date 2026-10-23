---
# Excerpts of at most 1,000 bytes, asked about as the excerpt CLI asked (evals/RESEARCH.md, H19).
select: |
  rg --files --hidden --sort path -g '*.{test,spec}.{ts,tsx,js}' -g '*_test.{ts,go,py}' -g 'test_*.py' -g '**/tests/**/*.py' -g '**/test/**/*.{ts,js}' |
  bun "$EVAL_STEPS/excerpts.ts" 1000
criteria:
  "true": "The file contains at least one complete violation of the rule."
  "false": "The file follows the rule, or the rule governs nothing in it."
---
Each question shows one excerpt of a file with its path and line range. Decide whether that excerpt contains at least one violation of the rule below.
Return a calibrated probability that the answer is yes.

Rule:
# Test behavior, not implementation

Tests should check what the code under test does through its public interface. Report tests that assert on private or internal fields, on the exact sequence of internal helper calls, on how many times a non-boundary internal function was called, or that mock parts of the unit under test itself. Mocking or stubbing true external boundaries (network, database, clock, filesystem) and asserting on calls to them is fine.
