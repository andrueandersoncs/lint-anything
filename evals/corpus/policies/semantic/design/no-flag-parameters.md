---
globs: ["**/*.{ts,tsx,js,jsx,py,go}"]
---
# No flag arguments

Don't use a boolean parameter to make one function do two different jobs (`render(doc, true)`, `fetchUser(id, includeDeleted, skipCache)`). Split it into separate functions, or replace the boolean with a named option whose meaning is clear at the call site. A boolean that is simply data being stored or forwarded (`setEnabled(enabled)`, a struct field) is fine, and so is a boolean inside an options object or keyword-only argument whose name explains it.
