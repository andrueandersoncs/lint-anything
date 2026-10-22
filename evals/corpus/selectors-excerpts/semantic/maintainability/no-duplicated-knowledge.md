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
# Don't repeat knowledge

Each business rule or non-trivial piece of logic should be written once. Report two or more blocks in the file that implement the same rule or computation — copy-pasted with small edits, or the same formula or validation spelled out in several places — so that a change to the rule would have to be made in each copy. Repeated boilerplate that is idiomatic and carries no rule (logging calls, error checks like `if err != nil { return err }`, similar test cases with different data) is not duplication.
