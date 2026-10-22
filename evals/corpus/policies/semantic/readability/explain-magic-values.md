---
# Each line holding an unnamed number or string literal that isn't a message, key, import, or type, with its
# literals, where they recur in the file (and any constant naming them), and its enclosing block.
select: |
  for f do shift; case $f in *.ts|*.tsx|*.js|*.jsx|*.py|*.go) set -- "$@" "$f";; esac; done
  [ $# -gt 0 ] || exit 0
  bun "$EVAL_STEPS/literals.ts" "$@" | bun "$EVAL_STEPS/enclosing.ts" |
  bun "$EVAL_STEPS/present.ts"
criteria:
  "true": "The item contains at least one complete violation of the rule."
  "false": "The item follows the rule, or the rule governs nothing in it."
---
Each question shows one item with its location and any context. Decide whether that item contains at least one violation of the rule below.
Return a calibrated probability that the answer is yes.

Rule:
# Name values that carry meaning

Literal numbers and strings that encode a business or operational decision — thresholds, limits, timeouts, retry counts, rates, status codes, special identifiers — must be given a name (a constant, enum member, or config field) instead of appearing inline.

Self-explanatory literals are fine: 0, 1, -1, empty strings, simple arithmetic (`* 2`, `/ 100` for percent), array indices, format strings, log messages, values in tests that are the subject of the assertion, and values that are named by the keyword argument or field they are assigned to (`timeout_seconds=30`).
