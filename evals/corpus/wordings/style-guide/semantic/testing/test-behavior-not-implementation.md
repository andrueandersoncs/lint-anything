---
globs: ["**/*.test.{ts,tsx,js}", "**/*.spec.{ts,tsx,js}", "**/*_test.{ts,go,py}", "**/test_*.py", "**/tests/**/*.py", "**/test/**/*.{ts,js}"]
---
### Validate private methods with public methods

In most cases, you don't need to test a private method in your code. Private methods are an implementation detail and never exist in isolation. At some point in the development process, you introduce a public-facing method to call the private method as part of its implementation. When you write your unit tests, what you care about is the end result of the public method that calls into the private one.

When you encounter a private method, locate the public method that calls the private method, and write your tests against the public method. Just because a private method returns an expected result, doesn't mean the system that eventually calls the private method uses the result correctly.
