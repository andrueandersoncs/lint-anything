---
# Each line with the word `any`.
select: |
  rg --json -w 'any' --hidden -g '*.ts' |
    jq -c 'select(.type == "match") | (.data.lines.text | rtrimstr("\n")) as $t | {id: "\(.data.path.text):\(.data.line_number)", path: .data.path.text, lines: [.data.line_number, .data.line_number + ($t | split("\n") | length) - 1], text: $t}' |
  bun "$EVAL_STEPS/present.ts"
criteria:
  "true": "The item contains at least one complete violation of the rule."
  "false": "The item follows the rule, or the rule governs nothing in it."
---
Each question shows one item with its location and any context. Decide whether that item contains at least one violation of the rule below.
Return a calibrated probability that the answer is yes.

Rule:
# No any

Do not use the `any` type, including `as any`, `any[]`, and `Array<any>`. Use `unknown` and narrow it. The word "any" in comments, strings, or identifiers does not count.
