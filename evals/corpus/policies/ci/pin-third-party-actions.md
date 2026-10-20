---
globs: [".github/workflows/*.yml", ".github/workflows/*.yaml"]
---
# Pin third-party actions

Every `uses:` that references a third-party GitHub Action must pin a full 40-character commit SHA. Actions owned by `actions/` or `github/` may use a version tag. Local actions (`./path`) and `docker://` images are out of scope.
