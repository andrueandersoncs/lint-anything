---
globs: ["**/*.{ts,tsx,js,jsx,py,go}"]
---
# One responsibility per unit

Each function and class should have one coherent responsibility. Report a function or class that combines jobs which would change for different reasons — for example parsing input, applying business rules, persisting results, and formatting output all in one unit — when those parts could be separated. Coordinating functions that only call well-named steps in sequence are fine; that coordination is their one job.
