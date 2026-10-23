---
# Each public declaration (exported function, type, constant; public method of an exported class), with where the file references it and the file's public and non-public names.
select: |
  rg --files --hidden --sort path -g '*.{ts,tsx,js,jsx,py,go}' |
  bun "$EVAL_STEPS/module-exports.ts" |
  bun "$EVAL_STEPS/present.ts"
criteria:
  "true": "The item contains at least one complete violation of the rule."
  "false": "The item follows the rule, or the rule governs nothing in it."
---
Each question shows one item with its location and any context. Decide whether that item contains at least one violation of the rule below.
Return a calibrated probability that the answer is yes.

Rule:
# Export only what callers need

Keep a module's public surface as small as its purpose allows. Report exported or public functions, methods, types, or constants that are evidently internal implementation steps — helpers used only by other members of the same file to build their result, intermediate stages of an exported computation, or members that exist only to support the class's own implementation — when nothing about the file suggests outside callers need them.

Modules whose purpose is to be a toolbox of independent utilities, and members required by an interface or framework, are fine.
