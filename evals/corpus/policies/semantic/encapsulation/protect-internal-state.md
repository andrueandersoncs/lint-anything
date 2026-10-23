---
# Each place that can leak mutable state (a class's public fields; a method returning a field or storing a parameter as given; a public or returned module-level mutable value), with its owner's fields.
select: |
  rg --files --hidden --sort path -g '*.{ts,tsx,js,jsx,py,go}' |
  bun "$EVAL_STEPS/module-state.ts" |
  bun "$EVAL_STEPS/present.ts"
criteria:
  "true": "The item contains at least one complete violation of the rule."
  "false": "The item follows the rule, or the rule governs nothing in it."
---
Each question shows one item with its location and any context. Decide whether that item contains at least one violation of the rule below.
Return a calibrated probability that the answer is yes.

Rule:
# Don't leak mutable internals

A class or module that owns mutable state must control how it changes. Report code that hands callers direct access to internal mutable state — returning an internal list, map, or object by reference from a public method or property, exposing a mutable field publicly so callers modify it, or accepting a caller's mutable object and storing it without copying when later changes would corrupt the owner's invariants.

Immutable values, deliberate copies, read-only views, and plain data records with no invariants (DTOs, config structs) are fine.
