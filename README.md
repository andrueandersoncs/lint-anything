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

Each file is paired with every policy whose globs match its path, and all of a file's policies are judged together, with up to 8 files in flight. One Clef request carries short judging guidance, the file's path, and its complete contents once, plus one yes/no question per policy: does the file violate it? Clef answers each question with a probability. A policy that doesn't apply to a file scores low and passes. Files with no matching policy send nothing.

A request holds at most 64 questions (Clef's limit) and 64,000 bytes (24,000 with `clef-flash`, whose context window is smaller). A file whose policies don't fit in one request is split across several, sent one after another. This request shape was chosen with the eval suite below.

| Result | Verdict |
| --- | --- |
| `violates ≤ 0.55` | `pass` |
| `violates ≥ --threshold` | `violation` |
| otherwise | `review` |
| file plus that policy alone over the byte limit | `inconclusive` (not sent; Clef would truncate it) |

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

## Evals

`evals/` scores Clef request strategies against a hand-labeled corpus, so changes to how requests are built can be measured instead of guessed.

```sh
bun evals/validate.ts                      # check the corpus, print label counts per policy and origin
bun evals/validate.ts --verify-upstream    # also check every real file against GitHub, byte for byte
bun evals/run.ts                           # one-factor sweep around production on the dev split
bun evals/run.ts --split all --origin real --category semantic production production,batch=1
```

- **Policies** (`evals/corpus/policies/`) come in two categories, picked with `--category`:
  - `semantic/`: 17 rules of the kind lint-anything is for, which static analysis can't practically enforce. They cover naming (intent-revealing names, names that match behavior), readability (one level of abstraction per function, named magic values, comments that explain why), design (no flag parameters, single responsibility, explicit dependencies, preserving error context), architecture (decisions separate from I/O, thin entry points), encapsulation (no leaked mutable state, minimal public surface), organization (cohesive modules), maintainability (no duplicated knowledge), and testing (behavior over implementation, descriptive test names). Most apply to every `.ts`/`.js`/`.py`/`.go` file; the two testing rules apply to test files. Their wording varies the way users' rules do: some are one-liners, some list exceptions, some are in a team's voice.
  - `control/`: four mechanical rules that existing linters already handle (TODOs need an issue, no `any`, Go errors handled, no swallowed Python exceptions), kept for comparison.
- **Corpus** (`evals/corpus/`): every file is labeled `violates`, `complies`, `not-applicable`, or `ambiguous` against every policy whose globs match it. Each file has an `origin`:
  - `real`: 70 files copied verbatim from 31 permissively licensed GitHub projects with varied styles, among them VS Code, Hono, ky, Deno std, NestJS, tRPC, Django, Flask, requests, scikit-learn, Home Assistant, Kubernetes, Prometheus, cobra, gin, the GitHub CLI, caddy, and etcd (1,042 cases, 184 violating). Each record pins its upstream repo, commit, path, and SPDX license. The license texts are in `evals/corpus/licenses/`.
  - `synthetic`: 15 contrast pairs written for the corpus. Each pair is a realistic file that violates one target semantic rule, and a twin with only that violation fixed (522 cases).
  - `planted`: 12 twins of real files, each with one minimal edit that introduces a violation of a target semantic rule (204 cases). Each twin is paired with its original.

  Every case got two independent labels. Real files were labeled twice blind; synthetic and planted files were labeled by their author and again blind. On real files the labelers agreed 94.5% of the time on violates vs. not (Cohen's κ = 0.80), which is the ceiling for any automated judge. Disagreements were adjudicated against the policy text, and the 2 cases where reasonable reviewers would split are `ambiguous` and excluded from scoring. Files are split dev/test, and pairs stay together.
- **Strategies** (`evals/strategy.ts`): each strategy is `production` plus `key=value` overrides. `production` plans exactly the CLI's requests; the runner checks this for every corpus file. The keys:
  - `model`: `clef` or `clef-flash`.
  - `batch`: questions per request, packed within Clef's 64-question limit and the model's byte limit.
  - `guidance`: in each `question`, or once in the `state`.
  - `state`: `object` or `text`.
  - `ids`: `positional` or `slug`.
  - `question`: `noul`, `criteria`, or `choice`.
  - `pad`: `all` also asks policies that don't match the file, to stress large batches.

  Requests always carry every policy that matches the file, as production sends them. `--origin`, `--category`, and `ambiguous` labels only decide which answers are scored.
- **Metrics**: AUROC, Brier score, precision and recall at the 0.7 violation threshold, recall and false alarms above the 0.55 review floor, contrast-pair ordering, input tokens, and cost per 1,000 files. The first strategy is the baseline. Intervals are 95% paired bootstraps that resample files, because cases in one file share a request.
- **Cache**: replies are cached in `evals/.cache` by model and exact request body, since Clef is deterministic. Reruns and re-scoring are free; only new request shapes are sent. Per-case scores go to `evals/results/<split>[.<origins>][.<category>]/<strategy>.jsonl`.

Findings, 2026-10-20 (all splits):

| Cases | Strategy | AUROC | Recall@0.7 | Surfaced >0.55 | False alarms >0.55 | Contrast pairs ordered |
| --- | --- | --- | --- | --- | --- | --- |
| Real code, control rules | `production` | 0.980 | 59% | 72% | 4% | – |
| Real code, semantic rules | `production` | 0.756 | 1% | 6% | 0% | – |
| Real code, semantic rules | `production,batch=1` | 0.767 | 13% | 23% | 5% | – |
| Synthetic + planted, semantic rules | `production` | 0.895 | 22% | 36% | 0% | 100% |
| Synthetic + planted, semantic rules | `production,batch=1` | 0.927 | 44% | 56% | 3% | 100% |

- Production was tuned on mechanical rules, and it works for them: on real code, control rules separate cleanly (AUROC 0.98).
- On semantic rules, which are the intended use, production surfaces almost nothing: 6% of real violations clear the review floor. Clef notices them, ranking every contrast pair correctly and scoring a violation higher than clean code under each individual rule (per-rule AUROC is mostly 0.8–1.0), but the probabilities are low. Median real violations score 0.1–0.5, depending on the rule.
- Score scales differ by rule, so pooled AUROC (0.76) is lower than per-rule AUROC, and no single threshold fits every rule.
- Batching hurts semantic rules. With 15–17 semantic questions per request, scores for violations drop to roughly half of what the same question gets alone. Production's request shape was chosen on mechanical rules, where batching was free.
- The earlier mechanical-rule findings (batching, short guidance plus criteria) need re-checking on semantic rules before they guide production.
