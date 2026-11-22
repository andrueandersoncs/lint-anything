---
# Each outermost function with the generic or short names it declares, and each run of module-level code.
select: |
  rg --files --hidden --sort path -g '*.{ts,tsx,js,jsx,py,go}' |
  bun "$EVAL_STEPS/functions.ts" --outer --module --names |
  bun "$EVAL_STEPS/present.ts"
criteria:
  "true": "A non-trivial variable, function, parameter, or type uses a generic placeholder name (data, info, obj, item, tmp, res, val, handle, process, helper) where a domain-specific name is obvious."
  "false": "Names reflect domain meaning, or short/generic names are loop counters, tiny-scope conventions (i, err, ctx), external API names, or genuinely generic code."
---
Each question shows one item with its location and any context. Decide whether that item contains at least one violation of the rule below.
Return a calibrated probability that the answer is yes.

Rule:
# Name things by what they mean

Names of variables, functions, parameters, and types should say what the thing represents in the problem domain, not what kind of value it is or how it is computed.

Report a name that is a generic placeholder — `data`, `info`, `obj`, `item`, `tmp`, `res`, `result`, `val`, `thing`, `stuff`, `handle`, `process`, `doWork`, `manager`, `helper`, `util` — when the surrounding code makes a more specific name obvious (for example `data` holding an invoice, or `process()` that sends a reminder email).

Not violations: loop counters and indices, conventional short names in tiny scopes (`i`, `err`, `ctx`, `e` in a one-line callback), names dictated by an external API or interface, and generic names in genuinely generic code (a `map` helper's `item`).
