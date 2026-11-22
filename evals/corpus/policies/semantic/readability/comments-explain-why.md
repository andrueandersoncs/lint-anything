---
# Each run of comment lines with the line after it.
select: |
  rg --files --hidden --sort path -g '*.{ts,tsx,js,jsx,py,go}' |
  bun "$EVAL_STEPS/comments.ts" |
  bun "$EVAL_STEPS/present.ts"
criteria:
  "true": "The comment merely narrates what the immediately following code obviously does, or directly contradicts what the following code actually does."
  "false": "The comment explains why/constraints/intent, or is a public API doc comment, license header, or tool directive."
---
Each question shows one item with its location and any context. Decide whether that item contains at least one violation of the rule below.
Return a calibrated probability that the answer is yes.

Rule:
# Comments explain why

We use comments for intent, constraints, and reasons — not to narrate code. Report comments that only restate what the next line obviously does (`// increment i`, `# loop over users`, `// return the result`), and comments that contradict the code they describe. Doc comments describing a public API, license headers, and tool directives are not violations.
