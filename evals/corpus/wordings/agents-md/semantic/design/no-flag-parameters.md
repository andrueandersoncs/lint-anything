- A `bool` stays a `bool` only while every use site reads as a predicate. A
  behavior switch, a bare `true`/`false` argument, or a `bool` in a tuple
  becomes an enum or a struct with named fields. A `bool` named for one of
  several alternatives becomes an enum of those alternatives. Flags that
  constrain each other become one enum of the reachable states, not a struct of
  named flags.
  See [Boolean parameters and fields](./CODE_STYLE_GUIDE.md#boolean-parameters-and-fields).
