---
globs: ["**/*.{ts,tsx,js,jsx,py,go}"]
---
# Don't leak mutable internals

A class or module that owns mutable state must control how it changes. Report code that hands callers direct access to internal mutable state — returning an internal list, map, or object by reference from a public method or property, exposing a mutable field publicly so callers modify it, or accepting a caller's mutable object and storing it without copying when later changes would corrupt the owner's invariants.

Immutable values, deliberate copies, read-only views, and plain data records with no invariants (DTOs, config structs) are fine.
