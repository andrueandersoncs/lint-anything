---
globs: ["**/*.py"]
# Each `except` clause with its handler body.
select: |
  rg --json -U -P '^([ \t]*)except\b.*\n(?:\1[ \t]+.*\n|[ \t]*\n)*' "$@" |
    jq -c 'select(.type == "match") | (.data.lines.text | rtrimstr("\n")) as $t | {id: "\(.data.path.text):\(.data.line_number)", path: .data.path.text, lines: [.data.line_number, .data.line_number + ($t | split("\n") | length) - 1], text: $t}'
---
# Don't swallow exceptions

Do not use a bare `except:`. Do not catch `Exception` or `BaseException` unless the handler re-raises or logs the exception. Catching a specific exception type is fine, whatever the handler does.
