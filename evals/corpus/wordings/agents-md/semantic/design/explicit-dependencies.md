- **Global Variables**: Avoid new global variables. Pass dependencies explicitly through function parameters.

    **Allowed:**
    - Constants named `ALL_UPPER_CASE`
    - Immutable configuration objects

    If mutable module-level state is necessary, explain its lifetime and concurrency implications in the PR.
