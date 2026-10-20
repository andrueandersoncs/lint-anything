---
globs: ["**/*.{ts,tsx,js,jsx,py,go}"]
---
# Keep the cause when handling errors

When code catches, wraps, or converts an error, it must keep the original error (as a cause, wrapped error, or chained exception) and say which operation failed. Report handlers that replace an error with a generic message (`"something went wrong"`, `"failed"`), that rethrow a new error without the original, or that log only a fixed string and drop the error's details.

Handlers that deliberately map a specific expected error to a normal outcome (a missing file meaning "use defaults", a 404 meaning `None`) are not violations.
