---
# Each function of 8 or more lines.
select: |
  rg --files --hidden --sort path -g '*.{ts,tsx,js,jsx,py,go}' |
  bun "$EVAL_STEPS/functions.ts" --min-lines 8 |
  bun "$EVAL_STEPS/present.ts"
criteria:
  "true": "The item contains at least one complete violation of the rule."
  "false": "The item follows the rule, or the rule governs nothing in it."
---
Each question shows one item with its location and any context. Decide whether that item contains at least one violation of the rule below.
Return a calibrated probability that the answer is yes.

Rule:
# One level of detail per function

Each function should read at one level of abstraction. Report a function that mixes high-level steps (calls like `validateOrder(order)`, `chargeCustomer(order)`, `sendReceipt(order)`) with low-level mechanics in the same body — string slicing and parsing, byte or index arithmetic, regular expressions, raw SQL text, manual HTTP header handling — where those mechanics could sit behind a named helper. Short functions that are entirely low-level, or entirely orchestration, are fine.
