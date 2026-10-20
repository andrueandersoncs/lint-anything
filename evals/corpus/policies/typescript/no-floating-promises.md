---
globs: ["**/*.ts"]
---
# No floating promises

Every promise must be awaited, returned, chained with `.catch`, passed to something that handles it (such as `Promise.all`), or explicitly discarded with `void`. Calling an async function or another promise-returning API as a bare statement is a violation.
