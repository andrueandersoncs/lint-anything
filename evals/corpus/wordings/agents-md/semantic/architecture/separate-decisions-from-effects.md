---
globs: ["**/*.{ts,tsx,js,jsx,py,go}"]
---
## State and side effects

Prefer a functional core: keep business logic pure and push I/O to the edges, to the degree the app allows.

- Keep transformation and business-rule code free of side effects. Never hide I/O, clock, randomness, or mutation inside code that looks like pure computation.
