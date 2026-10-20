---
globs: ["**/*.{ts,tsx,js,jsx,py,go}"]
# Each run of comment lines with the line after it, minus those Clef (clef-flash) judges exempt from the rule.
select: |
  rg --json -U -P '^(?:[ \t]*(?://|#|/\*|\*).*\n)+.*' "$@" |
    jq -c 'select(.type == "match") | (.data.lines.text | rtrimstr("\n")) as $t | {id: "\(.data.path.text):\(.data.line_number)", path: .data.path.text, lines: [.data.line_number, .data.line_number + ($t | split("\n") | length) - 1], text: $t}' |
    $LINT_ANYTHING ask --no-cache --model clef-flash --field exempt "Is this comment a license header, a doc comment describing a public API, or a tool directive (such as eslint-disable, noqa, or //go:)?" |
    jq -c 'select((.exempt | tonumber) < 0.5) | del(.exempt)'
---
# Comments explain why

We use comments for intent, constraints, and reasons — not to narrate code. Report comments that only restate what the next line obviously does (`// increment i`, `# loop over users`, `// return the result`), and comments that contradict the code they describe. Doc comments describing a public API, license headers, and tool directives are not violations.
