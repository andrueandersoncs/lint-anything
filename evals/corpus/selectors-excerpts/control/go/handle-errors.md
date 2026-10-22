---
# Excerpts of at most 1,000 bytes, asked about as the excerpt CLI asked (evals/RESEARCH.md, H19).
select: |
  for f do shift; case $f in *.go) set -- "$@" "$f";; esac; done
  [ $# -gt 0 ] || exit 0
  bun "$EVAL_STEPS/excerpts.ts" 1000 "$@"
criteria:
  "true": "The file contains at least one complete violation of the rule."
  "false": "The file follows the rule, or the rule governs nothing in it."
---
Each question shows one excerpt of a file with its path and line range. Decide whether that excerpt contains at least one violation of the rule below.
Return a calibrated probability that the answer is yes.

Rule:
# Handle errors

Do not discard errors. Every `error` a call returns must be checked, returned, or wrapped. Assigning it to `_` or calling an error-returning function as a bare statement is a violation. Exceptions: the `fmt` print functions (`Print`, `Printf`, `Println`, `Fprint`, `Fprintf`, `Fprintln`), and `defer f.Close()` on a file opened only for reading.
