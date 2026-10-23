---
# Excerpts of at most 1,000 bytes, asked about as the excerpt CLI asked (evals/RESEARCH.md, H19).
select: |
  rg --files --hidden --sort path -g '*.{ts,tsx,js,jsx,py,go}' |
  bun "$EVAL_STEPS/excerpts.ts" 1000
criteria:
  "true": "The file contains at least one complete violation of the rule."
  "false": "The file follows the rule, or the rule governs nothing in it."
---
Each question shows one excerpt of a file with its path and line range. Decide whether that excerpt contains at least one violation of the rule below.
Return a calibrated probability that the answer is yes.

Rule:
# Make dependencies explicit

Functions and classes should receive their collaborators — database or HTTP clients, repositories, clocks, random sources, configuration — through parameters or constructors. Report code that instead reaches for a module-level mutable singleton, reads process-wide globals or environment variables deep inside business logic, or constructs its external collaborators internally, so the dependency is hidden from callers and hard to replace in tests.

Not violations: composition roots and entry points (`main`, app setup, dependency-wiring modules) that build and connect dependencies, and pure library calls (math, string, collections).
