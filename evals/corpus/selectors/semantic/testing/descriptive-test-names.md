---
globs: ["**/*.test.{ts,tsx,js}", "**/*.spec.{ts,tsx,js}", "**/*_test.{ts,go,py}", "**/test_*.py", "**/tests/**/*.py", "**/test/**/*.{ts,js}"]
# Each test: its declaration and up to 25 lines of its body.
select: |
  rg --json -U -P '^[ \t]*(?:func Test\w+|(?:async )?def test_\w+|(?:it|test)\(\s*["\x27\x60]).*\n(?:(?![ \t]*(?:func Test|(?:async )?def test_|(?:it|test)\(\s*["\x27\x60])).*\n){0,25}' "$@" |
    jq -c 'select(.type == "match") | (.data.lines.text | rtrimstr("\n")) as $t | {id: "\(.data.path.text):\(.data.line_number)", path: .data.path.text, lines: [.data.line_number, .data.line_number + ($t | split("\n") | length) - 1], text: $t}'
---
# Test names state the scenario

Each test's name or description should say what situation it exercises and what outcome it expects ("rejects expired tokens", `test_refund_exceeding_balance_raises`). Report tests named only after the function under test, numbered or vague names (`test1`, `testHandler`, "works", "basic"), when the test body checks a specific behavior that the name doesn't mention.
