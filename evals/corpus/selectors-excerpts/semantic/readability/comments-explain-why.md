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
# Comments explain why

We use comments for intent, constraints, and reasons — not to narrate code. Report comments that only restate what the next line obviously does (`// increment i`, `# loop over users`, `// return the result`), and comments that contradict the code they describe. Doc comments describing a public API, license headers, and tool directives are not violations.
