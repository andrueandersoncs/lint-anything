---
# Each function of 8 or more lines.
select: |
  rg --files --hidden --sort path -g '*.{ts,tsx,js,jsx,py,go}' |
  bun "$EVAL_STEPS/functions.ts" --min-lines 8 |
  bun "$EVAL_STEPS/present.ts"
criteria:
  "true": "The function mixes non-trivial domain decisions (rules, eligibility, pricing, state transitions) directly with I/O (DB, network, filesystem, queue, email) in the same body."
  "false": "The function separates decisions from I/O, is thin orchestration glue calling a decision function, or does only I/O or only pure computation."
---
Each question shows one item with its location and any context. Decide whether that item contains at least one violation of the rule below.
Return a calibrated probability that the answer is yes.

Rule:
# Separate decisions from I/O

Business decisions should be computed separately from the I/O that feeds or acts on them. Report a function that both makes a non-trivial domain decision (pricing, eligibility, validation rules, state transitions, choosing which action to take) and performs I/O itself (database queries, network calls, file or queue access, sending email) in the same body, where the decision could be a separate function that receives data and returns a result.

Thin glue that loads data, calls a decision function, and stores the outcome is the intended shape and is fine.
