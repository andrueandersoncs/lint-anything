---
globs: ["**/*.{ts,tsx,js,jsx,py,go}"]
---
# Name things by what they mean

Names of variables, functions, parameters, and types should say what the thing represents in the problem domain, not what kind of value it is or how it is computed.

Report a name that is a generic placeholder — `data`, `info`, `obj`, `item`, `tmp`, `res`, `result`, `val`, `thing`, `stuff`, `handle`, `process`, `doWork`, `manager`, `helper`, `util` — when the surrounding code makes a more specific name obvious (for example `data` holding an invoice, or `process()` that sends a reminder email).

Not violations: loop counters and indices, conventional short names in tiny scopes (`i`, `err`, `ctx`, `e` in a one-line callback), names dictated by an external API or interface, and generic names in genuinely generic code (a `map` helper's `item`).
