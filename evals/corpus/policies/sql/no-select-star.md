---
globs: ["**/*.sql"]
---
# No SELECT *

Queries must list their columns. `SELECT *` and `table.*` in a select list are violations. `COUNT(*)` and `SELECT *` directly inside an `EXISTS (...)` subquery are fine.
