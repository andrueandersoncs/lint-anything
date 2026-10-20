---
globs: ["**/*.test.{ts,tsx,js}", "**/*.spec.{ts,tsx,js}", "**/*_test.{ts,go,py}", "**/test_*.py", "**/tests/**/*.py", "**/test/**/*.{ts,js}"]
---
# Test names state the scenario

Each test's name or description should say what situation it exercises and what outcome it expects ("rejects expired tokens", `test_refund_exceeding_balance_raises`). Report tests named only after the function under test, numbered or vague names (`test1`, `testHandler`, "works", "basic"), when the test body checks a specific behavior that the name doesn't mention.
