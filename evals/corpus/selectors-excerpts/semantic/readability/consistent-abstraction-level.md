---
# Excerpts of at most 1,000 bytes, asked about as the excerpt CLI asked (evals/RESEARCH.md, H19).
select: |
  for f do shift; case $f in *.ts|*.tsx|*.js|*.jsx|*.py|*.go) set -- "$@" "$f";; esac; done
  [ $# -gt 0 ] || exit 0
  bun "$EVAL_STEPS/excerpts.ts" 1000 "$@"
criteria:
  "true": "The file contains at least one complete violation of the rule."
  "false": "The file follows the rule, or the rule governs nothing in it."
---
Each question shows one excerpt of a file with its path and line range. Decide whether that excerpt contains at least one violation of the rule below.
Return a calibrated probability that the answer is yes.

Rule:
# One level of detail per function

Each function should read at one level of abstraction. Report a function that mixes high-level steps (calls like `validateOrder(order)`, `chargeCustomer(order)`, `sendReceipt(order)`) with low-level mechanics in the same body — string slicing and parsing, byte or index arithmetic, regular expressions, raw SQL text, manual HTTP header handling — where those mechanics could sit behind a named helper. Short functions that are entirely low-level, or entirely orchestration, are fine.
