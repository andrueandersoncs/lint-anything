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
| `--threshold` | `0.45` | Violation probability (0–1) that fails the run, for policies judged per file |
| `--item-threshold` | `0.65` | Violation probability (0–1) that fails the run, for items a selector emits |
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

- Frontmatter must list at least one glob, a `select` command, or both. A policy checks a file only when one of its globs matches the file's path as found by the CLI globs (for example `src/a.ts`).
- The body after the frontmatter must not be empty.
- The policy name is its path relative to the rules directory, without `.md` (for example `sub/no-debugger`).
- The whole policy file, frontmatter included, is sent to Clef verbatim.

A missing rules directory, one with no `.md` files, or an invalid policy stops the run.

### Selectors

By default a policy is judged against each whole file. A `select` command instead picks out the discrete items to judge: functions, comments, TODOs, commit messages, or anything else a shell pipeline can produce.

````md
---
globs: ["src/**/*.ts"]
select: |
  rg --json -w 'TODO|FIXME' "$@" |
    jq -c 'select(.type == "match") | {id: "\(.data.path.text):\(.data.line_number)", path: .data.path.text,
           lines: [.data.line_number, .data.line_number], text: (.data.lines.text | rtrimstr("\n"))}'
---
# TODOs reference an issue

Every `TODO` or `FIXME` comment must reference a tracking issue, written as `#123`, `ABC-123`, or a full issue URL.
````

- The command runs with `sh -c` from the current directory. With globs, it runs once with every matching file as its arguments (`"$@"`), and not at all when none match. Without globs it always runs once, with no arguments, so it can select things that aren't files (`git log`, an API, a database).
- It must print JSONL, one item per line:

  | Field | Required | Meaning |
  | --- | --- | --- |
  | `id` | yes | Names the item in findings |
  | `text` | yes | What Clef judges against the rule |
  | `path` | no | The item's file |
  | `lines` | no | `[start, end]`, 1-based and inclusive |
  | any other field | no | Evidence: a string Clef reads alongside the item, under the field's name (for example `enclosing`). Fields are shown in the order the selector wrote them; empty ones are skipped |

- A non-zero exit or a line that isn't a valid item stops the run (exit 2). `rg` and `grep` exit 1 when nothing matches, so end a bare search with `|| true`, or pipe it on as above.
- Each item is judged on its own, with only its evidence and location. Pick items that carry what the rule needs: a rule about whole files is better judged per file.

#### Evidence steps

A selector can pipe its items through further steps that add evidence. Selectors run with `$LINT_ANYTHING` set to the command that runs this CLI, whose built-in steps read items as JSONL on stdin and write them back with a field added:

| Step | Adds |
| --- | --- |
| `$LINT_ANYTHING enclosing` | `enclosing`: the block around each item with `path` and `lines` — the nearest less-indented line above that opens a function, method, class, or block, down to where it closes, numbered and capped at 80 lines. With no such block, the 15 lines after the item. |

```yaml
select: |
  rg --json -P '(?<![\w.])(?:[2-9]|\d{2,})(?![\w.])' "$@" | jq -c '…' |
    $LINT_ANYTHING enclosing
```

Any program that reads and writes JSONL items works as a step. Evidence costs input tokens: the enclosing block made items 2.5–3.3× as expensive in the evals, and paid for it (see Evals).

## How it works

Each file is paired with every policy without a selector whose globs match its path, and all of a file's policies are judged together, with up to 8 files in flight. Files over 4,000 bytes are judged as excerpts of at most 4,000 bytes, cut before top-level declarations where possible; each excerpt's path names its lines. One Clef request carries short judging guidance, the excerpt's path and text, plus one yes/no question per policy: does the file violate it? Clef answers each question with a probability, and a policy's score is its highest across the file's excerpts. A policy that doesn't apply to a file scores low and passes. Files with no matching policy send nothing.

Selector policies run after the files, one at a time. Each request carries short guidance and the rule once, plus one yes/no question per item showing its location, context, and text: does the item violate the rule? Each item gets its own finding.

A request holds at most 64 questions (Clef's limit) and 64,000 bytes (24,000 with `clef-flash`, whose context window is smaller). Policies or items that don't fit in one request are split across several. This request shape and the cut-offs below were chosen with the eval suite. Items score higher than whole files, so they have their own cut-offs.

| Result | File verdict | Item verdict |
| --- | --- | --- |
| `violates ≤ 0.3` (files) or `≤ 0.5` (items) | `pass` | `pass` |
| `violates ≥ --threshold` (files) or `--item-threshold` (items) | `violation` | `violation` |
| otherwise | `review`: uncertain, including cases where careful reviewers would disagree | `review` |
| request with only that policy or item over the byte limit | `inconclusive` (not sent; Clef would truncate it) | `inconclusive` |

Transient HTTP failures are retried up to 3 times with exponential backoff.

## Output

Text output prints one line per non-passing finding — verdict, violation probability, location, policy, and reason — then a count per verdict. The location is the file's path; for an item, its `path:start-end`, or its `id` when it has no path and lines:

```
violation     0.93   src/a.ts  no-debugger
violation     0.97   src/a.ts:4-4  todo
violation     0.97   9acebc18  commits
3 checks: 3 violation, 0 review, 0 inconclusive, 0 pass
```

`--json` prints `{ "findings": [...] }` with every finding, passes included. Each finding has `policy`, `verdict`, and either `violates` or `reason`. A file finding has `path`; an item finding has `item` (its id) and the item's `path` and `lines` when it gave them.

Only `violation` fails the run; `review` and `inconclusive` are reported but exit `0`.

| Exit code | Meaning |
| --- | --- |
| `0` | No violations |
| `1` | At least one violation, or an input file could not be read |
| `2` | Policy, selector, configuration, or Clef API error |

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
bun evals/items.ts                         # selector item request shapes on the dev split
bun evals/items.ts --split test production
bun evals/compare.ts --split test evals/corpus/selectors evals/corpus/selectors-evidence   # selector sets, policy by policy
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
- **Selector items** (`evals/items.ts`): `evals/corpus/selectors/` gives six corpus policies a `select` command built from `rg` and `jq`: TODO lines, lines with `any`, Python `except` handlers, comment runs with the line after, test declarations with their bodies, and lines with numeric literals. Globs and rule text must equal the corpus policy's, so the corpus labels still apply. Each item is labeled `violates` when its lines overlap the file's gold violation lines and clean otherwise. Files labeled `ambiguous` for the policy are left out. The runner reports item AUROC, AUROC among items of violating files (whether a violating item lifts its neighbours), Brier, caught and false-alarm rates at the CLI's item cut-offs (`--thresholds` overrides them), and, per file, the highest item score against the CLI's whole-file judgment of the same cases. Shapes: `production` (the CLI's planner), `single` (one request per item), and `list` (rule and items in the state, one short question per item). `--selectors <dir>` scores another set of selector policies against the same labels, such as selectors that add context. Per-item scores go to `evals/results/items.<split>[.<dir>]/<shape>.jsonl`.

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

Selector findings, 2026-10-20 (shape and cut-offs chosen on dev; test: 567 items, 61 violating, in 149 file cases; selectors cover 62 of 71 gold violation ranges):

| Test split | Item AUROC | Brier | Violating items given `violation` / clean items not passed (0.5 / 0.65) | Same file cases: highest item vs. whole file | $ / 1k items |
| --- | --- | --- | --- | --- | --- |
| `production`: rule in the state, one question per item | 0.967 | 0.078 | 59% / 7% | 0.966 vs 0.920 [+0.022, +0.073] | $0.050 |
| `single`: one request per item | 0.953 [−0.036, +0.014] | 0.106 [+0.009, +0.052] | 74% / 10% | 0.955 vs 0.920 [+0.009, +0.062] | $0.124 |
| `list`: rule and items in the state | 0.959 [−0.025, +0.005] | 0.078 [−0.007, +0.007] | 59% / 5% | 0.975 vs 0.920 [+0.029, +0.084] | $0.053 |

- Packing items as questions loses nothing to one request per item, and is better calibrated: Brier is worse for `single` outside noise. It costs 2.5× less. `list` ties `production` on test and was worse on Brier on dev.
- A matched selector beats judging the whole file for the same rules. Taking a policy's highest item score as its file score lifts AUROC from 0.920 to 0.966 on test (0.923 to 0.974 on dev), outside noise, and each finding points at its lines.
- Items score higher than whole files: at the file cut-offs (0.3 / 0.45), 28% of clean items would be flagged. On dev, 0.5 / 0.65 catches 71% of violating items as `violation` with 2% of clean items flagged, and surfaces 88% with 7% flagged; on test, 59% at 2% and 87% at 7%.
- Mechanical rules are solved (item AUROC 1.0 for TODOs, `any`, and swallowed exceptions). Semantic items: comments 0.944, magic values 0.972, test names 0.767 on 11 items.

### Evidence findings

Each feature that adds evidence or changes how items are judged has an intended purpose, an eval that measures it, and a result. Choices are made on dev and confirmed on test; intervals are 95% paired bootstraps resampling files.

`evals/compare.ts` scores selector sets against the same item labels with the CLI's request shape and prints, per policy, AUROC and Brier with intervals against the first set, caught / surfaced / false-alarm rates at the item cut-offs, and cost per 1,000 items. Its scores go to `evals/results/items.<split>.<set>/production.jsonl`.

#### Evidence fields and `$LINT_ANYTHING enclosing`

Purpose: Clef judges an item better when it sees the code around it. Measured on the two semantic selector policies whose items are short (comments, magic-value lines) by `evals/corpus/selectors-evidence/`, which pipes the same items through `$LINT_ANYTHING enclosing`.

| Policy, split | Items (violating) | AUROC | Brier | Caught / surfaced / false alarms | $ / 1k items |
| --- | --- | --- | --- | --- | --- |
| comments, dev | 584 (36) | 0.865 → 0.900 [−0.013, +0.086] | 0.102 → 0.086 [−0.030, +0.001] | 33 / 72 / 8.2% → 33 / 75 / 7.7% | $0.043 → $0.148 |
| comments, test | 290 (15) | 0.944 → 0.951 [−0.035, +0.042] | 0.083 → **0.070** [−0.021, −0.005] | 20 / 67 / 5.5% → 47 / 73 / 5.1% | $0.045 → $0.115 |
| magic values, dev | 374 (6) | 0.974 → 0.986 [−0.003, +0.041] | 0.071 → **0.040** [−0.043, −0.020] | 83 / 83 / 5.7% → 67 / 83 / 3.5% | $0.044 → $0.128 |
| magic values, test | 225 (16) | 0.972 → **0.993** [+0.002, +0.051] | 0.077 → **0.044** [−0.051, −0.019] | 44 / 100 / 8.6% → 81 / 88 / 2.4% | $0.044 → $0.107 |

- The purpose holds: calibration improves on both rules on test (and on dev for magic values; comments is borderline on dev), magic values also ranks better on test, and clean items flagged fall from 8.6% to 2.4%. More violating comments reach `violation` (20% → 47% on test).
- It costs 2.4–3.4× more per item, because the block is repeated in each item's question.
- Relevance matters, not volume: in a prototype, the 10 lines after each comment instead of its enclosing block lowered comment AUROC on test (interval −0.053 to −0.002).
