---
globs: ["**/*.test.{ts,tsx,js}", "**/*.spec.{ts,tsx,js}", "**/*_test.{ts,go,py}", "**/test_*.py", "**/tests/**/*.py", "**/test/**/*.{ts,js}"]
---
## Testing

- Test real behavior and observable outcomes — `results`, return codes, emitted headers, side effects — not how a function was called. Asserting call shape (`calledWith`, arity, call counts) tests the test and hides signature drift.
