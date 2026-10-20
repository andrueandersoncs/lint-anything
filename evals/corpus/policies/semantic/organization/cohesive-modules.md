---
globs: ["**/*.{ts,tsx,js,jsx,py,go}"]
---
# One topic per file

A file should be about one thing. Report files that bundle unrelated concerns which would naturally change for different reasons and belong in different modules — for example date-formatting helpers, an HTTP client wrapper, and billing rules in one file. A file of several closely related pieces (a type with its parser and printer; a feature's handler, validation, and DTOs) is cohesive.
