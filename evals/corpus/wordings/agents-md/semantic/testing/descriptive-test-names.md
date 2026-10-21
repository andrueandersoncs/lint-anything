---
globs: ["**/*.test.{ts,tsx,js}", "**/*.spec.{ts,tsx,js}", "**/*_test.{ts,go,py}", "**/test_*.py", "**/tests/**/*.py", "**/test/**/*.{ts,js}"]
---
## Testing

- Test names: descriptive, include the symbol and criteria
  - `delay() resolves immediately with ms = 0`
  - `ensureDirSync() creates dir if it does not exist`
