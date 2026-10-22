---
# Each error handler (a catch or except clause, a `.catch(…)` handler, a Go `if` that tests an error, a Go
# error built from another), with the code whose error it handles and the line opening its function.
select: |
  for f do shift; case $f in *.ts|*.tsx|*.js|*.jsx|*.py|*.go) set -- "$@" "$f";; esac; done
  [ $# -gt 0 ] || exit 0
  bun "$EVAL_STEPS/errors.ts" "$@" |
  bun "$EVAL_STEPS/present.ts"
criteria:
  "true": "The item contains at least one complete violation of the rule."
  "false": "The item follows the rule, or the rule governs nothing in it."
---
Each question shows one item with its location and any context. Decide whether that item contains at least one violation of the rule below.
Return a calibrated probability that the answer is yes.

Rule:
# Keep the cause when handling errors

When code catches, wraps, or converts an error, it must keep the original error (as a cause, wrapped error, or chained exception) and say which operation failed. Report handlers that replace an error with a generic message (`"something went wrong"`, `"failed"`), that rethrow a new error without the original, or that log only a fixed string and drop the error's details.

Handlers that deliberately map a specific expected error to a normal outcome (a missing file meaning "use defaults", a 404 meaning `None`) are not violations.
