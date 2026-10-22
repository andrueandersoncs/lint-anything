---
# Each TODO or FIXME line.
select: |
  for f do shift; case $f in *.ts|*.js|*.py|*.go|*.sh|*.sql) set -- "$@" "$f";; esac; done
  [ $# -gt 0 ] || exit 0
  rg --json -w 'TODO|FIXME' "$@" |
    jq -c 'select(.type == "match") | (.data.lines.text | rtrimstr("\n")) as $t | {id: "\(.data.path.text):\(.data.line_number)", path: .data.path.text, lines: [.data.line_number, .data.line_number + ($t | split("\n") | length) - 1], text: $t}' |
  bun "$EVAL_STEPS/present.ts"
criteria:
  "true": "The item contains at least one complete violation of the rule."
  "false": "The item follows the rule, or the rule governs nothing in it."
---
Each question shows one item with its location and any context. Decide whether that item contains at least one violation of the rule below.
Return a calibrated probability that the answer is yes.

Rule:
# TODOs reference an issue

Every `TODO` or `FIXME` comment must reference a tracking issue, written as `#123`, `ABC-123`, or a full issue URL.
