## Code design principles

- Avoid magic numbers and strings. Extract recurring or meaningful values into descriptive `const` or `enum`. Keep self-explanatory one-off values inline to avoid clutter. If a value comes from a spec (e.g. an HTTP status), use a constant regardless.
