---
# Each ~1 KB excerpt of the file, numbered, with the code elsewhere in the file most like it and its lines and literals that recur elsewhere.
select: |
  rg --files --hidden --sort path -g '*.{ts,tsx,js,jsx,py,go}' |
  bun "$EVAL_STEPS/duplicates.ts" |
  bun "$EVAL_STEPS/present.ts"
criteria:
  "true": "The item contains at least one complete violation of the rule."
  "false": "The item follows the rule, or the rule governs nothing in it."
---
Each question shows one item with its location and any context. Decide whether that item contains at least one violation of the rule below.
Return a calibrated probability that the answer is yes.

Rule:
# Don't repeat knowledge

Each business rule or non-trivial piece of logic should be written once. Report two or more blocks in the file that implement the same rule or computation — copy-pasted with small edits, or the same formula or validation spelled out in several places — so that a change to the rule would have to be made in each copy. Repeated boilerplate that is idiomatic and carries no rule (logging calls, error checks like `if err != nil { return err }`, similar test cases with different data) is not duplication.
