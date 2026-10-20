---
globs: ["**/*.{ts,tsx,js,jsx,py,go}"]
---
# Don't repeat knowledge

Each business rule or non-trivial piece of logic should be written once. Report two or more blocks in the file that implement the same rule or computation — copy-pasted with small edits, or the same formula or validation spelled out in several places — so that a change to the rule would have to be made in each copy. Repeated boilerplate that is idiomatic and carries no rule (logging calls, error checks like `if err != nil { return err }`, similar test cases with different data) is not duplication.
