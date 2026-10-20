---
globs: ["**/*.ts"]
# Each line with the word `any`.
select: |
  rg --json -w 'any' "$@" |
    jq -c 'select(.type == "match") | (.data.lines.text | rtrimstr("\n")) as $t | {id: "\(.data.path.text):\(.data.line_number)", path: .data.path.text, lines: [.data.line_number, .data.line_number + ($t | split("\n") | length) - 1], text: $t}'
---
# No any

Do not use the `any` type, including `as any`, `any[]`, and `Array<any>`. Use `unknown` and narrow it. The word "any" in comments, strings, or identifiers does not count.
