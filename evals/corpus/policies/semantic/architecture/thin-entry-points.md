---
globs: ["**/*.{ts,tsx,js,jsx,py,go}"]
---
# Keep entry points thin

HTTP route handlers, RPC methods, CLI command handlers, message consumers, and UI event handlers should translate input, call application or domain code, and translate the result. Report such entry points that contain substantial business logic inline: multi-step workflows, pricing or eligibility rules, permission rules beyond a single check, or state machines. Input parsing, validation of request shape, and response formatting belong in the entry point and are fine.
