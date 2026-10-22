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
# Export only what callers need

Keep a module's public surface as small as its purpose allows. Report exported or public functions, methods, types, or constants that are evidently internal implementation steps — helpers used only by other members of the same file to build their result, intermediate stages of an exported computation, or members that exist only to support the class's own implementation — when nothing about the file suggests outside callers need them.

Modules whose purpose is to be a toolbox of independent utilities, and members required by an interface or framework, are fine.
