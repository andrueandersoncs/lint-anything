# lint-anything

Check anything against plain-English policies, judged by Cloudflare's [Clef](https://developers.cloudflare.com/workers-ai/models/clef/) decision model on Workers AI. A policy's selector decides what is checked: parts of files, facts derived from them, a repository's history, a third-party service.

## Run

```sh
bun install
echo 'CLOUDFLARE_ACCOUNT_ID=...' >> .env
echo 'CLOUDFLARE_AUTH_TOKEN=...' >> .env
bun index.ts
```

The CLI takes no arguments, and one flag, `--debug`: each run checks every policy. Policies are read from `.lint-anything/rules` under the current directory, and each policy's selector finds what it checks. Items are judged by the `clef` model and printed as text. Clef's answers are cached in `.lint-anything/cache` (add it to `.gitignore`). Effect CLI also provides its global flags (`--help`, `--version`, `--wizard`, `--completions`, `--log-level`); they are expected and stay.

| Environment variable | Required | Meaning |
| --- | --- | --- |
| `CLOUDFLARE_ACCOUNT_ID` | yes | Workers AI account |
| `CLOUDFLARE_AUTH_TOKEN` | yes | API token |
| `CLOUDFLARE_API_BASE_URL` | no | Defaults to `https://api.cloudflare.com/client/v4` |

Bun loads `.env` automatically.

## Policies

There are no built-in policies, and the CLI adds nothing to what a policy asks. A policy is a Markdown file anywhere under the rules directory (subdirectories included) that says everything Clef is asked:

- the **body** (after the frontmatter) is the text of every request, sent exactly as written: the rule, and any framing or examples that help Clef judge it;
- the **`select`** command decides what is judged: which files, which parts of them, and what context goes with each part. Each item it emits is one yes/no question;
- the **`criteria`** say what a yes and a no mean: `true` describes an item that violates the rule, `false` one that follows it.

The CLI reads Clef's yes as "this item violates the rule", so a policy must have both criteria. Without them, Clef may read the question as whether the item *follows* the rule, which inverts every verdict. With only `Rule: every TODO must reference a tracking issue like #123.` as the body and no criteria, `// TODO(#12): tracked` scored 0.94 (`violation`) and `// TODO: fix this later` scored 0.02 (`pass`). With criteria added, they scored 0.02 and 0.94. A body that says what to decide ("Decide whether it breaks the rule below") helps too.

````md
---
select: |
  rg --json -w 'TODO|FIXME' -g '*.{ts,tsx}' |
    jq -c 'select(.type == "match") | {id: "\(.data.path.text):\(.data.line_number)", path: .data.path.text,
           lines: [.data.line_number, .data.line_number], text: "comment at \(.data.path.text):\(.data.line_number):\n\(.data.lines.text)"}'
criteria:
  "true": "The comment has no tracking issue."
  "false": "The comment references a tracking issue, or isn't a TODO or FIXME."
---
Each question shows one comment. Decide whether it breaks the rule below.

Rule: every `TODO` or `FIXME` comment must reference a tracking issue, written as `#123`, `ABC-123`, or a full issue URL.
````

- Frontmatter holds `select` and `criteria` (`true` and `false`), all required, and `limit` (below). Any other key is an error.
- The body must not be empty.
- The policy name is its path relative to the rules directory, without `.md` (for example `sub/todo-has-issue`).

A missing rules directory, one with no `.md` files, or an invalid policy stops the run.

Policies are meant to be written and tuned by a coding agent: give it the rule you want, files that break and follow it, and `evals/` as the way to measure, and let it iterate on the selector, the body, and the criteria together. Because the CLI adds nothing, any way of asking Clef that a request can express is available to a policy. `evals/corpus/selectors-excerpts/` is the earlier CLI's whole-file judging written as policies: its selector cuts files into 1,000-byte excerpts, and its body and criteria are that CLI's own words.

### Selectors

- The selector runs once per lint run with `sh -c`, from the current directory, with no arguments, an empty stdin, and the CLI's environment (`.env` included). It finds what it checks itself: the example above searches the `.ts` and `.tsx` files under the current directory (`rg` skips what `.gitignore` ignores). A selector can select things that aren't files (`git log`, an API, a database), or facts derived from them.
- It must print JSONL, one item per line, with these fields and no others:

  | Field | Required | Meaning |
  | --- | --- | --- |
  | `id` | yes | Names the item in findings |
  | `text` | yes | Everything Clef reads for this item: the code or text to judge and any context, laid out as the selector likes |
  | `path` | no | The item's file, for findings |
  | `lines` | no | `[start, end]`, 1-based and inclusive, for findings |

- A non-zero exit or a line that isn't a valid item stops the run (exit 2). `rg` and `grep` exit 1 when nothing matches, so end a bare search with `|| true`, or pipe it on as above.
- A selector still running after 10 minutes is killed, with every process it started, and stops the run (exit 2).
- From the evals:
  - Items must reach every place a violation can be: a selector whose items miss the violating lines can't find them.
  - Context belongs in each item's text, and computed facts beat raw data: a TODO's age in days lets Clef judge "older than 90 days" at 99% accuracy; its commit date and today's date do not. Context costs input tokens.
  - Packing a policy's items as questions of one request matches one request per item and costs 2.4× less.
- Structural units (functions, classes, handlers, tests) are easiest to select with a syntax-aware tool such as [ast-grep](https://ast-grep.github.io/). The eval corpus's policies (`evals/corpus/policies/`) and their scripts (`evals/steps/`) are worked examples: a selector lists the files it judges (`rg --files -g '*.ts'`) and pipes their paths to a script that cuts out the units.
- Policies with the same `select` command share one run of it per lint run, so a selector several policies use can live in a script (for example `.lint-anything/lib/functions.sh`) that each calls.

### Counting items: `limit`

A policy can count instead of reporting each item: with `limit`, its items are judged as usual, and then the policy reports one finding per file (or, with `per: run`, one for the whole run) that is a `violation` when more than `max` items are violations.

````md
---
select: |
  rg --json -w 'TODO|FIXME' | jq -c '…'
criteria:
  "true": "The comment has no tracking issue."
  "false": "The comment references a tracking issue."
limit: { max: 3, per: file }
---
Rule: every `TODO` or `FIXME` comment must reference a tracking issue.
````

```
violation     -      src/many.ts  todos  4 of 4 items violate the rule (at most 3 allowed)
```

Write the rule about one item, and put the count in `limit`: Clef judges items well and counts badly (see Evals). Items in `review` are mentioned in the reason but not counted.

## How it works

Each policy's selector runs from the current directory, then Clef judges the selected items. Up to 8 policies run at once, and at most 8 requests are in flight across the run. A request's text is the policy body; it carries one yes/no question per item, the item's text, with the policy's criteria. Each item gets its own finding. A policy whose selector emits nothing sends nothing. Findings are printed in policy order.

A request holds at most 64 questions (Clef's limit) and 64,000 bytes. Items that don't fit in one request are split across several.

| Result | Verdict |
| --- | --- |
| `violates ≤ 0.5` | `pass` |
| `violates ≥ 0.65` | `violation` |
| otherwise | `review`: uncertain, including cases where careful reviewers would disagree |
| request with only that item over the byte limit | `inconclusive` (not sent; Clef would truncate it) |

An attempt that hasn't returned its whole response within 60 seconds counts as a transient failure. Transient HTTP failures (timeouts, network errors, 408, 429, 5xx) are retried up to 3 times with exponential backoff, waiting at least as long as a `Retry-After` header asks. A request that still fails stops the run (exit 2) with the HTTP status and Cloudflare's error, or the network error.

Answers are cached on disk in `.lint-anything/cache`, one file per question, keyed by the model, the request's text (the policy body), and the question (item text and criteria). Only questions whose inputs changed are sent: re-running when nothing changed sends nothing, and editing a policy re-asks only that policy. Each request's answers are cached as it returns, so a run stopped by a failed request keeps the answers it already received. Delete the directory to judge everything afresh.

A cached answer stands for 30 days; after that, its question is asked again, so answers follow updates to the model. At most once a day (the `pruned` file there records when), a run deletes expired answers, so the cache doesn't grow without bound. A cache file that doesn't hold a probability (cut short by a crash, or edited) is a miss, never an answer; answers are written to a temporary file and renamed into place, so a crash can't cut one short.

Clef's answer to one question shifts a little with the other questions in its request (see Evals). A selector's items are sorted by path, line, and id before they are packed, so the same items always get the same answers; with the cache, an edit in one file also leaves the verdicts of every other file as they were.

## Output

The CLI prints one line per non-passing finding — verdict, violation probability, location, policy, and reason — then a count per verdict. The location is the item's `path:start-end`, or its `id` when it has no path and lines; a `limit` finding gives its file's path and its count as the reason:

```
violation     0.93   src/a.ts  module-cohesion
violation     0.97   src/a.ts:4-4  todo
violation     0.97   9acebc18  commits
3 checks: 3 violation, 0 review, 0 inconclusive, 0 pass
```

Only `violation` fails the run; `review` and `inconclusive` are reported but exit `0`.

With `--debug`, the CLI also prints, to stderr after the findings (or before the error, if the run stops), what each policy cost: requests sent, answers taken from the cache, input tokens Clef reported, and their cost at Clef's input-token price, then the total:

```
policy   requests  cached  input tokens  cost (USD)
exports         1       0           379     $0.0001
todo            0       3             0     $0.0000
total           1       3           379     $0.0001
```

| Exit code | Meaning |
| --- | --- |
| `0` | No violations |
| `1` | At least one violation |
| `2` | Invalid command line; policy, selector, configuration, or Clef API error |

An error that stops the run (exit `2`) is printed to stderr as one line, `error: <message>`; stdout holds only findings.

## Develop

```sh
bunx tsc --noEmit
```

## Evals

`evals/` scores policies (body, selector, criteria) and request shapes against a hand-labeled corpus, so changes can be measured instead of guessed. It is also the loop a coding agent uses to write and tune a policy.

```sh
bun evals/validate.ts                      # check the corpus, print label counts per policy and origin
bun evals/validate.ts --verify-upstream    # also check every real file against GitHub, byte for byte
bun evals/run.ts                           # every corpus policy through its selector, dev split
bun evals/run.ts --split test --origin real --category semantic
bun evals/run.ts production single         # request shapes for the same items
bun evals/run.ts --selectors evals/corpus/selectors-excerpts   # another set of policies vs. the corpus policies
bun evals/history.ts                       # context from outside the file: a dated git fixture
bun evals/shared.ts                        # a shared selector runs once (stub Clef, no requests)
bun evals/examples.ts                      # examples written into the policy body, as few-shot
bun evals/cutoffs.ts                       # per-policy cut-offs tuned on dev vs. global (stored scores)
bun evals/cache.ts                         # the answer cache: requests on re-runs and edits (real requests)
bun evals/packing.ts                       # repeatability of fresh runs (real requests) and batch independence
bun evals/counts.ts                        # limit vs. asking the count rule of the whole file
bun evals/mine.ts prometheus/prometheus    # candidate real violations from PR review comments (GitHub API, cached)
bun evals/sample.ts --per-repo 3 owner/repo …   # random real files by language, test vs. source, and size (GitHub API, cached)
bun evals/wordings.ts --split test         # each rule-wording set vs. the polished policies, each scored against its own gold
```

`evals/RESEARCH.md` is the research notebook. It lists each hypothesis with its prediction, method, result, and conclusion, the labeling protocol for new files, and the experiments behind the CLI's design.

- **Policies** (`evals/corpus/policies/`) come in two categories, picked with `--category`. Each body is a short framing ("Each question shows one item with its location and any context. Decide whether that item contains at least one violation of the rule below. …"), then a line `Rule:` and the rule; gold labels refer to the rule. Each selector finds the files its rule applies to (`rg` with globs), cuts out the units its rule judges, and ends with `evals/steps/present.ts`, which writes each item's location and context into its text. The scripts selectors call are in `evals/steps/` (run as `bun "$EVAL_STEPS/<step>.ts"`, with `ast-grep` from the dev dependencies on the `PATH`); those that cut files read their paths on stdin, one per line.
  - `semantic/`: 17 rules of the kind lint-anything is for, which static analysis can't practically enforce. They cover naming (intent-revealing names, names that match behavior), readability (one level of abstraction per function, named magic values, comments that explain why), design (no flag parameters, single responsibility, explicit dependencies, preserving error context), architecture (decisions separate from I/O, thin entry points), encapsulation (no leaked mutable state, minimal public surface), organization (cohesive modules), maintainability (no duplicated knowledge), and testing (behavior over implementation, descriptive test names). Most apply to every `.ts`/`.js`/`.py`/`.go` file; the two testing rules apply to test files. Their voice varies and some list exceptions, but each rule is a paragraph of 56–124 words. Rules worded as users write them are a separate axis (rule wordings, below).
  - `control/`: four mechanical rules that existing linters already handle (TODOs need an issue, no `any`, Go errors handled, no swallowed Python exceptions), kept for comparison.

  | Selector | Policies | Each item, and its context |
  | --- | --- | --- |
  | `functions.ts` (ast-grep) | no-flag-parameters, single-responsibility, separate-decisions-from-effects, thin-entry-points, consistent-abstraction-level, names-match-behavior, intent-revealing-names, explicit-dependencies | a function or method, filtered and annotated per rule by flags: only those with a positional boolean parameter (`--flags`), a minimum length, class outlines, call sites, side effects, docs, module-level globals and hidden dependencies |
  | `module-*.ts`, `duplicates.ts` | minimal-public-surface, protect-internal-state, cohesive-modules, no-duplicated-knowledge | an exported symbol with whether the file uses it; a class or struct with its mutable fields and the members that expose them; the file's outline; candidate pairs of similar blocks |
  | `errors.ts`, `errors-go.ts` | preserve-error-context, go/handle-errors | an error handler with the code it guards and computed facts (`%v` instead of `%w`, error unused); a Go call whose error is dropped, with the callee's signature when the file declares it |
  | `literals.ts` + `enclosing.ts` | explain-magic-values | a line holding a number or string literal that isn't already named or self-explanatory, with its enclosing block |
  | `tests.ts` | descriptive-test-names, test-behavior-not-implementation | a test's name with its suite and assertions; a test's body with computed facts: private members touched, what is mocked, calls asserted |
  | `rg` + `jq` | comments-explain-why, todo-has-issue, no-any, no-swallowed-exceptions | a comment run with the line after it; a TODO line; a line with `any`; an `except` handler |
- **The excerpt policies** (`evals/corpus/selectors-excerpts/`): every corpus rule written the way the CLI judged files before policies had selectors. The selector `excerpts.ts` cuts each file into excerpts of at most 1,000 bytes (before a top-level declaration where it can), each item's text is that CLI's question (`path: <file> (lines a-b of n)`, then `file:` and the excerpt), and the body and criteria are that CLI's guidance and criteria. It is the floor a rule's own selector has to beat (findings below).
- **Corpus** (`evals/corpus/`): every file is labeled `violates`, `complies`, `not-applicable`, or `ambiguous` against every policy that applies to it (its labels say which, and each policy's selector keeps exactly those files): 623 files, 10,623 cases (1,859 violating, 561 ambiguous). Each file has an `origin` and a `provenance` (how it entered the corpus, its sampling stratum, and the date of the last upstream commit that touched it):
  - `real`: 462 files copied verbatim from 149 permissively licensed GitHub projects (7,812 cases: 1,307 violating, 442 ambiguous). Each record pins its upstream repo, commit, path, and SPDX license; the license texts are in `evals/corpus/licenses/`. By source:
    - `curated`: 70 files from 31 projects picked by hand, among them VS Code, Hono, ky, Deno std, NestJS, tRPC, Django, Flask, requests, scikit-learn, Home Assistant, Kubernetes, Prometheus, cobra, gin, the GitHub CLI, caddy, and etcd.
    - `sampled`: 288 files drawn at random by `evals/sample.ts` from 99 projects (Go, Python, and TypeScript; under 1k, 1k–20k, and over 20k stars; pushed after 2026-09-15), up to 3 per project, about 30% test files, size bins drawn evenly.
    - `mined`: 104 files from 34 projects, each the file at the commit where a top-level PR review comment, classified with high confidence, said the code breaks a semantic policy (`evals/mine.ts`).
  - `synthetic`: 15 contrast pairs written for the corpus. Each pair is a realistic file that violates one target semantic rule, and a twin with only that violation fixed (522 cases).
  - `planted`: 131 twins of real files, each with one minimal edit that introduces a violation of one semantic rule (2,289 cases): 12 planted by hand, 119 by Claude and kept only when Claude and gpt-6.1-sol both flagged the edited lines. Each twin is paired with its original, and each real file has at most one twin.

  Every semantic policy has at least 20 clear violations on each split, counting plants. Real files alone fall short on at least one split for 7 policies, worst cohesive-modules (4 dev / 4 test), thin-entry-points (12 / 3), and test-behavior-not-implementation (11 / 8); `run.ts` prints n next to every per-policy number. Planted and synthetic files have scored higher than real ones (`evals/RESEARCH.md`, H7, H12), so `run.ts` breaks results out by origin; read headline numbers on `real`.

  Labels model reality, ambiguity included. The 112 original files were labeled three times by `claude-opus-5-5` subagents and adjudicated; a cross-family pass with gpt-6.1-sol, adjudicated by Claude, then changed 119 labels where the two models agreed against gold (`evals/RESEARCH.md`, H2). Files added later are labeled by the two-model protocol (H11): Claude and gpt-6.1-sol each label every matching policy, a blinded Claude adjudicator decides their disagreements, and an adjudicated `ambiguous` stays `ambiguous`. Applied to the curated files, the protocol matches their gold in 128 of 137 violations and contradicts one clear label. Semantic ambiguous cases are 6%. Files are split dev/test (new files by project), and pairs stay together.
- **Rule wordings** (`evals/corpus/wordings/<set>/`): the same semantic rules worded as users write them, each with gold labeled against its own text on every corpus file with semantic policies: `terse` (one line each), `style-guide` (published style-guide passages), and `agents-md` (rules from open-source projects' AGENTS.md and contributor docs). Each file holds only the rule; a reworded policy is the corpus policy with its rule (after `Rule:`) replaced, so it differs only in rule text. Sources and licenses are in each set's `sources.json`. `run.ts --wording <set>` scores a set; `wordings.ts` compares each with the polished policies on the same items.
- **Runner** (`evals/run.ts`): runs every corpus policy's selector, for every file it applies to, from that file's directory in `evals/corpus/files/` (which holds only that file), and judges the items as the CLI does. Each item is labeled `violates` when its lines overlap the file's gold violation lines and clean otherwise; items of files labeled `ambiguous` for the policy are left out of item metrics. A file's score for a policy is its highest item score (0 when the selector found nothing), compared with the file-level gold. Variants: request shapes (`production`, the CLI's: the body once, one question per item; `single`, one request per item) and `--selectors <dir>`, a set of policies that replace their corpus namesakes (same rule). `--origin` and `--category` decide which cases are scored; `--wording <set>` swaps in that set's rules and gold.
- **Metrics**: the ideal score is 1 for a clear violation, 0.5 for an ambiguous case, and 0 otherwise.
  - file-level AUROC on clear cases, ordinal concordance (whether ambiguous cases fall between clean and violating ones), and Brier score against the 0 / 0.5 / 1 target;
  - three-way verdict macro-F1 (`pass`↔clean, `review`↔ambiguous, `violation`↔violates);
  - how many violations are caught (`violation`) or surfaced (`review` or `violation`), how many ambiguous cases land in `review`, and false alarms (clean cases not passed);
  - item AUROC and Brier, and how many gold violation ranges some item reaches;
  - contrast-pair ordering, and cost per 1,000 files.

  Verdicts use `--thresholds floor,threshold`, which defaults to the CLI's. The table also shows the cut-offs that would maximize F1 on the scored cases; pick them on dev and pass them to test. The first variant is the baseline, and intervals are 95% paired bootstraps that resample files, because cases in one file share requests.
- **Cache**: replies are cached in `evals/.cache` by model and exact request body, since Clef is deterministic. Reruns and re-scoring are free; only new requests are sent. Per-case scores go to `evals/results/<split>[.<origins>][.<category>][.wording-<set>]/<variant>.jsonl`.

Findings (2026-10-22; `run.ts --origin real --category semantic`, cut-offs 0.5 / 0.65):

| Real files, semantic | Cases | Clear violations | File AUROC | Verdict F1 | Caught | Surfaced | False alarms | Item AUROC | Gold ranges reached | $ / 1k files |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| dev | 3,691 | 611 | 0.937 | 0.567 | 68% | 87% | 13% | 0.919 | 1,428 / 1,459 | $16.31 |
| test | 3,258 | 537 | 0.931 | 0.566 | 69% | 85% | 13% | 0.909 | 1,045 / 1,093 | $13.98 |

The same rules as the earlier excerpt CLI (`evals/RESEARCH.md`, H19), as excerpt policies, and with their own selectors (file AUROC on clear cases, paired over the same cases):

| Real files, semantic | Excerpt CLI | Excerpt policies | Rule selectors | Rule selectors − excerpt policies | TPR at 10% false alarms: excerpt policies → rule selectors |
| --- | --- | --- | --- | --- | --- |
| dev | 0.914 | 0.918 [−0.002, +0.010] vs. the CLI | 0.937 | +0.019 [+0.008, +0.029] | 0.71 → 0.83 [+0.07, +0.16] |
| test | 0.913 | 0.914 [−0.005, +0.006] vs. the CLI | 0.930 | +0.016 [+0.006, +0.027] | 0.70 → 0.80 [+0.05, +0.14] |

- The earlier CLI is one policy file per rule: its excerpt policies score what it scored, on both splits. Nothing that CLI did is out of a policy's reach, so a rule's own selector has that as its floor.
- Selectors built for each rule beat it: +0.016 to +0.019 AUROC, and at the same false-alarm rate they find 10–12 points more violations. At the CLI's cut-offs they catch 69% of test violations and surface 85%, with 13% false alarms (the excerpt CLI: 55%, 78%, 14%), for $14–16 per 1,000 files (excerpt CLI: $20–22).
- Per rule, a selector can still lose to the floor, and with 3–70 violations per rule and split the evidence is thin. Picking per rule on dev (custom selector only where its dev gain over the excerpt policy is outside noise) keeps every rule on the excerpt policy and gives up the pooled gain. On test, no-flag-parameters loses to its excerpt policy outside noise (0.977 → 0.915), although dev favored the selector (0.961 → 0.976): its selector only shows functions with a positional boolean, and Clef flags most of them. A coding agent tuning a policy should keep the excerpt policy as its baseline and hold out data to check.
- Control rules on test: 0.93 for Go errors, 1.0 for the other three.
- File size still matters a little. Real test files: AUROC 0.919 under 4 KB, 0.898 at 4–9 KB, 0.917 above 9 KB.
- Measured with earlier request shapes (`evals/RESEARCH.md`): hand-picked files are harder than random ones (semantic AUROC 0.804 curated, 0.882 sampled, 0.845 mined, H10–H11); Clef doesn't score famous or older code better (H14); LLM plants run slightly easier than real violations of the same policies, within noise (+0.033 [−0.020, +0.085], H12).

Rule wording, each set scored against gold labeled for its own text, through the corpus selectors (`wordings.ts --origin real`, real files):

| Wording | Split | Clear violations (polished → set) | File AUROC | False alarms | Caught |
| --- | --- | --- | --- | --- | --- |
| terse (one line per rule) | dev | 611 → 809 | 0.937 → 0.890 [−0.061, −0.033] | 13.0% → 26.6% | 68% → 77% |
| | test | 537 → 677 | 0.930 → 0.886 [−0.060, −0.030] | 13.3% → 26.8% | 69% → 74% |
| style-guide passages | dev | 611 → 755 | 0.937 → 0.909 [−0.040, −0.016] | 13.0% → 16.6% | 68% → 65% |
| | test | 537 → 658 | 0.930 → 0.900 [−0.044, −0.015] | 13.3% → 16.7% | 69% → 63% |
| AGENTS.md rules (16 policies) | dev | 591 → 834 | 0.939 → 0.895 [−0.060, −0.030] | 12.4% → 20.4% | 68% → 71% |
| | test | 524 → 735 | 0.933 → 0.882 [−0.068, −0.035] | 12.2% → 20.5% | 69% → 68% |

- A selector belongs to its rule. The corpus selectors were built for the polished rules, and a reworded rule means something different: its gold has 23–41% more violations, and the polished rules' selectors reach fewer of them (dev: 98% of gold ranges for the polished rules, 87–95% for the reworded ones). Through selectors built for other text, reworded rules lose 0.03–0.05 AUROC and raise false alarms. A rule needs a selector written for it.

Request shapes, measured 2026-10-21 on the six selectors the corpus had then (shape and cut-offs chosen on dev; test: 527 items, 61 violating, in 143 file cases):

| Test split | Item AUROC | Brier | Violating items given `violation` / clean items not passed (0.5 / 0.65) | $ / 1k items |
| --- | --- | --- | --- | --- |
| `production`: rule once, one question per item | 0.966 | 0.078 | 59% / 7% | $0.051 |
| `single`: one request per item | 0.962 [−0.024, +0.018] | 0.092 [+0.003, +0.026] | 72% / 8% | $0.123 |

- Packing items as questions loses nothing to one request per item, and is better calibrated: Brier is worse for `single` outside noise on test (within noise on dev). It costs 2.4× less.
- Mechanical rules are solved (item AUROC 1.0 for TODOs, `any`, and swallowed exceptions).

### Feature findings

Each feature has an intended purpose, an eval that measures it, and a result. Choices are made on dev and confirmed on test; intervals are 95% paired bootstraps resampling files.

| Feature | Intended purpose | Eval | Result | In the CLI |
| --- | --- | --- | --- | --- |
| Context in an item's text | Items judged better with what the rule turns on | `history.ts` | Holds once it states the fact: accuracy 76% → 99% with a computed age; dates alone don't help | yes |
| Shared selector runs | Policies with the same selector don't repeat it | `shared.ts` | Holds: 6 → 1 runs, identical findings | yes |
| Examples in the body (few-shot) | Examples improve judgments | `examples.ts` | Calibration only: Brier better on both splits, AUROC unchanged | yes (write them in the body) |
| Sorted items | The same files get the same verdicts | `packing.ts` | Holds: two fresh runs went from 40 differing verdicts to 0 | yes |
| Answer cache (always on) | Re-runs pay only for changes; stable verdicts | `cache.ts` | Holds: 0 requests unchanged, 4 of 38 after an edit, 0 vs 38 verdict changes in untouched files | yes |
| `limit` | Count rules judged reliably | `counts.ts` | Holds: 100% vs 92% (79% at the boundary) | yes |
| Per-policy cut-offs | Better verdicts than global cut-offs | `cutoffs.ts` | Fails: surfaced violations fall from 72% to 52% for +0.002 F1 | no |
| Policy file sent whole as the rule | Clef reads the rule with its frontmatter | `evals/.cache/research/ident/ablate.ts` (2026-10-22) | Replaced: with the excerpt framing, sending the body without the frontmatter (selector code) raised dev AUROC 0.910 → 0.919; the body alone is now the request's text | no |
| `ask` routing step | Drop items a rule doesn't govern, cutting false alarms | (commit `c825cff`) | Fails: dev false alarms rose, violations dropped | no |
| `check` subcommand, `--baseline` / `--changed-since`, `--sarif` | Example checks; adoption on existing code; code scanning | (commits `d4d5052` to `1eddf4d`) | Each measured; see below | no: removed, because the CLI takes no subcommands and no flags but `--debug` |

#### Context from outside the file

Purpose: context from outside the file makes rules about time or history judgeable. `evals/history.ts` builds a git repository (deterministic, rebuilt each run) whose 126 TODOs in 18 TypeScript, Python, and Go files were committed on known dates, 35 of them within five days of the threshold, and judges "TODOs added more than 90 days ago must reference an issue" (47 violating) with four selectors that differ only in what they write into each item (`evals/steps/blame.ts` adds each TODO's commit date and age):

| Each item also carries | AUROC | Brier | Accuracy at 0.65 | Near threshold (±5 days) | Issue-less TODOs ≤ 90 days old flagged | Caught / false alarms | $ / 1k items |
| --- | --- | --- | --- | --- | --- | --- | --- |
| nothing | 0.877 | 0.135 | 76% | 77% | 92% | 55% / 29% | $0.033 |
| today's date | 0.859 [−0.088, +0.042] | 0.140 [−0.016, +0.027] | 73% [−11, +4 pts] | 71% | 79% | 51% / 25% | $0.036 |
| … and its commit date | 0.915 [−0.008, +0.085] | 0.132 [−0.032, +0.031] | 84% [−1, +17 pts] | 63% | 88% | 98% / 28% | $0.040 |
| … and its computed age in days | **1.000** [+0.077, +0.175] | **0.009** [−0.152, −0.099] | **99%** [+16, +31 pts] | **97%** | **0%** | 98% / 0% | $0.044 |

- The purpose holds once the item states the fact the rule turns on. With the age in days, accuracy rises from 76% to 99% and false alarms from issue-less young TODOs vanish.
- Clef doesn't do the date arithmetic: given today's date and each commit date, it still flags 88% of young issue-less TODOs. Compute facts in the selector; don't ask Clef to derive them.

#### Shared selector runs

Purpose: policies that share a selector don't repeat the work. `evals/shared.ts` lints this repository's `src/*.ts` with six policies that share one selector, against a stub Clef that sends no requests, and counts executions through a log the selector appends to: it runs once instead of six times, and the findings (516, 86 per policy) are the same as without sharing. Sharing is scoped to one lint run.

#### Examples in the body

Purpose: examples improve judgments (few-shot). `evals/examples.ts` appends to each corpus policy's body two violating and two clean items' code from the other split, as an examples section:

| Split | Items (violating) | Item AUROC | Brier | Caught / surfaced / false alarms | $ / 1k items |
| --- | --- | --- | --- | --- | --- |
| dev | 45,108 (2,273) | 0.928 → 0.931 [−0.000, +0.006] | 0.069 → **0.063** [−0.007, −0.006] | 52 / 70 / 5.6% → 46 / 67 / 4.7% | $0.094 → $0.102 |
| test | 39,157 (2,035) | 0.923 → 0.921 [−0.006, +0.002] | 0.073 → **0.064** [−0.009, −0.007] | 56 / 72 / 6.4% → 51 / 68 / 5.1% | $0.099 → $0.109 |

Examples calibrate (Brier better on both splits) without ranking better; they make Clef more conservative, so fewer violations are caught at the same cut-offs. Cost rises about 10%.

#### Per-policy cut-offs (not shipped)

Purpose: cut-offs fitted to each policy beat the global ones. `evals/cutoffs.ts` tunes each policy's cut-offs on its dev item scores and applies them to test (21 policies, 39,157 test items):

| Test split | Verdict F1, global → per policy | Violations → `violation` | Violations surfaced | Clean not passed |
| --- | --- | --- | --- | --- |
| items | 0.497 → 0.499 | 56.0% → 49.9% | 72.2% → 52.2% | 6.4% → 2.6% |

The purpose fails: per-policy cut-offs barely move F1 and give up over a quarter of the surfaced violations, because they overfit dev. Policies keep the global cut-offs.

#### Packing and repeatability

Clef's answer to a question depends on the other questions packed with it. `evals/packing.ts` judges 12,002 dev items in the CLI's full batches and in two half-size batches (odd and even items): only 0.9% of answers are identical (mean change 0.063, largest 0.588, 982 verdicts different), but quality is unchanged (AUROC 0.917 → 0.916 [−0.008, +0.006], Brier 0.078 → 0.077 [−0.004, +0.001]). In a probe on one 40-item request, reversing the question order changed answers by 0.107 on average.

Purpose of sorting items: the same files get the same verdicts. Before items were sorted, two fresh runs on the same files disagreed on 40 verdicts, because `rg` emits matches across files in varying order. `evals/packing.ts` runs the CLI's lint twice on 24 dev files without the cache (461 checks, real requests): 0 verdicts differ and every score is identical.

#### Answer cache

Purpose: re-runs pay only for what changed, with results that hold still. `evals/cache.ts` lints 24 dev corpus files with five corpus policies through the CLI's Clef path, with a fresh cache directory, then appends a function (narrating comment, issue-less TODO, magic number) to the three files first in path order, which shifts the packing of every item after them:

| Run | Requests | Cached answers | Findings vs. a fresh run |
| --- | --- | --- | --- |
| 1. cold cache | 38 | 0 | – |
| 2. re-run, nothing changed | **0** | 1,371 | identical (1,371 checks, every score equal) |
| 3. after the edit, with the cache | **4** | 1,371 | 96.2% same verdict (52 differ), mean score change 0.023 |
| 4. after the edit, no cache | 38 | 0 | – |

Run 3 differs from run 4 because a cached answer was given with other questions than a fresh request would pack it with; packing moves answers without changing their quality (see Packing). So the fair comparison is stability, on the 1,159 checks of the 21 files nobody edited:

| After the edit | Verdicts changed vs. run 1 | Mean score change |
| --- | --- | --- |
| with the cache | **0** | 0 |
| without the cache | 38 | 0.016 |

The purpose holds: an unchanged run sends nothing, an edit sends only its questions (4 of 38 requests), and without the cache an edit in three files flips verdicts in files nobody touched. The cache is always on.

#### Defaults of the removed flags

Each flag the CLI used to take is now fixed at one value. Whether that value is the best default, measured where an eval can measure it:

| Flag | Fixed at | Evidence | Best default? |
| --- | --- | --- | --- |
| `--threshold` | floor 0.5, threshold 0.65 | `run.ts`, corpus policies (2026-10-22): the dev F1 maximum is 0.575 / 0.725 (all cases). On all test cases it gives F1 0.591 vs. 0.580, but catches 63% of violations instead of 73% and surfaces 80% instead of 86% (false alarms 8% vs. 12%) | yes: F1 is flat across both, and 0.5 / 0.65 finds more violations |
| `--model` | `clef` | `run.ts` with the earlier request shape (cached answers): clef-flash AUROC 0.879 → 0.764 [−0.150, −0.081] on dev, 0.869 → 0.771 [−0.146, −0.051] on test; false alarms 4% → 32% (dev) | yes; the CLI and evals now support only `clef`, and the `clef-flash` code is removed |
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

Either default passes a clean checkout that has violations, and changed-since fails outright outside a git repository (`git diff HEAD` errors, exit 2). Off reports everything the selectors find; a selector scopes what it checks.

#### Removed from the CLI: `check`, baseline, changed-lines scope, SARIF

These were built and measured with new flags and subcommands, then removed because the CLI takes no arguments. The code and evals are in the git history.

- `lint-anything check` (commit `d4d5052`): judged each policy's examples against the rule without them. It caught a rule about the wrong thing (examples agreeing fell from 90% to 48%) but not an inverted one (87%), and it failed two semantic policies in their own wording.
- `--baseline` and `--changed-since` (commit `d43f246`): on a generated repository, all five adoption scenarios behaved as expected; a baseline keyed by item text survived line shifts (one keyed by line would have called 7 of 11 accepted findings new).
- `--sarif` (commit `1eddf4d`): the log validated against the SARIF 2.1.0 schema and every finding mapped to one result.
- `ask` routing step (commit `c825cff`): routing the comments policy's items through "is this exempt?" raised dev false alarms from 8.2% to 11.5% and dropped 3 of 36 violating comments.

#### Counting with `limit`

Purpose: rules about a count ("at most 3 issue-less TODOs per file") are judged reliably. `evals/counts.ts` generates 64 TypeScript, Python, and Go files with a known number of issue-less TODOs (0 to 7, 24 files at exactly 3 or 4) among TODOs that cite an issue, and judges "more than 3" two ways:

| Approach | Accuracy | Files with exactly 3 or 4 | AUROC | $ / 1k files |
| --- | --- | --- | --- | --- |
| the count rule, its selector emitting the whole file | 92% (59/64) | 79% (19/24) | 0.983 | $0.095 |
| each TODO judged against "must reference an issue", counted by `limit: { max: 3 }` | **100%** (64/64) | **100%** (24/24) | 1.000 | $0.163 |

The purpose holds: every file's count was exact, while the whole-file judgment ranked files well but misplaced the boundary in a fifth of the files at it. It costs about 1.7× as much.
