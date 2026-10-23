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
# Test names state the scenario

Each test's name or description should say what situation it exercises and what outcome it expects ("rejects expired tokens", `test_refund_exceeding_balance_raises`). Report tests named only after the function under test, numbered or vague names (`test1`, `testHandler`, "works", "basic"), when the test body checks a specific behavior that the name doesn't mention.
