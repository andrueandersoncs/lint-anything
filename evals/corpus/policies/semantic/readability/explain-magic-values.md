---
# Each line holding an unnamed number or string literal that isn't a message, key, import, or type, with its
# literals, where they recur in the file (and any constant naming them), and its enclosing block.
select: |
  rg --files --hidden --sort path -g '*.{ts,tsx,js,jsx,py,go}' |
  bun "$EVAL_STEPS/literals.ts" | bun "$EVAL_STEPS/enclosing.ts" |
  bun "$EVAL_STEPS/file-role.ts" |
  bun "$EVAL_STEPS/present.ts"
criteria:
  "true": "An inline literal number or string encodes an unnamed business or operational decision (threshold, limit, timeout, retry count, rate, status code, special id)."
  "false": "The literal is self-explanatory (0, 1, -1, empty string, simple math, index, format/log message, test assertion value) or already named by a constant/field/keyword arg."
---
Each question shows one item with its location and any context. Decide whether that item contains at least one violation of the rule below.
Return a calibrated probability that the answer is yes.

Rule:
# Name values that carry meaning

Literal numbers and strings that encode a business or operational decision — thresholds, limits, timeouts, retry counts, rates, status codes, special identifiers — must be given a name (a constant, enum member, or config field) instead of appearing inline.

Self-explanatory literals are fine: 0, 1, -1, empty strings, simple arithmetic (`* 2`, `/ 100` for percent), array indices, format strings, log messages, values in tests that are the subject of the assertion, and values that are named by the keyword argument or field they are assigned to (`timeout_seconds=30`).
