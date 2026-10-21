---
globs: ["**/*.{ts,tsx,js,jsx,py,go}"]
---
## Error Handling

- Preserve useful diagnostics and the original exception when translating
  errors. In Python, use exception chaining (`raise ... from error`) when adding
  context.
- Catch only the exceptions that can be handled meaningfully. Do not replace a
  useful exception with a generic message, return sentinel values for unexpected
  failures, or use a broad `except` to make a failing path appear successful.
