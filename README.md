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
| `--threshold` | `0.45` | Violation probability (0–1) that fails the run |
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

Each file is paired with every policy whose globs match its path, and all of a file's policies are judged together, with up to 8 files in flight. Files over 4,000 bytes are judged as excerpts of at most 4,000 bytes, cut before top-level declarations where possible; each excerpt's path names its lines. One Clef request carries short judging guidance, the excerpt's path and text, plus one yes/no question per policy: does the file violate it? Clef answers each question with a probability, and a policy's score is its highest across the file's excerpts. A policy that doesn't apply to a file scores low and passes. Files with no matching policy send nothing.

A request holds at most 64 questions (Clef's limit) and 64,000 bytes (24,000 with `clef-flash`, whose context window is smaller). Policies that don't fit in one request are split across several, sent one after another. This request shape and the cut-offs below were chosen with the eval suite.

| Result | Verdict |
| --- | --- |
| `violates ≤ 0.3` | `pass` |
| `violates ≥ --threshold` | `violation` |
| otherwise | `review`: uncertain, including cases where careful reviewers would disagree |
| excerpt plus that policy alone over the byte limit | `inconclusive` (not sent; Clef would truncate it) |

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
bun evals/run.ts --split test --category semantic production production,chunk=0
```

- **Policies** (`evals/corpus/policies/`) come in two categories, picked with `--category`:
  - `semantic/`: 17 rules of the kind lint-anything is for, which static analysis can't practically enforce. They cover naming (intent-revealing names, names that match behavior), readability (one level of abstraction per function, named magic values, comments that explain why), design (no flag parameters, single responsibility, explicit dependencies, preserving error context), architecture (decisions separate from I/O, thin entry points), encapsulation (no leaked mutable state, minimal public surface), organization (cohesive modules), maintainability (no duplicated knowledge), and testing (behavior over implementation, descriptive test names). Most apply to every `.ts`/`.js`/`.py`/`.go` file; the two testing rules apply to test files. Their wording varies the way users' rules do: some are one-liners, some list exceptions, some are in a team's voice.
  - `control/`: four mechanical rules that existing linters already handle (TODOs need an issue, no `any`, Go errors handled, no swallowed Python exceptions), kept for comparison.
- **Corpus** (`evals/corpus/`): every file is labeled `violates`, `complies`, `not-applicable`, or `ambiguous` against every policy whose globs match it. Each file has an `origin`:
  - `real`: 70 files copied verbatim from 31 permissively licensed GitHub projects with varied styles, among them VS Code, Hono, ky, Deno std, NestJS, tRPC, Django, Flask, requests, scikit-learn, Home Assistant, Kubernetes, Prometheus, cobra, gin, the GitHub CLI, caddy, and etcd (1,042 cases: 165 violating, 59 ambiguous). Each record pins its upstream repo, commit, path, and SPDX license. The license texts are in `evals/corpus/licenses/`.
  - `synthetic`: 15 contrast pairs written for the corpus. Each pair is a realistic file that violates one target semantic rule, and a twin with only that violation fixed (522 cases).
  - `planted`: 12 twins of real files, each with one minimal edit that introduces a violation of a target semantic rule (204 cases). Each twin is paired with its original.

  Labels model reality, ambiguity included. Every case has three independent labels. Of 1,768 cases, 1,661 were unanimous on violates vs. not. Adjudicators reviewed the 107 split cases and 164 unanimous ones both new labelers flagged as contested. A split became a clear label when the dissent rested on an error (misread code, an ignored exception), and `ambiguous` when the rule's wording genuinely supports both conclusions. Twin files whose identical content was adjudicated differently are `ambiguous` too. That leaves 76 ambiguous semantic cases (5%) and none among the mechanical control rules. Files are split dev/test, and pairs stay together.
- **Strategies** (`evals/strategy.ts`): each strategy is `production` plus `key=value` overrides. `production` cuts the same excerpts and plans exactly the same requests as the CLI; the runner checks this for every corpus file. The keys:
  - `model`: `clef` or `clef-flash`.
  - `batch`: questions per request, packed within Clef's 64-question limit and the model's byte limit.
  - `chunk`: excerpt size in bytes, or `0` for the whole file.
  - `guidance`: in each `question`, or once in the `state`.
  - `wording`: `short`, `reviewer` (would a reviewer holding the rule flag something?), or `calibrated` (answer near 0.5 when the rule supports both readings).
  - `state`: `object` or `text`.
  - `ids`: `positional` or `slug`.
  - `question`: `noul`, `criteria`, `choice`, `verdict` (violates/borderline/complies), or `scale` (a three-level score).
  - `contest`: `ask` adds a second question per rule, "could careful reviewers reasonably disagree?", and pulls contested answers toward 0.5.
  - `pad`: `all` also asks policies that don't match the file, to stress large batches.

  Requests always carry every policy that matches the file, as production sends them. `--origin` and `--category` only decide which answers are scored.
- **Metrics**: the ideal score is 1 for a clear violation, 0.5 for an ambiguous case, and 0 otherwise.
  - AUROC on clear cases;
  - ordinal concordance (whether ambiguous cases fall between clean and violating ones);
  - Brier score against the 0 / 0.5 / 1 target;
  - three-way verdict macro-F1 (`pass`↔clean, `review`↔ambiguous, `violation`↔violates);
  - how many violations are caught or surfaced, how many ambiguous cases land in `review`, and false alarms;
  - contrast-pair ordering;
  - cost per 1,000 files.

  Verdicts use `--thresholds floor,threshold`, which defaults to production's. The table also shows the cut-offs that would maximize F1 on the scored cases; pick them on dev and pass them to test. The first strategy is the baseline, and intervals are 95% paired bootstraps that resample files, because cases in one file share requests.
- **Cache**: replies are cached in `evals/.cache` by model and exact request body, since Clef is deterministic. Reruns and re-scoring are free; only new request shapes are sent. Per-case scores go to `evals/results/<split>[.<origins>][.<category>]/<strategy>.jsonl`.

Findings, 2026-10-20. Strategies and cut-offs were chosen on dev; these are held-out test numbers:

| Test split | Semantic AUROC | Semantic concordance | Semantic verdict F1 | Ambiguous → `review` | False alarms | Control AUROC | $ / 1k files |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Previous production: whole file, cut-offs 0.55 / 0.7 | 0.804 | 0.778 | 0.375 | 6% | 0% | 0.981 | $1.44 |
| Previous request shape, cut-offs re-tuned on dev | 0.804 | 0.778 | 0.500 | 24% | 10% | 0.981 | $1.44 |
| `production`: 4,000-byte excerpts, cut-offs 0.3 / 0.45 | 0.835 | 0.819 | 0.517 | 32% | 9% | 0.980 | $3.06 |

- Clef can separate semantic violations from clean code, but long files dilute them. AUROC falls from 0.90 for files under 4 KB to 0.74 above 9 KB. Judging excerpts restores much of it: on dev, clear-case AUROC rose from 0.822 to 0.871 and concordance from 0.798 to 0.843, both outside noise. On test, concordance improved by +0.041 (interval +0.006 to +0.076); the AUROC gain (+0.031) is within noise on test's smaller sample. Control rules are unchanged.
- The old cut-offs were the biggest problem. Semantic violations mostly score 0.2–0.5, so 0.55 / 0.7 passed nearly all of them. Re-tuned cut-offs lift semantic verdict F1 from 0.375 to about 0.5 on their own.
- Clef sees ambiguity only partly. It ranks ambiguous cases above clean ones (0.80) but barely below clear violations (about 0.6). Asking directly whether reviewers would disagree (`contest=ask`), a three-way `verdict` question, or `calibrated` wording didn't change that. With excerpts, `review` catches about a third of the ambiguous cases.
- Nothing else helped measurably. Neither wording, question type, question ids, nor smaller batches beat production. Per-rule batches cost more without gaining once excerpts are used. clef-flash still misses most violations.
- The earlier synthetic-corpus finding that batching was free held only for mechanical rules. On semantic rules it lowers scores, and excerpts recover that loss more cheaply than one question per request.
