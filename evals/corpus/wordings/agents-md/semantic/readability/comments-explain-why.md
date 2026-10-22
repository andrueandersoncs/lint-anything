- **Comment only when context is not readily apparent from the code.**
  Generic purpose explanation do not qualify: `# Log for debugging` above `logging.debug(...)`,
  `# Validate for safety`, `# Retry for reliability` and similar provide no useful information.
  Useful comments record a specific constraint, invariant, compatibility quirk, or tradeoff.
  Before adding a comment, identify the misunderstanding or incorrect change it would prevent.
  If removing a comment will lose non-code-related context, omit it. Do not narrate code, repeat code,
  or invent a rationale in comments. Keep necessary explanations short, precise and at the source of truth.
  Do not repeat comments at each call site. Judge each comment value by the preserved context only.
