---
globs: ["**/*.{ts,tsx,js,jsx,py,go}"]
---
#### Export visibility

TypeScript does not support restricting the visibility for exported symbols.
Only export symbols that are used outside of the module. Generally minimize the
exported API surface of modules.
