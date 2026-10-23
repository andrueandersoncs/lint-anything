---
# Each named function with its doc comment (parts of at most 40 lines), enclosing class or function, side-effect lines, and in-file callees.
select: |
  rg --files --hidden --sort path -g '*.{ts,tsx,js,jsx,py,go}' |
  bun "$EVAL_STEPS/functions.ts" --named --docs --chunk 40 --context --effects |
  bun "$EVAL_STEPS/present.ts"
criteria:
  "true": "The item contains at least one complete violation of the rule."
  "false": "The item follows the rule, or the rule governs nothing in it."
---
Each question shows one item with its location and any context. Decide whether that item contains at least one violation of the rule below.
Return a calibrated probability that the answer is yes.

Rule:
# Names must not lie

A function's name must describe what it actually does. Report functions whose name promises less or something different than their body:
- a name that reads as a query (`get…`, `is…`, `has…`, `find…`, `compute…`, `validate…`) but the function also changes state, writes to storage, sends messages, or has other side effects;
- a name that describes one action while the body does a different or substantially larger job (`saveUser` that also emails the user and charges a card).

Caching or lazy initialization inside a getter does not count as a side effect.
