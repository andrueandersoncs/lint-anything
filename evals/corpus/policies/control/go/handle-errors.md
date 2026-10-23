---
# Each statement that could drop a returned error (a bare call, a defer or go call, an assignment to `_`),
# with the callee's signature when this file declares it, which result `_` takes, and where the receiver was set.
select: |
  rg --files --hidden --sort path -g '*.go' |
  bun "$EVAL_STEPS/errors-go.ts" |
  bun "$EVAL_STEPS/present.ts"
criteria:
  "true": "The item contains at least one complete violation of the rule."
  "false": "The item follows the rule, or the rule governs nothing in it."
---
Each question shows one item with its location and any context. Decide whether that item contains at least one violation of the rule below.
Return a calibrated probability that the answer is yes.

Rule:
# Handle errors

Do not discard errors. Every `error` a call returns must be checked, returned, or wrapped. Assigning it to `_` or calling an error-returning function as a bare statement is a violation. Exceptions: the `fmt` print functions (`Print`, `Printf`, `Println`, `Fprint`, `Fprintf`, `Fprintln`), and `defer f.Close()` on a file opened only for reading.
