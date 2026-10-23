---
# Each function of 10 or more lines, and each run of module-level code (script bodies).
select: |
  rg --files --hidden --sort path -g '*.{ts,tsx,js,jsx,py,go}' |
  bun "$EVAL_STEPS/functions.ts" --min-lines 10 --module |
  bun "$EVAL_STEPS/present.ts"
criteria:
  "true": "The item contains at least one complete violation of the rule."
  "false": "The item follows the rule, or the rule governs nothing in it."
---
Each question shows one item with its location and any context. Decide whether that item contains at least one violation of the rule below.
Return a calibrated probability that the answer is yes.

Rule:
# Keep entry points thin

HTTP route handlers, RPC methods, CLI command handlers, message consumers, and UI event handlers should translate input, call application or domain code, and translate the result. Report such entry points that contain substantial business logic inline: multi-step workflows, pricing or eligibility rules, permission rules beyond a single check, or state machines. Input parsing, validation of request shape, and response formatting belong in the entry point and are fine.
