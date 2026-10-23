---
# Each function of 20 or more lines with its enclosing class or function, and each class with 3 or more methods as an outline.
select: |
  rg --files --hidden --sort path -g '*.{ts,tsx,js,jsx,py,go}' |
  bun "$EVAL_STEPS/functions.ts" --min-lines 20 --context --classes 3 |
  bun "$EVAL_STEPS/present.ts"
criteria:
  "true": "The item contains at least one complete violation of the rule."
  "false": "The item follows the rule, or the rule governs nothing in it."
---
Each question shows one item with its location and any context. Decide whether that item contains at least one violation of the rule below.
Return a calibrated probability that the answer is yes.

Rule:
# One responsibility per unit

Each function and class should have one coherent responsibility. Report a function or class that combines jobs which would change for different reasons — for example parsing input, applying business rules, persisting results, and formatting output all in one unit — when those parts could be separated. Coordinating functions that only call well-named steps in sequence are fine; that coordination is their one job.
