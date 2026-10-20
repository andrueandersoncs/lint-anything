---
globs: ["**/*.{ts,tsx,js,jsx,py,go}"]
---
# Make dependencies explicit

Functions and classes should receive their collaborators — database or HTTP clients, repositories, clocks, random sources, configuration — through parameters or constructors. Report code that instead reaches for a module-level mutable singleton, reads process-wide globals or environment variables deep inside business logic, or constructs its external collaborators internally, so the dependency is hidden from callers and hard to replace in tests.

Not violations: composition roots and entry points (`main`, app setup, dependency-wiring modules) that build and connect dependencies, and pure library calls (math, string, collections).
