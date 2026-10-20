---
globs: ["**/*.{ts,tsx,js,jsx,py,go}"]
---
# Separate decisions from I/O

Business decisions should be computed separately from the I/O that feeds or acts on them. Report a function that both makes a non-trivial domain decision (pricing, eligibility, validation rules, state transitions, choosing which action to take) and performs I/O itself (database queries, network calls, file or queue access, sending email) in the same body, where the decision could be a separate function that receives data and returns a result.

Thin glue that loads data, calls a decision function, and stores the outcome is the intended shape and is fine.
