---
globs: ["**/*.{ts,tsx,js,jsx,py,go}"]
---
# Names must not lie

A function's name must describe what it actually does. Report functions whose name promises less or something different than their body:
- a name that reads as a query (`get…`, `is…`, `has…`, `find…`, `compute…`, `validate…`) but the function also changes state, writes to storage, sends messages, or has other side effects;
- a name that describes one action while the body does a different or substantially larger job (`saveUser` that also emails the user and charges a card).

Caching or lazy initialization inside a getter does not count as a side effect.
