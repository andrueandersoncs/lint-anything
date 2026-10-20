---
globs: ["**/*.{ts,tsx,js,jsx,py,go}"]
# Each line with a numeric literal other than 0 and 1, plus its enclosing block as evidence.
select: |
  rg --json -P '(?<![\w.])(?:[2-9]|\d{2,})(?:\.\d+)?(?![\w.])' "$@" |
    jq -c 'select(.type == "match") | (.data.lines.text | rtrimstr("\n")) as $t | {id: "\(.data.path.text):\(.data.line_number)", path: .data.path.text, lines: [.data.line_number, .data.line_number + ($t | split("\n") | length) - 1], text: $t}' |
    bun "$EVAL_STEPS/enclosing.ts"
---
# Name values that carry meaning

Literal numbers and strings that encode a business or operational decision — thresholds, limits, timeouts, retry counts, rates, status codes, special identifiers — must be given a name (a constant, enum member, or config field) instead of appearing inline.

Self-explanatory literals are fine: 0, 1, -1, empty strings, simple arithmetic (`* 2`, `/ 100` for percent), array indices, format strings, log messages, values in tests that are the subject of the assertion, and values that are named by the keyword argument or field they are assigned to (`timeout_seconds=30`).
