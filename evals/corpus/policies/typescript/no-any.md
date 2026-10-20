---
globs: ["**/*.ts"]
---
# No any

Do not use the `any` type, including `as any`, `any[]`, and `Array<any>`. Use `unknown` and narrow it. The word "any" in comments, strings, or identifiers does not count.
