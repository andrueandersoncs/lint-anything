---
globs: ["**/*.py"]
---
# No mutable default arguments

Function parameters must not default to a mutable value: a list, dict, or set literal, or a call that builds one (`list()`, `dict()`, `set()`, `defaultdict(...)`). Default to `None` and build the value inside the function. Tuples, frozensets, strings, numbers, and `None` are fine.
