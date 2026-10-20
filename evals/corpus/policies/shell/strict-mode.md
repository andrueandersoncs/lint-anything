---
globs: ["**/*.sh"]
---
# Strict mode

Shell scripts must enable strict mode with `set -euo pipefail`, or the same three options set separately, before running any other command. Comments, the shebang, and blank lines may come first.
