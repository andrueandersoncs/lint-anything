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
# Don't leak mutable internals

A class or module that owns mutable state must control how it changes. Report code that hands callers direct access to internal mutable state — returning an internal list, map, or object by reference from a public method or property, exposing a mutable field publicly so callers modify it, or accepting a caller's mutable object and storing it without copying when later changes would corrupt the owner's invariants.

Immutable values, deliberate copies, read-only views, and plain data records with no invariants (DTOs, config structs) are fine.
