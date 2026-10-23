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
# One topic per file

A file should be about one thing. Report files that bundle unrelated concerns which would naturally change for different reasons and belong in different modules — for example date-formatting helpers, an HTTP client wrapper, and billing rules in one file. A file of several closely related pieces (a type with its parser and printer; a feature's handler, validation, and DTOs) is cohesive.
