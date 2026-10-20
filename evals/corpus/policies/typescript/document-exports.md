---
globs: ["src/**/*.ts"]
---
# Document exports

Every exported function, class, and exported `const` holding a function must have a JSDoc comment (`/** ... */`) directly above it. Exported types, interfaces, and non-function constants are exempt. Re-exports (`export { x } from`) are exempt.
