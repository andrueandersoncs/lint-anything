# lint-anything

Lint any text file against plain-English policies, judged by Cloudflare's [Clef](https://developers.cloudflare.com/workers-ai/models/clef/) decision model.

## Run

```sh
bun install
echo 'CLOUDFLARE_ACCOUNT_ID=...' >> .env
echo 'CLOUDFLARE_AUTH_TOKEN=...' >> .env
bun index.ts 'src/**/*.ts'
```

Globs are matched as written, relative to the current directory. Scope them (for example `src/**/*.ts`, not `**/*`) to avoid `node_modules`.

| Flag | Default | Meaning |
| --- | --- | --- |
| `--rules-dir` | `.lint-anything/rules` | Policy directory |
| `--threshold` | `0.7` | Violation probability that fails the run |
| `--model` | `clef` | `clef` or `clef-flash` |
| `--json` | off | Machine-readable findings |

`CLOUDFLARE_API_BASE_URL` overrides `https://api.cloudflare.com/client/v4`.

## Policies

There are no built-in policies. Add Markdown files under `.lint-anything/rules/`:

```md
---
globs: ["src/**/*.ts"]
---
# No debugger

Remove debugger statements.
```

The whole policy file is sent verbatim.

## How it works

For each file and each policy whose globs match its path, one Clef request asks two yes/no questions over the complete file:

- `applies`: is the policy's subject present?
- `violates`: does the file break the policy?

| Result | Verdict |
| --- | --- |
| `violates ≤ 0.55` | `pass` |
| `applies < 0.70` | `inconclusive` |
| `violates ≥ --threshold` | `violation` |
| otherwise | `review` |
| request over 64,000 bytes | `inconclusive` (Clef would truncate it) |

Exit codes: `0` no violations, `1` violations, `2` errors.

## Develop

```sh
bunx tsc --noEmit && bun test
```
