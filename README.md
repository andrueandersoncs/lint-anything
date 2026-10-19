# lint-anything

Lint any text file against plain-English policies, judged by Cloudflare's [Clef](https://developers.cloudflare.com/workers-ai/models/clef/) decision model on Workers AI.

## Run

```sh
bun install
echo 'CLOUDFLARE_ACCOUNT_ID=...' >> .env
echo 'CLOUDFLARE_AUTH_TOKEN=...' >> .env
bun index.ts 'src/**/*.ts'
```

Pass one or more globs. They are expanded relative to the current directory, deduplicated, and read whole. Scope them (for example `src/**/*.ts`, not `**/*`) to avoid `node_modules`.

| Flag | Default | Meaning |
| --- | --- | --- |
| `--rules-dir` | `.lint-anything/rules` | Policy directory |
| `--threshold` | `0.7` | Violation probability (0–1) that fails the run |
| `--model` | `clef` | `clef` or `clef-flash` |
| `--json` | off | Print every finding as JSON |

| Environment variable | Required | Meaning |
| --- | --- | --- |
| `CLOUDFLARE_ACCOUNT_ID` | yes | Workers AI account |
| `CLOUDFLARE_AUTH_TOKEN` | yes | API token |
| `CLOUDFLARE_API_BASE_URL` | no | Defaults to `https://api.cloudflare.com/client/v4` |

Bun loads `.env` automatically.

## Policies

There are no built-in policies. Add Markdown files anywhere under the rules directory, including subdirectories:

```md
---
globs: ["src/**/*.ts"]
---
# No debugger

Remove debugger statements.
```

- Frontmatter must list at least one glob. A policy checks a file only when one of its globs matches the file's path as found by the CLI globs (for example `src/a.ts`).
- The body after the frontmatter must not be empty.
- The policy name is its path relative to the rules directory, without `.md` (for example `sub/no-debugger`).
- The whole policy file, frontmatter included, is sent to Clef verbatim.

A missing rules directory, one with no `.md` files, or an invalid policy stops the run.

## How it works

Each file is paired with every policy whose globs match its path. Each pair is one Clef request, with up to 8 in flight. The request carries the file's path and complete contents, and asks one question: does the file violate the policy? Clef answers with a probability. A policy that doesn't apply to a file scores low and passes.

| Result | Verdict |
| --- | --- |
| `violates ≤ 0.55` | `pass` |
| `violates ≥ --threshold` | `violation` |
| otherwise | `review` |
| request over 64,000 bytes | `inconclusive` (not sent; Clef would truncate it) |

Transient HTTP failures are retried up to 3 times with exponential backoff.

## Output

Text output prints one line per non-passing finding — verdict, violation probability, path, policy, and reason — then a count per verdict:

```
violation     0.93   src/a.ts  no-debugger
1 checks: 1 violation, 0 review, 0 inconclusive, 0 pass
```

`--json` prints `{ "findings": [...] }` with every finding, passes included. Each finding has `path`, `policy`, `verdict`, and either `violates` or `reason`.

Only `violation` fails the run; `review` and `inconclusive` are reported but exit `0`.

| Exit code | Meaning |
| --- | --- |
| `0` | No violations |
| `1` | At least one violation, or an input file could not be read |
| `2` | Policy, configuration, or Clef API error |

## Develop

```sh
bunx tsc --noEmit
```
