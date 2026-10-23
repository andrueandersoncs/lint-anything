---
# Excerpts of at most 1,000 bytes, asked about as the excerpt CLI asked (evals/RESEARCH.md, H19).
select: |
  rg --files --hidden --sort path -g '*.{ts,tsx,js,jsx,py,go}' |
  bun "$EVAL_STEPS/excerpts.ts" 1000
criteria:
  "true": "The file contains at least one complete violation of the rule."
  "false": "The file follows the rule, or the rule governs nothing in it."
---
Each question shows one excerpt of a file with its path and line range. Decide whether that excerpt contains at least one violation of the rule below.
Return a calibrated probability that the answer is yes.

Rule:
# Keep the cause when handling errors

When code catches, wraps, or converts an error, it must keep the original error (as a cause, wrapped error, or chained exception) and say which operation failed. Report handlers that replace an error with a generic message (`"something went wrong"`, `"failed"`), that rethrow a new error without the original, or that log only a fixed string and drop the error's details.

Handlers that deliberately map a specific expected error to a normal outcome (a missing file meaning "use defaults", a 404 meaning `None`) are not violations.
