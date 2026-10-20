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
| `--cache` | `.lint-anything/cache` | Directory that caches Clef's answers across runs (add it to `.gitignore`) |
| `--no-cache` | off | Neither read nor write the cache |

`lint-anything check` takes the same flags, without file globs (see Examples and `check`).

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

#### Evidence

Evidence is what Clef reads next to the thing it judges. There are two kinds.

**Item evidence.** A selector can pipe its items through steps that add fields. Selectors run with `$LINT_ANYTHING` set to the command that runs this CLI, whose built-in steps read items as JSONL on stdin and write them back with a field added:

| Step | Adds |
| --- | --- |
| `$LINT_ANYTHING enclosing` | `enclosing`: the block around each item with `path` and `lines` — the nearest less-indented line above that opens a function, method, class, or block, down to where it closes, numbered and capped at 80 lines. With no such block, the 15 lines after the item. |
| `$LINT_ANYTHING blame [--today YYYY-MM-DD]` | `changed`: when the item's lines last changed in git and how long ago, e.g. `2026-07-22, 90 days before 2026-10-20`. Items git has no committed history for get no field. |

Any program that reads and writes JSONL items works as a step.

**Shared evidence.** `evidence` steps in the frontmatter are shell commands that run before the selector (or, for a policy without one, before its files are judged), in order, with the same arguments. Each step's output is available to every later step and to `select` as the file `$EVIDENCE_<name>`, and the rule text can include it as `{{name}}`:

````md
---
globs: ["src/**/*.{ts,py,go}"]
evidence:
  today: date +%F
select: |
  rg --json -w 'TODO|FIXME' "$@" | jq -c '…' |
    $LINT_ANYTHING blame
---
# Old TODOs reference an issue

A `TODO` or `FIXME` comment added more than 90 days ago must reference a tracking issue. Today is {{today}}.
````

- Step names match `[A-Za-z_][A-Za-z0-9_]*`. A `{{name}}` no step defines, or a step that exits non-zero, stops the run (exit 2).
- A later step can refine an earlier one's output. `evals/corpus/selectors-evidence-constants/` has a `constants` step listing every file's named constants, and a final selector step that attaches to each item only its own file's (`jq --rawfile c "$EVIDENCE_constants" '…'`).
- What helps, from the evals: evidence placed on each item beats the same evidence placed once in the rule, and a computed fact beats raw data Clef has to reason over (an age in days, not a commit date). Evidence costs input tokens: the enclosing block made items 2.4–3.4× as expensive.
- Policies can share steps. A selector or evidence step whose command, arguments, directory, and earlier evidence (by content) match one already run in this lint run reuses its output instead of running again. Put a selector several policies use in a script (for example `.lint-anything/lib/functions.sh`) and call it from each.

### Examples and `check`

A policy can carry labeled examples: items (for a selector policy) or files (for a policy judged per file) with `violates: true` or `false`. Each example takes the item fields (`text`, and optionally `id`, `path`, `lines`, and evidence fields such as `enclosing`, which a selector would otherwise have added).

````md
---
globs: ["src/**/*.ts"]
select: |
  rg --json -w 'TODO|FIXME' "$@" | jq -c '…'
examples:
  - violates: true
    text: "// TODO: make this faster"
  - violates: false
    text: "// TODO(#412): drop once the v1 API is gone"
---
# TODOs reference an issue

Every `TODO` or `FIXME` comment must reference a tracking issue.
````

- Examples are part of the policy file, so Clef reads them with the rule on every request: they work as few-shot examples (a small gain in the evals).
- `lint-anything check [--rules-dir …]` judges each policy's examples against the rule with the examples removed, so the wording alone has to get them right, using the same request shape and cut-offs as linting. Each example `agree`s (a violating example is a `violation`, a clean one passes), is `unsure` (`review`), or `disagree`s; any disagreement exits `1`.

```
agree      0.99   no-debugger  example 1 (violates): violation
disagree   0.02   no-debugger  example 2 (violates): pass
2 examples: 1 agree, 0 unsure, 1 disagree
```

- `check` catches a rule that's about the wrong thing, but not every bad wording: in the evals, Clef judged by a rule's topic and ignored an added "this rule is inverted" (see Evals).

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

Answers are cached on disk per question, keyed by the model, the request's text (guidance and excerpt, or guidance and rule), and the question (rule, or rendered item). Only questions whose inputs changed are sent: re-running on unchanged files sends nothing, and editing a policy re-asks only that policy. Clef's answer to one question shifts a little with the other questions in its request (see Evals), so a cached answer can differ from what a fresh run would say, by as much as any other packing would, at no measured cost in quality.

## Output

Text output prints one line per non-passing finding — verdict, violation probability, location, policy, and reason — then a count per verdict. The location is the file's path; for an item, its `path:start-end`, or its `id` when it has no path and lines:

```
violation     0.93   src/a.ts  no-debugger
violation     0.97   src/a.ts:4-4  todo
violation     0.97   9acebc18  commits
3 checks: 3 violation, 0 review, 0 inconclusive, 0 pass (2 requests, 0 cached answers)
```

`--json` prints `{ "findings": [...], "requests": …, "cached": … }` with every finding, passes included. Each finding has `policy`, `verdict`, and either `violates` or `reason`. A file finding has `path`; an item finding has `item` (its id) and the item's `path` and `lines` when it gave them.

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
bun evals/history.ts                       # evidence from outside the file: a dated git fixture
bun evals/shared.ts                        # shared steps run once (stub Clef, no requests)
bun evals/examples.ts                      # policy examples: few-shot, and whether check catches bad wording
bun evals/cutoffs.ts items                 # per-policy cut-offs tuned on dev vs. global (stored scores)
bun evals/cache.ts                         # the answer cache: requests on re-runs and edits (real requests)
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

#### Shared evidence steps, `{{name}}`, and `$LINT_ANYTHING blame`

Purpose 1: evidence from outside the file makes rules about time or history judgeable. `evals/history.ts` builds a git repository (deterministic, rebuilt each run) whose 126 TODOs in 18 TypeScript, Python, and Go files were committed on known dates, 35 of them within five days of the threshold, and judges "TODOs added more than 90 days ago must reference an issue" (47 violating) with four policies that differ only in evidence:

| Evidence | AUROC | Brier | Accuracy at 0.65 | Near threshold (±5 days) | Issue-less TODOs ≤ 90 days old flagged | Caught / false alarms | $ / 1k items |
| --- | --- | --- | --- | --- | --- | --- | --- |
| none | 0.802 | 0.154 | 63% | 60% | 96% | 36% / 30% | $0.036 |
| `today: echo …` step, `Today is {{today}}.` in the rule | 0.869 [+0.021, +0.113] | 0.138 [−0.025, −0.007] | 77% [+6, +22 pts] | 77% | 83% | 66% / 28% | $0.037 |
| … plus each TODO's commit date (`blame`, age removed) | 0.891 [+0.032, +0.156] | 0.139 [−0.041, +0.014] | 83% [+9, +31 pts] | 63% | 92% | 94% / 29% | $0.041 |
| … plus `blame`'s computed age | **0.991** [+0.111, +0.269] | **0.029** [−0.160, −0.088] | **96%** [+22, +44 pts] | **91%** | **0%** | 89% / 1% | $0.045 |

- The purpose holds once the evidence states the fact the rule turns on. With the age in days on each item, accuracy rises from 63% to 96% and false alarms from issue-less young TODOs vanish.
- Clef doesn't do the date arithmetic: given today's date and each commit date, it still flags 92% of young issue-less TODOs. Compute facts in steps; don't ask Clef to derive them.
- Today's date alone, through `{{today}}`, helps a little (accuracy +6 to +22 points), presumably by making Clef less sure undated TODOs are old.

Purpose 2: later steps can refine earlier evidence. `evals/corpus/selectors-evidence-constants/` adds a `constants` step (every named constant in the files) that a final selector step narrows to each item's own file, on top of the enclosing block, for magic values:

| Split | Items (violating) | AUROC | Brier | Caught / surfaced / false alarms |
| --- | --- | --- | --- | --- |
| dev | 374 (6) | 0.986 → 0.980 [−0.024, +0.009] | 0.040 → 0.043 [−0.008, +0.017] | 67 / 83 / 3.5% → 67 / 83 / 3.0% |
| test | 225 (16) | 0.993 → 0.995 [−0.006, +0.007] | 0.044 → **0.033** [−0.023, −0.001] | 81 / 88 / 2.4% → 75 / 88 / 1.4% |

- The chaining works, but its value is unconfirmed: calibration improves on test and not on dev, which has only 6 violating items. Cost rises about 10%.
- In a prototype, the same constants placed once in the rule text (the state) instead of on each item did not help (test Brier interval −0.026 to +0.004), while on each item they did (−0.040 to −0.009). Item evidence is the stronger placement; `{{name}}` suits facts that really are global, like today's date.

#### Shared steps

Purpose: policies that share a selector or evidence step don't repeat the work. `evals/shared.ts` lints `src/**/*.ts` with six policies that share one evidence step and one selector (with `$LINT_ANYTHING enclosing`), against a stub Clef that sends no requests, and counts executions through a log each shared command appends to.

| Code | Evidence step runs | Selector runs | Findings | Time (3 runs) |
| --- | --- | --- | --- | --- |
| before sharing | 6 | 6 | 936 | 757–776 ms |
| with sharing | **1** | **1** | 936, same digest | 142–149 ms |

The purpose holds: each shared command runs once, findings are byte-identical (the eval prints a digest of the findings to compare; it depends on the current `src/`), and step time falls about 5×.

#### Policy examples and `check`

`evals/examples.ts` measures both purposes on the six corpus selector policies.

Purpose 1: examples in a policy improve its judgments (few-shot). Each policy gets two violating items and the two clean items the baseline scored highest, taken from the other split, as `examples`:

| Split | Items (violating) | AUROC | Brier | Caught / surfaced / false alarms | $ / 1k items |
| --- | --- | --- | --- | --- | --- |
| dev | 1,076 (97) | 0.951 → 0.953 [−0.005, +0.011] | 0.084 → 0.083 [−0.006, +0.005] | 71 / 88 / 7.2% → 74 / 89 / 8.0% | $0.047 → $0.052 |
| test | 567 (61) | 0.967 → **0.976** [+0.001, +0.020] | 0.078 → **0.069** [−0.016, −0.004] | 59 / 87 / 6.7% → 62 / 85 / 5.5% | $0.050 → $0.056 |

A small gain, confirmed on test and not on dev; magic values improves most on test (Brier 0.077 → 0.055, interval −0.035 to −0.012; false alarms 8.6% → 2.9%). Cost rises about 11%.

Purpose 2: `check` catches a badly worded rule. Each policy is checked on three violating and three clean dev items (a fixed pseudo-random pick, standing in for clear examples an author writes) in its own wording and three corrupted ones:

| Wording | Policies whose `check` fails | Examples that agree |
| --- | --- | --- |
| original | 2 / 6 | 28 / 31 (90%) |
| another policy's rule | **5 / 6** | 15 / 31 (48%) |
| title only | 3 / 6 | 24 / 31 (77%) |
| "The rule below is inverted: …" + original | 2 / 6 | 27 / 31 (87%) |

- The purpose holds only partly. `check` catches a rule about the wrong thing (agreement falls from 90% to 48%), barely notices a rule cut to its title, and doesn't notice an inverted one: Clef judges by the rule's topic and ignores the added inversion.
- Its pass/fail gate is strict: the comments and magic-values policies fail in their original wording, because Clef misjudges one or two of their examples. Read the agreement, not just the exit code, for semantic rules.

#### Per-policy cut-offs (not shipped)

Purpose: cut-offs fitted to each policy beat the global ones. `evals/cutoffs.ts` tunes each policy's cut-offs on its dev scores (far more labeled cases than a policy's examples would give) and applies them to test:

| Test split | Verdict F1, global → per policy | Violations → `violation` | Violations surfaced | Clean not passed | Ambiguous → `review` |
| --- | --- | --- | --- | --- | --- |
| items | 0.539 → 0.551 | 59.0% → 65.6% | 86.9% → 67.2% | 6.7% → 3.4% | – |
| files | 0.559 → 0.510 | 43.2% → 71.6% | 62.2% → 78.4% | 8.3% → 11.6% | 32.4% → 2.9% |

The purpose fails: per-policy cut-offs overfit dev. Items lose a fifth of surfaced violations for a 0.012 F1 gain; files lose the `review` band almost entirely. Policies keep the global cut-offs.

#### Answer cache

Purpose: re-runs pay only for what changed, with the same results. `evals/cache.ts` lints 24 dev corpus files with four whole-file and two selector policies through the CLI's Clef path, with a fresh cache directory, then appends a function (narrating comment, issue-less TODO, magic number) to the three files first in path order:

| Run | Requests | Cached answers | Time | Findings vs. a fresh run |
| --- | --- | --- | --- | --- |
| 1. cold cache | 81 | 0 | 7.3 s | – |
| 2. re-run, nothing changed | **0** | 629 | 0.0 s | identical (401 checks, every score equal) |
| 3. after the edit, with the cache | **16** | 565 | 4.9 s | identical to run 4 |
| 4. after the edit, no cache | 81 | 0 | 7.6 s | – |

Whether that equality holds in general depends on Clef answering each question independently of the others in its request. It doesn't: the same 1,076 dev items judged in the CLI's full batches and in two half-size batches (odd and even items) gave identical answers for only 2.8% of items (mean change 0.068, largest 0.718, 81 verdicts different). In a probe on one 40-item request, reversing the question order changed answers by 0.107 on average, and swapping a single unrelated question changed every other answer slightly (up to 0.013). Packing is a source of variation in its own right, and it costs nothing in quality: AUROC 0.951 → 0.944 [−0.021, +0.006], Brier 0.084 → 0.083 [−0.007, +0.006].

- The purpose holds: an unchanged run sends nothing and an edit sends only its questions (16 of 81 requests here).
- Whole-file answers are exact: an unchanged excerpt is always asked the same questions together. Item answers taken from the cache may differ from a fresh run's packing as much as two packings differ from each other, without losing accuracy.
