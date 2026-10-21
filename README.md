# lint-anything

Lint any text file against plain-English policies, judged by Cloudflare's [Clef](https://developers.cloudflare.com/workers-ai/models/clef/) decision model on Workers AI.

## Run

```sh
bun install
echo 'CLOUDFLARE_ACCOUNT_ID=...' >> .env
echo 'CLOUDFLARE_AUTH_TOKEN=...' >> .env
bun index.ts 'src/**/*.ts'
```

Pass one or more globs; the CLI takes nothing else. They are expanded relative to the current directory, deduplicated, and read whole. Scope them (for example `src/**/*.ts`, not `**/*`) to avoid `node_modules`. Policies are read from `.lint-anything/rules`, judged by the `clef` model, and printed as text. Clef's answers are cached in `.lint-anything/cache` (add it to `.gitignore`).

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

**Item evidence.** A selector can pipe its items through further programs that add fields. Any program that reads JSONL items on stdin and writes them back with a field added works as a step; `evals/steps/` has two, used by the evals: `enclosing.ts` (the block around each item) and `blame.ts` (when the item's lines last changed in git, and how many days ago).

**Shared evidence.** `evidence` steps in the frontmatter are shell commands that run before the selector (or, for a policy without one, before its files are judged), in order, with the same arguments. Each step's output is available to every later step and to `select` as the file `$EVIDENCE_<name>`, and the rule text can include it as `{{name}}`:

````md
---
globs: ["src/**/*.{ts,py,go}"]
evidence:
  today: date +%F
select: |
  rg --json -w 'TODO|FIXME' "$@" | jq -c '…' |
    ./scripts/add-commit-age.sh
---
# Old TODOs reference an issue

A `TODO` or `FIXME` comment added more than 90 days ago must reference a tracking issue. Today is {{today}}.
````

- Step names match `[A-Za-z_][A-Za-z0-9_]*`. A `{{name}}` no step defines, or a step that exits non-zero, stops the run (exit 2).
- A later step can refine an earlier one's output. `evals/corpus/selectors-evidence-constants/` has a `constants` step listing every file's named constants, and a final selector step that attaches to each item only its own file's (`jq --rawfile c "$EVIDENCE_constants" '…'`).
- What helps, from the evals: evidence placed on each item beats the same evidence placed once in the rule, and a computed fact beats raw data Clef has to reason over (an age in days, not a commit date). Evidence costs input tokens: the enclosing block made items 2.4–3.4× as expensive.
- Policies can share steps. A selector or evidence step whose command, arguments, directory, and earlier evidence (by content) match one already run in this lint run reuses its output instead of running again. Put a selector several policies use in a script (for example `.lint-anything/lib/functions.sh`) and call it from each.

### Counting items: `limit`

A selector policy can count instead of reporting each item: with `limit`, its items are judged against the rule as usual, and then the policy reports one finding per file (or, with `per: run`, one for the whole run) that is a `violation` when more than `max` items are violations.

````md
---
globs: ["src/**/*.ts"]
select: |
  rg --json -w 'TODO|FIXME' "$@" | jq -c '…'
limit: { max: 3, per: file }
---
# TODOs reference an issue

Every `TODO` or `FIXME` comment must reference a tracking issue.
````

```
violation     -      src/many.ts  todos  4 of 4 items violate the rule (at most 3 allowed)
```

Write the rule about one item, and put the count in `limit`: Clef judges items well and counts badly (see Evals). Items in `review` are mentioned in the reason but not counted. `limit` needs `select`.

### Examples

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

Examples are part of the policy file, so Clef reads them with the rule on every request: they work as few-shot examples (a small gain in the evals).

## How it works

Each file is paired with every policy without a selector whose globs match its path, and all of a file's policies are judged together, with up to 8 files in flight. Files over 4,000 bytes are judged as excerpts of at most 4,000 bytes, cut before top-level declarations where possible; each excerpt's path names its lines. One Clef request carries short judging guidance, the excerpt's path and text, plus one yes/no question per policy: does the file violate it? Clef answers each question with a probability, and a policy's score is its highest across the file's excerpts. A policy that doesn't apply to a file scores low and passes. Files with no matching policy send nothing.

Selector policies run after the files, one at a time. Each request carries short guidance and the rule once, plus one yes/no question per item showing its location, context, and text: does the item violate the rule? Each item gets its own finding.

A request holds at most 64 questions (Clef's limit) and 64,000 bytes. Policies or items that don't fit in one request are split across several. This request shape and the cut-offs below were chosen with the eval suite. Items score higher than whole files, so they have their own cut-offs.

| Result | File verdict | Item verdict |
| --- | --- | --- |
| `violates ≤ 0.3` (files) or `≤ 0.5` (items) | `pass` | `pass` |
| `violates ≥ 0.45` (files) or `≥ 0.65` (items) | `violation` | `violation` |
| otherwise | `review`: uncertain, including cases where careful reviewers would disagree | `review` |
| request with only that policy or item over the byte limit | `inconclusive` (not sent; Clef would truncate it) | `inconclusive` |

Transient HTTP failures are retried up to 3 times with exponential backoff.

Answers are cached on disk in `.lint-anything/cache`, one file per question, keyed by the model, the request's text (guidance and excerpt, or guidance and rule), and the question (rule, or rendered item). Only questions whose inputs changed are sent: re-running on unchanged files sends nothing, and editing a policy re-asks only that policy. Delete the directory to judge everything afresh.

Clef's answer to one question shifts a little with the other questions in its request (see Evals). A selector's items are sorted by path, line, and id before they are packed, so the same items always get the same answers; with the cache, an edit in one file also leaves the verdicts of every other file as they were.

## Output

The CLI prints one line per non-passing finding — verdict, violation probability, location, policy, and reason — then a count per verdict. The location is the file's path; for an item, its `path:start-end`, or its `id` when it has no path and lines; a `limit` finding gives its count as the reason:

```
violation     0.93   src/a.ts  no-debugger
violation     0.97   src/a.ts:4-4  todo
violation     0.97   9acebc18  commits
3 checks: 3 violation, 0 review, 0 inconclusive, 0 pass
```

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
bun evals/examples.ts                      # policy examples as few-shot
bun evals/cutoffs.ts items                 # per-policy cut-offs tuned on dev vs. global (stored scores)
bun evals/cache.ts                         # the answer cache: requests on re-runs and edits (real requests)
bun evals/packing.ts                       # repeatability of fresh runs (real requests) and batch independence
bun evals/counts.ts                        # limit vs. asking the count rule of the whole file
bun evals/mine.ts prometheus/prometheus    # candidate real violations from PR review comments (GitHub API, cached)
bun evals/sample.ts --per-repo 3 owner/repo …   # random real files by language, test vs. source, and size (GitHub API, cached)
bun evals/wordings.ts --split test         # each rule-wording set vs. the polished policies, each scored against its own gold
```

`evals/RESEARCH.md` is the research notebook for growing the semantic corpus. It lists each hypothesis with its prediction, method, result, and conclusion, plus the resulting plan and the labeling protocol for new files.

- **Policies** (`evals/corpus/policies/`) come in two categories, picked with `--category`:
  - `semantic/`: 17 rules of the kind lint-anything is for, which static analysis can't practically enforce. They cover naming (intent-revealing names, names that match behavior), readability (one level of abstraction per function, named magic values, comments that explain why), design (no flag parameters, single responsibility, explicit dependencies, preserving error context), architecture (decisions separate from I/O, thin entry points), encapsulation (no leaked mutable state, minimal public surface), organization (cohesive modules), maintainability (no duplicated knowledge), and testing (behavior over implementation, descriptive test names). Most apply to every `.ts`/`.js`/`.py`/`.go` file; the two testing rules apply to test files. Their voice varies and some list exceptions, but each is a paragraph of 56–124 words. Rules worded as users write them are a separate axis (rule wordings, below).
  - `control/`: four mechanical rules that existing linters already handle (TODOs need an issue, no `any`, Go errors handled, no swallowed Python exceptions), kept for comparison.
- **Corpus** (`evals/corpus/`): every file is labeled `violates`, `complies`, `not-applicable`, or `ambiguous` against every policy whose globs match it: 623 files, 10,623 cases (1,859 violating, 561 ambiguous). Each file has an `origin` and a `provenance` (how it entered the corpus, its sampling stratum, and the date of the last upstream commit that touched it):
  - `real`: 462 files copied verbatim from 149 permissively licensed GitHub projects (7,812 cases: 1,307 violating, 442 ambiguous). Each record pins its upstream repo, commit, path, and SPDX license; the license texts are in `evals/corpus/licenses/`. By source:
    - `curated`: 70 files from 31 projects picked by hand, among them VS Code, Hono, ky, Deno std, NestJS, tRPC, Django, Flask, requests, scikit-learn, Home Assistant, Kubernetes, Prometheus, cobra, gin, the GitHub CLI, caddy, and etcd.
    - `sampled`: 288 files drawn at random by `evals/sample.ts` from 99 projects (Go, Python, and TypeScript; under 1k, 1k–20k, and over 20k stars; pushed after 2026-09-15), up to 3 per project, about 30% test files, size bins drawn evenly.
    - `mined`: 104 files from 34 projects, each the file at the commit where a top-level PR review comment, classified with high confidence, said the code breaks a semantic policy (`evals/mine.ts`).
  - `synthetic`: 15 contrast pairs written for the corpus. Each pair is a realistic file that violates one target semantic rule, and a twin with only that violation fixed (522 cases).
  - `planted`: 131 twins of real files, each with one minimal edit that introduces a violation of one semantic rule (2,289 cases): 12 planted by hand, 119 by Claude and kept only when Claude and gpt-6.1-sol both flagged the edited lines. Each twin is paired with its original, and each real file has at most one twin.

  Every semantic policy has at least 20 clear violations on each split, counting plants. Real files alone fall short on at least one split for 7 policies, worst cohesive-modules (4 dev / 4 test), thin-entry-points (12 / 3), and test-behavior-not-implementation (11 / 8); `run.ts` prints n next to every per-policy number. Planted and synthetic files have scored higher than real ones (`evals/RESEARCH.md`, H7, H12), so `run.ts` breaks results out by origin; read headline numbers on `real`.

  Labels model reality, ambiguity included. The 112 original files were labeled three times by `claude-opus-5-5` subagents and adjudicated; a cross-family pass with gpt-6.1-sol, adjudicated by Claude, then changed 119 labels where the two models agreed against gold (`evals/RESEARCH.md`, H2). Files added later are labeled by the two-model protocol (H11): Claude and gpt-6.1-sol each label every matching policy, a blinded Claude adjudicator decides their disagreements, and an adjudicated `ambiguous` stays `ambiguous`. Applied to the curated files, the protocol matches their gold in 128 of 137 violations and contradicts one clear label. Semantic ambiguous cases are 6%. Files are split dev/test (new files by project), and pairs stay together.
- **Rule wordings** (`evals/corpus/wordings/<set>/`): the same semantic policies worded as users write them, each with gold labeled against its own text on every corpus file with semantic policies: `terse` (one line each), `style-guide` (published style-guide passages), and `agents-md` (rules from open-source projects' AGENTS.md and contributor docs). Sources and licenses are in each set's `sources.json`. `run.ts --wording <set>` scores a set; `wordings.ts` compares each with the polished policies on the same cases.
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

  Requests always carry every policy that matches the file, as production sends them. `--origin` and `--category` only decide which answers are scored; `--wording <set>` swaps in that set's policy text and gold, on the files labeled for it.
- **Metrics**: the ideal score is 1 for a clear violation, 0.5 for an ambiguous case, and 0 otherwise.
  - AUROC on clear cases;
  - ordinal concordance (whether ambiguous cases fall between clean and violating ones);
  - Brier score against the 0 / 0.5 / 1 target;
  - three-way verdict macro-F1 (`pass`↔clean, `review`↔ambiguous, `violation`↔violates);
  - how many violations are caught or surfaced, how many ambiguous cases land in `review`, and false alarms;
  - contrast-pair ordering;
  - cost per 1,000 files.

  Verdicts use `--thresholds floor,threshold`, which defaults to production's. The table also shows the cut-offs that would maximize F1 on the scored cases; pick them on dev and pass them to test. The first strategy is the baseline, and intervals are 95% paired bootstraps that resample files, because cases in one file share requests.
- **Cache**: replies are cached in `evals/.cache` by model and exact request body, since Clef is deterministic. Reruns and re-scoring are free; only new request shapes are sent. Per-case scores go to `evals/results/<split>[.<origins>][.<category>][.wording-<set>]/<strategy>.jsonl`.
- **Selector items** (`evals/items.ts`): `evals/corpus/selectors/` gives six corpus policies a `select` command built from `rg` and `jq`: TODO lines, lines with `any`, Python `except` handlers, comment runs with the line after, test declarations with their bodies, and lines with numeric literals. Globs and rule text must equal the corpus policy's, so the corpus labels still apply. Each item is labeled `violates` when its lines overlap the file's gold violation lines and clean otherwise. Files labeled `ambiguous` for the policy are left out. The runner reports item AUROC, AUROC among items of violating files (whether a violating item lifts its neighbours), Brier, caught and false-alarm rates at the CLI's item cut-offs (`--thresholds` overrides them), and, per file, the highest item score against the CLI's whole-file judgment of the same cases. Shapes: `production` (the CLI's planner), `single` (one request per item), and `list` (rule and items in the state, one short question per item). `--selectors <dir>` scores another set of selector policies against the same labels, such as selectors that add context. Per-item scores go to `evals/results/items.<split>[.<dir>]/<shape>.jsonl`.

Findings on the grown corpus (2026-10-21; `run.ts --origin real --category semantic production production,chunk=0`). Real files, semantic policies; whole file is `chunk=0` at the same cut-offs:

| Real files, semantic | Cases | Clear violations | AUROC: production | AUROC: whole file | Verdict F1 at 0.3 / 0.45 | F1 at dev-tuned 0.275 / 0.375 | Caught | False alarms | $ / 1k files |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| dev | 3,691 | 611 | 0.863 | 0.790 [−0.122, −0.035] | 0.502 | 0.541 [+0.020, +0.058] | 24% | 7% | $4.56 |
| test | 3,258 | 537 | 0.870 | 0.824 [−0.090, −0.011] | 0.503 | 0.533 [+0.011, +0.048] | 28% | 8% | $4.33 |

- Excerpts now beat whole files outside noise on both splits. On the 112-file corpus the test gain was within noise.
- File size still matters, though less than the whole-file gap. Real files: AUROC 0.897 under 4 KB, 0.811 at 4–9 KB, 0.836 above 9 KB. Large minus small is −0.061 [−0.095, −0.023] (`evals/RESEARCH.md`, H15).
- Per policy on test (n = clear violations), the weakest are comments-explain-why (0.788, n 65, none caught at 0.45), protect-internal-state (0.864, n 14, none caught), and minimal-public-surface (0.873, n 23, 9% caught). Most semantic violations score between the floor and the threshold, so `review` holds them.
- The file cut-offs tuned on dev (0.275 / 0.375) beat the CLI's 0.3 / 0.45 on held-out test, outside noise: F1 +0.011 to +0.048 on real semantic cases, +0.009 to +0.036 on all test cases. Caught rises from 28% to 42%, and false alarms from 8% to 10%. Changing the default changes the CLI's verdicts, so the user has to decide it; the default is unchanged.
- Hand-picked files are harder than random ones. Semantic AUROC is 0.804 on curated real files, 0.882 on sampled ones, and 0.845 on mined ones, and the gap holds within each size bin. Labeling doesn't explain it: relabeling the curated files with the two-model protocol gives 0.809 (−0.014 to +0.025 vs. their gold). Pooled real numbers depend on this mix.
- Clef doesn't score famous or older code better. Among sampled files, projects over 20k stars minus projects under 1k is −0.032 [−0.069, +0.006]. For files last changed before 2026-07-01 minus after, it is +0.015 [−0.012, +0.043] (H14).
- LLM plants run slightly easier than real violations of the same policies, but the gap is within noise: +0.033 [−0.020, +0.085] in mean score. Pooled across policies the gap is +0.10, and that comes mostly from which policies were planted (H12). Twins score above their originals 116 times out of 119.

Rule wording, each set scored against gold labeled for its own text (`wordings.ts --origin real`, real files; false alarms here are clean cases given `review` or `violation`):

| Wording | Split | Clear violations (polished → set) | AUROC | False alarms | Caught |
| --- | --- | --- | --- | --- | --- |
| terse (one line per rule) | dev | 611 → 809 | 0.863 → 0.866 [−0.014, +0.019] | 7.0% → 14.3% | 24% → 43% |
| | test | 537 → 677 | 0.870 → 0.864 [−0.024, +0.013] | 7.9% → 15.2% | 28% → 42% |
| style-guide passages | dev | 611 → 755 | 0.863 → 0.835 [−0.045, −0.012] | 7.0% → 13.6% | 24% → 31% |
| | test | 537 → 658 | 0.870 → 0.835 [−0.052, −0.017] | 7.9% → 11.9% | 28% → 31% |
| AGENTS.md rules (16 policies) | dev | 591 → 834 | 0.867 → 0.845 [−0.038, −0.005] | 6.6% → 17.5% | 23% → 31% |
| | test | 524 → 735 | 0.874 → 0.851 [−0.040, −0.006] | 7.2% → 16.5% | 28% → 34% |

- Real-world rules mean more violations: their gold has 23–41% more of them than the polished rules' gold. Judged against its own gold, terse wording ranks as well as the polished text; the earlier loss (H6) came from scoring terse rules against polished gold. Borrowed wordings lose 0.02–0.035 AUROC, outside noise on both splits. Every set roughly doubles false alarms (H13).

Findings on the 112-file corpus, re-scored 2026-10-21 against the relabeled gold (cached answers). Strategies and cut-offs were chosen on dev; these are held-out test numbers:

| Test split | Semantic AUROC | Semantic concordance | Semantic verdict F1 | Ambiguous → `review` | False alarms | Control AUROC | $ / 1k files |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Previous production: whole file, cut-offs 0.55 / 0.7 | 0.798 | 0.780 | 0.341 | 3% | 0% | 0.981 | $1.44 |
| Previous request shape, cut-offs re-tuned on dev (0.25 / 0.4) | 0.798 | 0.780 | 0.501 | 31% | 8% | 0.981 | $1.44 |
| `production`: 4,000-byte excerpts, cut-offs 0.3 / 0.45 | 0.834 | 0.817 | 0.506 | 28% | 7% | 0.980 | $3.06 |

- Clef can separate semantic violations from clean code, but long files dilute them. Judged whole, AUROC falls from 0.87 for files under 4 KB to 0.76 above 9 KB (with excerpts: 0.87 vs. 0.80, a gap no longer clearly outside noise; `evals/RESEARCH.md`, H9). Judging excerpts restores much of it: on dev, clear-case AUROC rose from 0.808 to 0.849 (+0.022 to +0.061) and concordance from 0.776 to 0.815 (+0.023 to +0.056). On test, concordance improved by +0.037 (interval +0.014 to +0.064); the AUROC gain (+0.036, interval −0.004 to +0.076) is within noise on test's smaller sample. Control rules are unchanged.
- The old cut-offs were the biggest problem. Semantic violations mostly score 0.2–0.5, so 0.55 / 0.7 passed nearly all of them. Re-tuned cut-offs lift semantic verdict F1 from 0.341 to about 0.5 on their own.
- Clef sees ambiguity only partly. It ranks ambiguous cases above clean ones (0.81 dev, 0.84 test) but barely below clear violations (about 0.55). Asking directly whether reviewers would disagree (`contest=ask`), a three-way `verdict` question, or `calibrated` wording didn't change that. With excerpts, `review` catches 28% of the ambiguous cases on test.
- Nothing else helped on both splits. Neither wording, question type, question ids, nor smaller batches beat production on dev; `guidance=question` is ahead on test only (AUROC +0.002 to +0.034; dev −0.015 to +0.019), so it isn't confirmed. Per-rule batches cost about 4× more without gaining once excerpts are used. clef-flash still misses most violations (and Workers AI no longer serves it; its eval answers come from `evals/.cache`).
- The earlier synthetic-corpus finding that batching was free held only for mechanical rules. On semantic rules it lowers scores, and excerpts recover that loss more cheaply than one question per request.

Selector findings, re-scored 2026-10-21 (shape and cut-offs chosen on dev; test: 527 items, 61 violating, in 143 file cases; selectors cover 61 of 70 gold violation ranges):

| Test split | Item AUROC | Brier | Violating items given `violation` / clean items not passed (0.5 / 0.65) | Same file cases: highest item vs. whole file | $ / 1k items |
| --- | --- | --- | --- | --- | --- |
| `production`: rule in the state, one question per item | 0.966 | 0.078 | 59% / 7% | 0.973 vs 0.912 [+0.027, +0.106] | $0.051 |
| `single`: one request per item | 0.962 [−0.024, +0.018] | 0.092 [+0.003, +0.026] | 72% / 8% | 0.965 vs 0.912 [+0.019, +0.090] | $0.123 |
| `list`: rule and items in the state | 0.959 [−0.024, +0.007] | 0.078 [−0.008, +0.006] | 59% / 5% | 0.984 vs 0.912 [+0.033, +0.120] | $0.053 |

- Packing items as questions loses nothing to one request per item, and is better calibrated: Brier is worse for `single` outside noise on test (within noise on dev). It costs 2.4× less. `list` ties `production` on both splits.
- A matched selector beats judging the whole file for the same rules. Taking a policy's highest item score as its file score lifts AUROC from 0.912 to 0.973 on test (0.905 to 0.965 on dev), outside noise, and each finding points at its lines.
- Items score higher than whole files: at the file cut-offs (0.3 / 0.45), 27–29% of clean items would be flagged. On dev, 0.5 / 0.65 catches 63% of violating items as `violation` with 2% of clean items flagged, and surfaces 78% with 7% flagged; on test, 59% at 2% and 85% at 7%.
- Mechanical rules are solved (item AUROC 1.0 for TODOs, `any`, and swallowed exceptions). Semantic items: comments 0.940, magic values 0.971, test names 0.700 on 11 items.

### Evidence findings

Each feature that adds evidence or changes how items are judged has an intended purpose, an eval that measures it, and a result. Choices are made on dev and confirmed on test; intervals are 95% paired bootstraps resampling files.

| Feature | Intended purpose | Eval | Result | In the CLI |
| --- | --- | --- | --- | --- |
| Evidence fields on items | Items judged better with their surrounding code | `compare.ts` + `selectors-evidence` | Holds on test: Brier better on both rules; 2.4–3.4× cost | yes |
| `evidence` steps, `{{name}}` | Rules about time and history become judgeable | `history.ts` | Holds: accuracy 63% → 99% with a computed age; Clef can't derive it from dates | yes |
| Steps refining earlier evidence | Better judgments from narrowed evidence | `compare.ts` + `selectors-evidence-constants` | Unconfirmed: test Brier better, dev not | yes (mechanism) |
| Shared steps | Policies sharing a step don't repeat it | `shared.ts` | Holds: 6 → 1 runs, identical findings, ~5× faster | yes |
| `examples` (few-shot) | Examples improve judgments | `examples.ts` | Small: test AUROC +0.001 to +0.019, dev +0.000 to +0.020 (edge of noise) | yes |
| Sorted items | The same files get the same verdicts | `packing.ts` | Holds: two fresh runs went from 40 differing verdicts to 0 | yes |
| Answer cache (always on) | Re-runs pay only for changes; stable verdicts | `cache.ts` | Holds: 0 requests unchanged, 18 of 81 after an edit, 0 vs 25 verdict changes in untouched files | yes |
| `limit` | Count rules judged reliably | `counts.ts` | Holds: 100% vs 81% (63% at the boundary) | yes |
| Per-policy cut-offs | Better verdicts than global cut-offs | `cutoffs.ts` | Fails: no gain on items, worse on files | no |
| `ask` routing step | Drop items a rule doesn't govern, cutting false alarms | (commit `c825cff`) | Fails: dev false alarms rose, violations dropped | no |
| `check` subcommand, `--baseline` / `--changed-since`, `--sarif` | Example checks; adoption on existing code; code scanning | (commits `d4d5052` to `1eddf4d`) | Each measured; see below | no: removed, because the CLI takes no flags or subcommands |

`evals/compare.ts` scores selector sets against the same item labels with the CLI's request shape and prints, per policy, AUROC and Brier with intervals against the first set, caught / surfaced / false-alarm rates at the item cut-offs, and cost per 1,000 items. A set whose selector drops items is scored over the union of all sets' items, a dropped item counting as a pass. Its scores go to `evals/results/items.<split>.<set>/production.jsonl`. Eval selectors call helper steps in `evals/steps/` as `bun "$EVAL_STEPS/<step>.ts"`.

The whole policy file, selector command included, is the rule text Clef reads, so changing only a selector's command text changes the answers about as much as repacking does. The numbers below were re-measured after the eval steps moved to `evals/steps/`; earlier versions of these tables used different command text.

#### Evidence fields (enclosing block)

Purpose: Clef judges an item better when it sees the code around it. Measured on the two semantic selector policies whose items are short (comments, magic-value lines) by `evals/corpus/selectors-evidence/`, which pipes the same items through `evals/steps/enclosing.ts`.

| Policy, split | Items (violating) | AUROC | Brier | Caught / surfaced / false alarms | $ / 1k items |
| --- | --- | --- | --- | --- | --- |
| comments, dev | 576 (47) | 0.820 → 0.864 [−0.014, +0.100] | 0.109 → 0.097 [−0.028, +0.009] | 26 / 57 / 8.1% → 26 / 64 / 9.3% | $0.043 → $0.149 |
| comments, test | 290 (16) | 0.940 → 0.967 [−0.001, +0.061] | 0.083 → **0.065** [−0.026, −0.011] | 19 / 63 / 5.5% → 38 / 69 / 5.5% | $0.045 → $0.115 |
| magic values, dev | 317 (7) | 0.953 → 0.963 [−0.012, +0.034] | 0.071 → **0.045** [−0.036, −0.014] | 71 / 71 / 5.5% → 71 / 71 / 4.2% | $0.044 → $0.126 |
| magic values, test | 185 (16) | 0.971 → 0.980 [−0.008, +0.036] | 0.076 → **0.053** [−0.037, −0.010] | 44 / 100 / 8.3% → 75 / 81 / 4.1% | $0.044 → $0.095 |

- The purpose holds for calibration: Brier improves on test for both rules and on dev for magic values; for comments on dev it is within noise. AUROC gains are within noise. Clean magic-value items flagged fall from 8.3% to 4.1% on test.
- It costs 2.2–3.5× more per item, because the block is repeated in each item's question.
- Relevance matters, not volume: in a prototype, the 10 lines after each comment instead of its enclosing block lowered comment AUROC on test (interval −0.053 to −0.002).

#### Shared evidence steps and `{{name}}`

Purpose 1: evidence from outside the file makes rules about time or history judgeable. `evals/history.ts` builds a git repository (deterministic, rebuilt each run) whose 126 TODOs in 18 TypeScript, Python, and Go files were committed on known dates, 35 of them within five days of the threshold, and judges "TODOs added more than 90 days ago must reference an issue" (47 violating) with four policies that differ only in evidence (`evals/steps/blame.ts` adds each TODO's commit date and age):

| Evidence | AUROC | Brier | Accuracy at 0.65 | Near threshold (±5 days) | Issue-less TODOs ≤ 90 days old flagged | Caught / false alarms | $ / 1k items |
| --- | --- | --- | --- | --- | --- | --- | --- |
| none | 0.802 | 0.154 | 63% | 60% | 96% | 36% / 30% | $0.036 |
| `today: echo …` step, `Today is {{today}}.` in the rule | 0.869 [+0.021, +0.113] | 0.138 [−0.025, −0.007] | 77% [+6, +22 pts] | 77% | 83% | 66% / 28% | $0.037 |
| … plus each TODO's commit date | 0.869 [+0.008, +0.128] | 0.138 [−0.043, +0.012] | 82% [+7, +30 pts] | 60% | 83% | 94% / 25% | $0.042 |
| … plus the computed age | **1.000** [+0.121, +0.278] | **0.015** [−0.167, −0.108] | **99%** [+25, +48 pts] | **97%** | **0%** | 98% / 1% | $0.045 |

- The purpose holds once the evidence states the fact the rule turns on. With the age in days on each item, accuracy rises from 63% to 99% and false alarms from issue-less young TODOs vanish.
- Clef doesn't do the date arithmetic: given today's date and each commit date, it still flags 83% of young issue-less TODOs. Compute facts in steps; don't ask Clef to derive them.
- Today's date alone, through `{{today}}`, helps a little (accuracy +6 to +22 points).

Purpose 2: later steps can refine earlier evidence. `evals/corpus/selectors-evidence-constants/` adds a `constants` step (every named constant in the files) that a final selector step narrows to each item's own file, on top of the enclosing block, for magic values:

| Split | Items (violating) | AUROC | Brier | Caught / surfaced / false alarms |
| --- | --- | --- | --- | --- |
| dev | 317 (7) | 0.963 → 0.965 [−0.018, +0.023] | 0.045 → 0.048 [−0.005, +0.015] | 71 / 71 / 4.2% → 71 / 86 / 4.2% |
| test | 185 (16) | 0.980 → 0.989 [−0.002, +0.024] | 0.053 → **0.039** [−0.026, −0.004] | 75 / 81 / 4.1% → 75 / 88 / 3.0% |

- The chaining works, but its value is unconfirmed: calibration improves on test and not on dev, which has only 7 violating items. Cost rises 10–14%.
- In a prototype, the same constants placed once in the rule text (the state) instead of on each item did not help (test Brier interval −0.026 to +0.004), while on each item they did (−0.040 to −0.009). Item evidence is the stronger placement; `{{name}}` suits facts that really are global, like today's date.

#### Shared steps

Purpose: policies that share a selector or evidence step don't repeat the work. `evals/shared.ts` lints `src/**/*.ts` with six policies that share one evidence step and one selector (with the enclosing step), against a stub Clef that sends no requests, and counts executions through a log each shared command appends to.

| Code | Evidence step runs | Selector runs | Findings | Time (3 runs) |
| --- | --- | --- | --- | --- |
| before sharing | 6 | 6 | 936 | 757–776 ms |
| with sharing | **1** | **1** | 936, same digest | 142–149 ms |

The purpose holds: each shared command runs once, findings are byte-identical (the eval prints a digest of the findings to compare; it depends on the current `src/`), and step time falls about 5×. Sharing is scoped to one lint run.

#### Policy examples

Purpose: examples in a policy improve its judgments (few-shot). `evals/examples.ts` gives each of the six corpus selector policies two violating items and the two clean items the baseline scored highest, taken from the other split, as `examples`:

| Split | Items (violating) | AUROC | Brier | Caught / surfaced / false alarms | $ / 1k items |
| --- | --- | --- | --- | --- | --- |
| dev | 1,011 (110) | 0.921 → 0.930 [+0.000, +0.020] | 0.089 → 0.087 [−0.007, +0.004] | 63 / 78 / 7.1% → 66 / 80 / 7.9% | $0.047 → $0.052 |
| test | 527 (61) | 0.966 → **0.975** [+0.001, +0.019] | 0.078 → **0.070** [−0.014, −0.003] | 59 / 85 / 6.7% → 62 / 85 / 5.8% | $0.051 → $0.057 |

A small gain, confirmed on test and at the edge of noise on dev; magic values improves most on test (Brier 0.076 → 0.055, interval −0.035 to −0.011; false alarms 8.3% → 3.0%). Cost rises about 11%.

#### Per-policy cut-offs (not shipped)

Purpose: cut-offs fitted to each policy beat the global ones. `evals/cutoffs.ts` tunes each policy's cut-offs on its dev scores and applies them to test:

| Test split | Verdict F1, global → per policy | Violations → `violation` | Violations surfaced | Clean not passed | Ambiguous → `review` |
| --- | --- | --- | --- | --- | --- |
| items | 0.541 → 0.541 | 59.0% → 55.7% | 85.2% → 57.4% | 6.7% → 1.7% | – |
| files | 0.552 → 0.542 | 36.5% → 67.1% | 55.3% → 72.9% | 6.9% → 10.7% | 27.9% → 11.8% |

The purpose fails: per-policy cut-offs gain nothing on items and lose on files, because they overfit dev. Policies keep the global cut-offs.

#### Packing and repeatability

Clef's answer to a question depends on the other questions packed with it. `evals/packing.ts` judges the same 1,011 dev items in the CLI's full batches and in two half-size batches (odd and even items): only 3.0% of answers are identical (mean change 0.068, largest 0.718, 75 verdicts different), but quality is unchanged (AUROC 0.921 → 0.918 [−0.020, +0.016], Brier 0.089 → 0.089 [−0.007, +0.007]). In a probe on one 40-item request, reversing the question order changed answers by 0.107 on average.

Purpose of sorting items: the same files get the same verdicts. Before items were sorted, two fresh runs on the same files disagreed on 40 verdicts, because `rg` emits matches across files in varying order. `evals/packing.ts` runs the CLI's lint twice on 24 dev files without the cache (367 checks, real requests): 0 verdicts differ and every score is identical.

#### Answer cache

Purpose: re-runs pay only for what changed, with results that hold still. `evals/cache.ts` lints 24 dev corpus files with four whole-file and two selector policies through the CLI's Clef path, with a fresh cache directory, then appends a function (narrating comment, issue-less TODO, magic number) to the three files first in path order, which shifts the packing of every item after them:

| Run | Requests | Cached answers | Findings vs. a fresh run |
| --- | --- | --- | --- |
| 1. cold cache | 81 | 0 | – |
| 2. re-run, nothing changed | **0** | 629 | identical (401 checks, every score equal) |
| 3. after the edit, with the cache | **18** | 565 | 91.4% same verdict (35 of 407 differ), mean score change 0.058 |
| 4. after the edit, no cache | 81 | 0 | – |

Run 3 differs from run 4 because a cached answer was given with other questions than a fresh request would pack it with; packing moves answers without changing their quality (see Packing). So the fair comparison is stability, on the 262 checks of the 21 files nobody edited:

| After the edit | Verdicts changed vs. run 1 | Mean score change |
| --- | --- | --- |
| with the cache | **0** | 0 |
| without the cache | 25 | 0.060 |

The purpose holds: an unchanged run sends nothing, an edit sends only its questions (18 of 81 requests), and without the cache an edit in three files flips verdicts in files nobody touched. The cache is always on.

#### Defaults of the removed flags

Each flag the CLI used to take is now fixed at one value. Whether that value is the best default, measured where an eval can measure it (2026-10-20; corpus-based rows re-scored 2026-10-21 against the relabeled gold):

| Flag | Fixed at | Evidence | Best default? |
| --- | --- | --- | --- |
| `--threshold` (files) | floor 0.3, threshold 0.45 | `run.ts`, 112-file corpus, dev, 1,081 cases, relabeled gold: F1 0.550 at 0.3 / 0.45; the F1 maximum was 0.275 / 0.55 (F1 0.568, +0.018 [−0.011, +0.049]). Test: 0.552 vs. 0.561 (+0.009 [−0.023, +0.042]). Grown corpus: the dev maximum is 0.275 / 0.375, and on test it gives F1 0.558 vs. 0.536 (+0.022 [+0.009, +0.036]; real semantic cases +0.011 to +0.048) | no longer: the grown corpus favors 0.275 / 0.375 outside noise. Changing it changes CLI verdicts, so it awaits the user's decision |
| `--item-threshold` | floor 0.5, threshold 0.65 | `items.ts`, dev, 1,011 items: F1 0.548 at 0.5 / 0.65; the F1 maximum, 0.6 / 0.625, gains 0.006 by nearly closing the `review` band. On test it gives F1 0.548 vs. 0.541 and catches 62% vs. 59% | yes: within 0.01 F1, and the band keeps uncertain items visible |
| `--model` | `clef` | `run.ts` (cached answers): clef-flash AUROC 0.879 → 0.764 [−0.150, −0.081] on dev, 0.869 → 0.771 [−0.146, −0.051] on test; false alarms 4% → 32% (dev). Workers AI now rejects `clef-flash` ("Unsupported model 'clef-flash'. Use 'clef'") | yes; the only model that runs |
| `--no-cache` | cache on | `cache.ts` above | yes (on) |
| `--changed-since` | off | Throwaway script on `adoption.ts`'s repository and stub (below) | yes (off) |
| `--baseline` / `--write-baseline` | off | Same script | yes (off) |
| `--json`, `--sarif`, `--rules-dir` | text to stdout, no SARIF file, `.lint-anything/rules` | Output format, an extra output file, and a location: no eval measures them. Text was the default before any of these flags existed; SARIF would write a file on every run | not measurable; kept as before |

`--changed-since HEAD` and an automatic baseline as defaults, on a 20-file repository with 11 committed violations (the stub judges by rule, so counts are exact):

| Scenario | Default | Violations reported | Questions | Exit |
| --- | --- | --- | --- | --- |
| clean checkout (CI on a pushed commit) | off | 11 of 11 | 32 | 1 |
| | changed since HEAD | 0 of 11 | 0 | 0 |
| | baseline written on first run | 0 of 11 | 32 | 0 |
| 3 new violations uncommitted | off | 14 of 14 | 35 | 1 |
| | changed since HEAD | 3 of 14 | 5 | 1 |
| | baseline from the first run | 3 of 14 | 35 | 1 |

Either default passes a clean checkout that has violations, and changed-since fails outright outside a git repository (`git diff HEAD` errors, exit 2). Off reports everything in the files given; scope a run by passing fewer globs.

#### Removed from the CLI: `check`, baseline, changed-lines scope, SARIF

These were built and measured with new flags and subcommands, then removed because the CLI takes nothing but file globs. The code and evals are in the git history.

- `lint-anything check` (commit `d4d5052`): judged each policy's examples against the rule without them. It caught a rule about the wrong thing (examples agreeing fell from 90% to 48%) but not an inverted one (87%), and it failed two semantic policies in their own wording.
- `--baseline` and `--changed-since` (commit `d43f246`): on a generated repository, all five adoption scenarios behaved as expected; a baseline keyed by item text survived line shifts (one keyed by line would have called 7 of 11 accepted findings new).
- `--sarif` (commit `1eddf4d`): the log validated against the SARIF 2.1.0 schema and every finding mapped to one result.
- `ask` routing step (commit `c825cff`): routing the comments policy's items through "is this exempt?" raised dev false alarms from 8.2% to 11.5% and dropped 3 of 36 violating comments.

#### Counting with `limit`

Purpose: rules about a count ("at most 3 issue-less TODOs per file") are judged reliably. `evals/counts.ts` generates 64 TypeScript, Python, and Go files with a known number of issue-less TODOs (0 to 7, 24 files at exactly 3 or 4) among TODOs that cite an issue, and judges "more than 3" two ways:

| Approach | Accuracy | Files with exactly 3 or 4 | AUROC | $ / 1k files |
| --- | --- | --- | --- | --- |
| Clef asked the count rule about the whole file | 81% (52/64) | 63% (15/24) | 0.985 | $0.096 |
| each TODO judged against "must reference an issue", counted by `limit: { max: 3 }` | **100%** (64/64) | **100%** (24/24) | 1.000 | $0.188 |

The purpose holds: every file's count was exact, while the whole-file judgment ranked files well but misplaced the boundary in a third of the files at it. It costs about twice as much.
