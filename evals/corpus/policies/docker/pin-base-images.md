---
globs: ["**/Dockerfile", "**/*.dockerfile"]
---
# Pin base images

Every `FROM` must pin its image to a specific version tag or a digest. An untagged image or the `latest` tag is a violation. A tag naming only a major version (`node:20`) counts as pinned. `FROM` lines naming an earlier build stage are exempt.
