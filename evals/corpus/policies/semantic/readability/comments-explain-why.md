---
# Each run of comment lines with the line after it.
select: |
  rg --json -U -P '^(?:[ \t]*(?://|#|/\*|\*).*\n)+.*' --hidden -g '*.{ts,tsx,js,jsx,py,go}' |
    jq -c 'select(.type == "match") | (.data.lines.text | rtrimstr("\n")) as $t | {id: "\(.data.path.text):\(.data.line_number)", path: .data.path.text, lines: [.data.line_number, .data.line_number + ($t | split("\n") | length) - 1], text: $t}' |
  bun "$EVAL_STEPS/present.ts"
criteria:
  "true": "The item contains at least one complete violation of the rule."
  "false": "The item follows the rule, or the rule governs nothing in it."
---
Each question shows one item with its location and any context. Decide whether that item contains at least one violation of the rule below.
Return a calibrated probability that the answer is yes.

Rule:
# Comments explain why

We use comments for intent, constraints, and reasons — not to narrate code. Report comments that only restate what the next line obviously does (`// increment i`, `# loop over users`, `// return the result`), and comments that contradict the code they describe. Doc comments describing a public API, license headers, and tool directives are not violations.
