---
# Each `except` clause with its handler body.
select: |
  for f do shift; case $f in *.py) set -- "$@" "$f";; esac; done
  [ $# -gt 0 ] || exit 0
  rg --json -U -P '^([ \t]*)except\b.*\n(?:\1[ \t]+.*\n|[ \t]*\n)*' "$@" |
    jq -c 'select(.type == "match") | (.data.lines.text | rtrimstr("\n")) as $t | {id: "\(.data.path.text):\(.data.line_number)", path: .data.path.text, lines: [.data.line_number, .data.line_number + ($t | split("\n") | length) - 1], text: $t}' |
  bun "$EVAL_STEPS/present.ts"
criteria:
  "true": "The item contains at least one complete violation of the rule."
  "false": "The item follows the rule, or the rule governs nothing in it."
---
Each question shows one item with its location and any context. Decide whether that item contains at least one violation of the rule below.
Return a calibrated probability that the answer is yes.

Rule:
# Don't swallow exceptions

Do not use a bare `except:`. Do not catch `Exception` or `BaseException` unless the handler re-raises or logs the exception. Catching a specific exception type is fine, whatever the handler does.
