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
# Keep entry points thin

HTTP route handlers, RPC methods, CLI command handlers, message consumers, and UI event handlers should translate input, call application or domain code, and translate the result. Report such entry points that contain substantial business logic inline: multi-step workflows, pricing or eligibility rules, permission rules beyond a single check, or state machines. Input parsing, validation of request shape, and response formatting belong in the entry point and are fine.
