---
# The whole file as one item whose text is its outline: imports, then each top-level declaration's signature and doc line, with class and struct members.
select: |
  rg --files --hidden --sort path -g '*.{ts,tsx,js,jsx,py,go}' |
  bun "$EVAL_STEPS/module-outline.ts" |
  bun "$EVAL_STEPS/present.ts"
criteria:
  "true": "The item contains at least one complete violation of the rule."
  "false": "The item follows the rule, or the rule governs nothing in it."
---
Each question shows one item with its location and any context. Decide whether that item contains at least one violation of the rule below.
Return a calibrated probability that the answer is yes.

Rule:
# One topic per file

A file should be about one thing. Report files that bundle unrelated concerns which would naturally change for different reasons and belong in different modules — for example date-formatting helpers, an HTTP client wrapper, and billing rules in one file. A file of several closely related pieces (a type with its parser and printer; a feature's handler, validation, and DTOs) is cohesive.
