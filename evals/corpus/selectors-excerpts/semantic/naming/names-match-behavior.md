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
# Names must not lie

A function's name must describe what it actually does. Report functions whose name promises less or something different than their body:
- a name that reads as a query (`get…`, `is…`, `has…`, `find…`, `compute…`, `validate…`) but the function also changes state, writes to storage, sends messages, or has other side effects;
- a name that describes one action while the body does a different or substantially larger job (`saveUser` that also emails the user and charges a card).

Caching or lazy initialization inside a getter does not count as a side effect.
