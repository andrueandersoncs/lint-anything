---
globs: ["**/*.{ts,tsx,js,jsx,py,go}"]
---
# Export only what callers need

Keep a module's public surface as small as its purpose allows. Report exported or public functions, methods, types, or constants that are evidently internal implementation steps — helpers used only by other members of the same file to build their result, intermediate stages of an exported computation, or members that exist only to support the class's own implementation — when nothing about the file suggests outside callers need them.

Modules whose purpose is to be a toolbox of independent utilities, and members required by an interface or framework, are fine.
