---
globs: ["**/*.go"]
---
# Context comes first

A function or method that takes a `context.Context` must take it as its first parameter. Methods count their receiver separately, so the context must be the first parameter after the receiver.
