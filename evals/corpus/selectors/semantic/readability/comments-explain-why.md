---
globs: ["**/*.{ts,tsx,js,jsx,py,go}"]
# Each run of comment lines with the line after it.
select: |
  rg --json -U -P '^(?:[ \t]*(?://|#|/\*|\*).*\n)+.*' "$@" |
    jq -c 'select(.type == "match") | (.data.lines.text | rtrimstr("\n")) as $t | {id: "\(.data.path.text):\(.data.line_number)", path: .data.path.text, lines: [.data.line_number, .data.line_number + ($t | split("\n") | length) - 1], text: $t}'
---
# Comments explain why

We use comments for intent, constraints, and reasons — not to narrate code. Report comments that only restate what the next line obviously does (`// increment i`, `# loop over users`, `// return the result`), and comments that contradict the code they describe. Doc comments describing a public API, license headers, and tool directives are not violations.
