---
# Each outermost function with the module-level variables and clock/random/env/fs/client lines it uses; each run of module-level code.
select: |
  rg --files --hidden --sort path -g '*.{ts,tsx,js,jsx,py,go}' |
  bun "$EVAL_STEPS/functions.ts" --outer --module --globals --hidden |
  bun "$EVAL_STEPS/present.ts"
criteria:
  "true": "The item contains at least one complete violation of the rule."
  "false": "The item follows the rule, or the rule governs nothing in it."
---
Each question shows one item with its location and any context. Decide whether that item contains at least one violation of the rule below.
Return a calibrated probability that the answer is yes.

Rule:
# Make dependencies explicit

Functions and classes should receive their collaborators — database or HTTP clients, repositories, clocks, random sources, configuration — through parameters or constructors. Report code that instead reaches for a module-level mutable singleton, reads process-wide globals or environment variables deep inside business logic, or constructs its external collaborators internally, so the dependency is hidden from callers and hard to replace in tests.

Not violations: composition roots and entry points (`main`, app setup, dependency-wiring modules) that build and connect dependencies, and pure library calls (math, string, collections).
