---
# Each function with a positional boolean parameter (with its calls), and each call passing it a bare boolean.
select: |
  rg --files --hidden --sort path -g '*.{ts,tsx,js,jsx,py,go}' |
  bun "$EVAL_STEPS/functions.ts" --flags |
  bun "$EVAL_STEPS/present.ts"
criteria:
  "true": "The item contains at least one complete violation of the rule."
  "false": "The item follows the rule, or the rule governs nothing in it."
---
Each question shows one item with its location and any context. Decide whether that item contains at least one violation of the rule below.
Return a calibrated probability that the answer is yes.

Rule:
# No flag arguments

Don't use a boolean parameter to make one function do two different jobs (`render(doc, true)`, `fetchUser(id, includeDeleted, skipCache)`). Split it into separate functions, or replace the boolean with a named option whose meaning is clear at the call site. A boolean that is simply data being stored or forwarded (`setEnabled(enabled)`, a struct field) is fine, and so is a boolean inside an options object or keyword-only argument whose name explains it.
