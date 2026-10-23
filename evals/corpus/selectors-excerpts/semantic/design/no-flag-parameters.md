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
# No flag arguments

Don't use a boolean parameter to make one function do two different jobs (`render(doc, true)`, `fetchUser(id, includeDeleted, skipCache)`). Split it into separate functions, or replace the boolean with a named option whose meaning is clear at the call site. A boolean that is simply data being stored or forwarded (`setEnabled(enabled)`, a struct field) is fine, and so is a boolean inside an options object or keyword-only argument whose name explains it.
