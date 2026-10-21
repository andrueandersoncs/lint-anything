---
globs: ["**/*.{ts,tsx,js,jsx,py,go}"]
---
## File Organization

- Don't create utility grab-bag files (`utils.ts`, `helpers.ts`). Place functions in domain-specific modules.
- One concern per file. If a file grows beyond ~300 lines, it likely needs splitting.
