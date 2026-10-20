---
globs: ["**/*.go"]
---
# Handle errors

Do not discard errors. Every `error` a call returns must be checked, returned, or wrapped. Assigning it to `_` or calling an error-returning function as a bare statement is a violation. Exceptions: the `fmt.Print` family, and `defer f.Close()` on a file opened only for reading.
