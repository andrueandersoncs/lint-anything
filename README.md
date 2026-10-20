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
bun evals/run.ts --split all --origin real production production,model=clef-flash
```

- **Corpus** (`evals/corpus/`): 15 policies across TypeScript, Python, Go, SQL, shell, Dockerfiles, GitHub workflows, and Markdown. Every file is labeled `violates`, `complies`, or `not-applicable` against every policy whose globs match it. Each file has an `origin`:
  - `synthetic`: 68 files written for the corpus, with targeted near-misses and contrast pairs (293 cases, 120 violating).
  - `real`: 87 files copied verbatim from 38 permissively licensed GitHub projects with varied styles, among them VS Code, Hono, ky, Deno std, NestJS, Django, Flask, requests, Kubernetes, Prometheus, cobra, gin, the GitHub CLI, Supabase, docker-install, and nvm (374 cases, 84 violating). Each record pins its upstream repo, commit, path, and SPDX license. The license texts are in `evals/corpus/licenses/`.
  - `planted`: 20 twins of real files, each with one minimal edit that adds a violation real code rarely contains, such as a fake live token or a misplaced `ctx` (95 cases, 33 violating). Each twin is paired with its real file.

  Files are split dev/test (a file and its twin stay together). Every case was labeled by the slice's author and again by a blind second labeler, and they agreed on every violates/non-violates call.
- **Strategies** (`evals/strategy.ts`): each strategy is `production` plus `key=value` overrides. `production` plans exactly the CLI's requests; the runner checks this for every corpus file. The keys:
  - `model`: `clef` or `clef-flash`.
  - `batch`: questions per request, packed within Clef's 64-question limit and the model's byte limit.
  - `guidance`: in each `question`, or once in the `state`.
  - `state`: `object` or `text`.
  - `ids`: `positional` or `slug`.
  - `question`: `noul`, `criteria`, or `choice`.
  - `pad`: `all` also asks policies that don't match the file, to stress large batches.
- **Metrics**: AUROC, Brier score, precision and recall at the 0.7 violation threshold, recall and false alarms above the 0.55 review floor, contrast-pair ordering, input tokens, and cost. The first strategy is the baseline. Intervals are 95% paired bootstraps that resample files, because cases in one file share a request.
- **Cache**: replies are cached in `evals/.cache` by model and exact request body, since Clef is deterministic. Reruns and re-scoring are free; only new request shapes are sent. Per-case scores go to `evals/results/<split>[.<origins>]/<strategy>.jsonl`.

Findings on the synthetic corpus, 2026-10-19 (all 293 cases; test-split numbers agree within their wider intervals):

| Strategy | AUROC | Brier | Recall@0.7 | False alarms >0.55 | $ / 1k cases |
| --- | --- | --- | --- | --- | --- |
| Previous CLI request: one policy per request, long judging preamble (removed) | 0.933 | 0.109 | 84% | 16% | $0.53 |
| `production,batch=1` | 0.979 | 0.054 | 85% | 5% | $0.48 |
| `production` | 0.977 | 0.055 | 82% | 6% | $0.13 |
| `production,model=clef-flash` | 0.818 | 0.167 | 43% | 8% | $0.01 |

- Question wording drives quality: short guidance plus explicit yes/no `criteria` beat the previous long preamble on every metric. Besides switching to clef-flash, dropping the criteria (`question=noul`) is the only single change from production that measurably hurts (AUROC −0.020, Brier +0.023).
- Batching a file's policies into one request barely changes quality once the wording is fixed, and cuts cost about 3.5× because the file is sent once. Putting the guidance in the state and sending the file as text saves another ~8%.
- No other single change from production is distinguishable from noise, so production sits at a local optimum of this sweep.
- Larger batches shift scores slightly (padding to 15 questions raised Brier by 0.005–0.008), and capping the batch size does not recover it, so production packs each file's policies without a cap.
- clef-flash costs about 9× less than production but misses over half of the violations, and 26 cases (files over about 24 KB) cannot be sent to it at all.

Findings on real code, 2026-10-20 (all 374 real cases; production was chosen on synthetic data alone, so none of these cases influenced the choice):

| Strategy | AUROC | Brier | Precision@0.7 | Recall@0.7 | False alarms >0.55 | $ / 1k cases |
| --- | --- | --- | --- | --- | --- | --- |
| `production` | 0.981 | 0.054 | 94% | 61% | 2% | $0.18 |
| `production,batch=1` | 0.977 | 0.057 | 94% | 61% | 2% | $0.66 |
| `production,model=clef-flash` | 0.840 | 0.119 | 83% | 18% | 2% | $0.02 |

- The strategy ranking carries over to real code: no single change from production beats it, and dropping the criteria (`question=noul`) or switching to clef-flash still measurably hurts.
- Calibration does not carry over. Real violations score lower: recall at the 0.7 threshold falls from 82% to 61%, while precision stays at 94%. Since AUROC is still 0.98, a lower threshold recovers most of it. At 0.3, real-code recall is 85% at 86% precision; synthetic recall is 98% at 89% precision.
- Real-code misses at the 0.7 threshold cluster in four policies: `go/handle-errors` (12 of 15 missed), `hygiene/no-commented-out-code` (9 of 11), `typescript/no-floating-promises` (2 of 2), and `go/context-first` (2 of 2). Most are one-line violations in otherwise clean files, such as an error assigned to `_` or a commented-out `print` call.
- Real code contained no hardcoded secrets, so that policy's positives come only from planted twins. Production ranked every planted twin above its real original.
