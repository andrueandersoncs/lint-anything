---
globs: ["**/*.{ts,tsx,js,jsx,py,go}"]
---
# One level of detail per function

Each function should read at one level of abstraction. Report a function that mixes high-level steps (calls like `validateOrder(order)`, `chargeCustomer(order)`, `sendReceipt(order)`) with low-level mechanics in the same body — string slicing and parsing, byte or index arithmetic, regular expressions, raw SQL text, manual HTTP header handling — where those mechanics could sit behind a named helper. Short functions that are entirely low-level, or entirely orchestration, are fine.
