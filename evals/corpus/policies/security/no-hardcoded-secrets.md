---
globs: ["**/*.{ts,js,py,go,sh,sql,yml,yaml}", "**/Dockerfile"]
---
# No hardcoded secrets

Do not commit real credentials: API keys, access tokens, passwords, private keys, or connection strings that embed a password.

Not violations:
- values read from the environment, a secret manager, or a mounted file;
- obvious placeholders such as `changeme`, `<your-api-key>`, `xxxx`, or an empty string;
- clearly fake values in test files (paths containing `test` or `fixtures`), such as `test-token`.
