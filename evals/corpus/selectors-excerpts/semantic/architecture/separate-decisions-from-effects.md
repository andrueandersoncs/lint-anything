---
# Excerpts of at most 1,000 bytes, asked about as the excerpt CLI asked (evals/RESEARCH.md, H19).
select: |
  rg --files --hidden --sort path -g '*.{ts,tsx,js,jsx,py,go}' |
  bun "$EVAL_STEPS/excerpts.ts" 1000
criteria:
  "true": "The file contains at least one complete violation of the rule."
  "false": "The file follows the rule, or the rule governs nothing in it."
---
Each question shows one excerpt of a file with its path and line range. Decide whether that excerpt contains at least one violation of the rule below.
Return a calibrated probability that the answer is yes.

Rule:
# Separate decisions from I/O

Business decisions should be computed separately from the I/O that feeds or acts on them. Report a function that both makes a non-trivial domain decision (pricing, eligibility, validation rules, state transitions, choosing which action to take) and performs I/O itself (database queries, network calls, file or queue access, sending email) in the same body, where the decision could be a separate function that receives data and returns a result.

Thin glue that loads data, calls a decision function, and stores the outcome is the intended shape and is fine.
