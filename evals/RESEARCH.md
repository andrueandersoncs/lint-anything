# Semantic eval research notebook

Working log for improving the semantic evals. Each hypothesis gets a prediction written **before** the
experiment, a method, the observed result, and a conclusion. Results are recorded as observed, not
revised to fit the prediction.

## Goal and ordering

Make the semantic evals better at telling us how lint-anything does, in this priority order:

1. **Correctness**: gold labels are right, and measured verdicts are right (precision, calibration).
2. **Completeness**: every semantic policy has enough clear violations on both splits to measure it,
   and the corpus covers the code and rule shapes real users bring (real rule wording, long files, tests).
3. **Efficiency**: cost per label and per Clef request.
4. **Speed**: wall time to grow and re-score the corpus.

A hypothesis that would improve a lower goal at the expense of a higher one is rejected.

## Constraints

- CLI surface is fixed (AGENTS.md): every helper lives in `evals/`; flags on eval scripts are fine.
- Corpus invariant (`evals/corpus.ts` `loadCorpus`): each file carries exactly one label per policy whose
  globs match its path; pairs are reciprocal; real files are byte-identical to a pinned upstream commit
  under a permissive license.
- Clef requests cost money and draw on a daily Workers AI allocation (error 4006); answers are cached in
  `evals/.cache` by exact body, so re-scoring is free.
- Test split is held out: strategies and cut-offs are chosen on dev only.

## Baseline (2026-10-20, before any change)

112 files (70 real from 31 repos, 30 synthetic, 12 planted), 17 semantic + 4 control policies.
Clear semantic violations per policy:

| Policy | test | dev |
|---|---|---|
| architecture/separate-decisions-from-effects | 0 | 10 |
| architecture/thin-entry-points | 0 | 6 |
| organization/cohesive-modules | 0 | 1 |
| encapsulation/minimal-public-surface | 1 | 4 |
| design/explicit-dependencies | 1 | 4 |
| naming/names-match-behavior | 1 | 6 |
| design/single-responsibility | 2 | 9 |
| encapsulation/protect-internal-state | 2 | 3 |
| testing/test-behavior-not-implementation | 2 | 1 |
| design/no-flag-parameters | 3 | 4 |
| design/preserve-error-context | 3 | 3 |
| naming/intent-revealing-names | 4 | 7 |
| testing/descriptive-test-names | 4 | 4 |
| maintainability/no-duplicated-knowledge | 6 | 15 |
| readability/consistent-abstraction-level | 7 | 11 |
| readability/explain-magic-values | 9 | 5 |
| readability/comments-explain-why | 10 | 18 |

## Hypotheses

| ID | Goal | Hypothesis | Status |
|---|---|---|---|
| H1 | correctness | The current test split cannot resolve per-policy quality | supported (width criterion failed; holds after relabel) |
| H2 | correctness, efficiency | An LLM labeler from another model family reproduces adjudicated gold well enough to label new data | Claude labeler yes (κ 0.77). gpt-6.1-sol no (κ 0.51): it over-flags, but 36 of its extra flags were upheld, so gold likely misses violations. Gold is single-family |
| H3 | completeness | Code review comments in OSS repos yield real violations of the thin policies at a useful rate | refuted as stated: 1.5× enrichment (relabeled gold), but 4.5% yield and ~0 for thin policies |
| H4 | correctness | Review-mined violations are harder for Clef than planted ones | supported on scores, borderline after relabel; pair accuracy untestable (8 pairs) |
| H5 | correctness | Sampling candidates with Clef biases the corpus toward violations Clef already finds | supported: drops 50–61% of violations, ~2–3× inflated catch rate |
| H6 | completeness | Real-world rule wording (terse, style-guide text) changes Clef's quality vs. our polished policies | supported: terse −0.05 to −0.06 AUROC, false alarms ×4–7 |
| H7 | correctness | Operator-planted violations overstate Clef's quality vs. real violations | supported for LLM plants (+0.12, relabeled gold); synthetic +0.24 |
| H8 | correctness | Clef does better on famous repos' files (memorization) | null not rejected; test too weak |
| H9 | completeness | With excerpts, file size no longer predicts Clef's quality | refuted on the original gold; **inconclusive** after relabel (−0.07, interval reaches 0) |
| H10 | completeness | Randomly sampled real files carry semantic violations at about the curated files' rate | supported: 0.88× overall, 1.14× thin policies |
| H11 | correctness | The two-model labeling protocol behaves on new files as it did on the corpus in H2 | mostly: κ 0.50 / 0.44 as predicted; adjudication upholds more gpt-only flags than predicted (63–75%) |
| H12 | correctness | LLM-planted violations remain easier than real ones at scale | partly: +0.10 pooled, but +0.03 (within noise) with policies matched |
| H13 | correctness | With gold labeled against each wording, real-world wording still costs quality | refuted for terse ranking (±0.02 on 451 real files); borrowed wordings −0.02 to −0.035, outside noise; false alarms ×~2 |
| H14 | correctness | Memorization, retested with recent commits and small repos | null not rejected; intervals ±0.04 |
| H15 | completeness | Size effect under production, retested on the grown corpus | supported: −0.061 [−0.095, −0.023] |
| H16 | correctness | Production's misses come from a few policies and from comparing scores across policies (diagnostic) | supported: one policy (comments) is 30% of misses; pooled AUROC 0.863 vs. 0.898 within policy; no excerpt-aggregation rule beats `max` |
| H17 | correctness | A per-policy score offset, found without corpus labels, recovers the within-policy ranking | content-free and unlabeled offsets: refuted. Offsets from ≥ 3 labeled example files per class: +0.03 AUROC on production, only ≥ 5 on the H19 shape |
| H18 | correctness | Other request shapes or models rank violations better (sweep, grown corpus) | refuted: clef-omni −0.08, one policy per request −0.013; line numbers, outline, 2 KB excerpts, no "complete" within noise; averaging two policy orders +0.01 at 2× cost |
| H19 | correctness | The rule in the state and the file's excerpts as questions ranks violations better | supported on dev and test: AUROC +0.036 to +0.041 with 4 KB excerpts, +0.043 to +0.051 with 1 KB; holds for terse wording and control rules; 3.5–4.7× cost |
| H20 | correctness | Selectors still beat whole-file judging on the grown corpus | supported for comments (0.85 → 0.95 dev, 0.79 → 0.94 test); refuted for magic values (its selector reaches 2/3 of the gold violation lines); test names mixed (16–20 violations) |
| H21 | correctness | Every policy judged through a selector built for its rule beats judging every rule against the same excerpts | supported on test: file AUROC 0.913 → 0.930 [+0.006, +0.028]; at 14% false alarms 69% caught vs. 55%; loses for no-flag-parameters and names-match-behavior; reworded rules lose 0.04–0.07 through selectors built for other text |
| H22 | correctness | With nothing added by the CLI, a policy can reproduce the excerpt CLI (H19) exactly in score, so a rule's own selector has it as a floor | supported: excerpt policies 0.918 / 0.914 vs. H19 0.914 / 0.913 (dev / test, intervals include 0); rule selectors beat them by +0.016 to +0.019 pooled; per rule, no-flag-parameters loses on test |

Order of work: H1 (sizes every later sample), H2 (gates any labeling at scale), then H3/H4, H5, H7, H6,
H9, H8. Corpus growth (2026-10-21): H10, H11 while labeling new files, H12 while planting, then H13, H14, H15
on the grown corpus.

## Synthesis: how to grow the semantic corpus

Ranked by the goal order. Every step stays in `evals/`.

1. **Correctness of gold first.** Gold is all one model family (H2). Where gpt-6.1-sol and the Claude
   adjudicator agree against gold, their verdict now replaces gold (119 labels). Report headline numbers on `real` only: synthetic files are far
   easier (AUROC 0.921 vs. 0.804 real, H7) and inflate pooled numbers.
2. **Completeness target**: ≥ 20 clear violations per policy per split (H1), sampled across size bins
   (H9: half the violations, 98 of 201, sit in 30 files above 9 KB; the size effect under production is
   about −0.07 AUROC and no longer clearly outside noise).
3. **Sources, in the order to use them:**
   - **LLM-planted twins** of real files for the thin policies (H7): cheap (3 calls per verified twin,
     89% confirmed, all located), on demand per policy. They run about 0.1 easier than real violations,
     so keep them as `planted` and never pool them into real-code headlines.
   - **Review-mined real files** (H3, H4): about 1.5× the violation rate of random files, similar difficulty
     as existing real violations, mostly large files, plus reviewer-flagged clean files as hard
     negatives. Yield is low for thin policies, so it complements planting rather than replacing it.
     Use `evals/mine.ts`, keep only top-level comments and high-confidence classifications.
   - **A Clef pre-screen only as a stratified sample** with inverse-probability weights (H5); never as
     the only sampler.
4. **Labeling protocol for new files** (H2): one Claude labeler pass per file with all matching policies,
   a second independent pass, adjudication of disagreements. gpt-6.1-sol is the cross-family second
   model: a recall check, not a labeler (H2 rerun).
5. **Rule wording as an axis** (H6): add variant policy sets (terse, borrowed style-guide text, and
   rules from OSS repos' AGENTS.md/CONTRIBUTING) with gold labeled against each wording, and report
   quality per wording. Terse rules cost about 0.05–0.06 AUROC and 4–7× false alarms.
6. **Record provenance** that later tests need: commit date (H8 memorization: prefer post-cutoff
   commits), sampling stratum (H5), and source (mined, planted, random).
7. **Report methods**: per-policy intervals that don't collapse at small n, with n shown (H1); results
   broken out by size bin (H9) and origin (H7).

**Status (2026-10-21, corpus growth):** steps 1–7 are done. The corpus has 623 files: 462 real (70
curated, 288 sampled, 104 mined), 131 planted (119 LLM plants), and 30 synthetic. Every semantic policy
has ≥ 20 clear violations per split, counting plants. Every file records its provenance (source, stratum,
committed date). Three wording sets carry their own gold. `run.ts` breaks results out by origin, size,
and policy, with n. What H10–H15 changed in the plan:
- Sampled real files carry violations at the curated rate (H10), so random and mined files filled most
  policies; plants were needed for 10 of 34 policy–split cells.
- With policies matched, LLM plants are not clearly easier than real violations (H12). Keep them separate
  anyway.
- Terse wording costs no ranking quality once gold matches the wording. It costs false alarms (H13).
- Curated files are harder than sampled ones (0.804 vs. 0.882), and the labeling protocol doesn't explain
  it. Pooled real numbers depend on the source mix, so report by source too.

Product follow-ups the evals surfaced (not eval changes; each needs its own experiment or a decision):
taking the highest score across many excerpts may inflate clean scores in large files (H9, H15: clean
cases score 0.11 under 4 KB vs. 0.18 above 9 KB); user-written rules raise false alarms (H6, H13). The
grown corpus's dev-tuned file cut-offs, 0.275 / 0.375, beat 0.3 / 0.45 on test outside noise (README) and
are now the CLI's.

---

## H1: the test split cannot resolve per-policy quality

- **Hypothesis**: per-policy AUROC on the test split is too noisy to compare strategies or tune cut-offs.
- **Prediction** (written before running): for at least 10 of 17 semantic policies the 95% bootstrap
  interval of test AUROC is wider than 0.3 or undefined (no clear violation), and reaching a ±0.05
  half-width needs on the order of 20+ clear violations per policy per split.
- **Method**: re-score production on all cases from the answer cache (no new requests), bootstrap
  per-policy AUROC by resampling files, then simulate interval width vs. number of violations by
  subsampling dev+test cases of the best-populated policies.
- **Result** (2026-10-20; `bun evals/run.ts --split all --category semantic production production,chunk=0`, all
  answers from cache, 0 new requests; per-case scores in `evals/results/all.semantic/`):
  - Percentile bootstrap (1,000 file resamples) of test AUROC: 3 policies undefined (no clear
    violation), 4 more wider than 0.3: **7 of 17**, below the predicted 10. But the percentile bootstrap
    collapses when a policy has 1–2 violations: `minimal-public-surface` (1 violation) and
    `single-responsibility` (2) both get [1.00, 1.00], and the interval is defined in only 62–89% of
    resamples. Those narrow intervals are artifacts, not precision.
  - Hanley–McNeil 95% half-width at AUROC 0.9 with 80 clean cases: 1 violation ±0.41, 2 ±0.29,
    3 ±0.24, 5 ±0.18, 10 ±0.13, 20 ±0.09, 40 ±0.07, 60 ±0.06. Subsampling the three best-populated
    policies (pooled dev+test) gives a tighter empirical spread: ±0.13–0.19 at 3–5 violations,
    ±0.05–0.09 at 10, ±0.03–0.07 at 15 (an underestimate, because it draws from a finite pool).
    13 of 17 test policies have ≤ 4 clear violations, so their half-width is ≥ ±0.2 by the analytic bound.
  - Comparing strategies: production vs. `chunk=0` is outside noise pooled on dev (AUROC +0.029 to
    +0.070) but not on test (−0.025 to +0.079). Per policy, the paired interval excludes 0 for 1 of 17
    policies on dev and **0 of 14** on test (3 have no violation).
- **Conclusion**: supported in substance, though the width criterion as written fails (7 < 10), because
  the percentile bootstrap is unreliable with 1–2 positives. The test split cannot compare strategies
  per policy and only barely pooled. Target for the corpus: **≥ 20 clear violations per policy per
  split** (about ±0.06–0.09 half-width), so test needs about 280 more clear semantic violations,
  mostly for the 13 policies with ≤ 4. Per-policy intervals in eval reports should use a method that
  doesn't collapse at small n, or report n next to them.
- **Re-score (2026-10-21, relabeled gold; cached answers)**: test violations per policy are now 0
  (separate-decisions, thin-entry-points, cohesive-modules), 1 (names-match-behavior), 2
  (explicit-dependencies, single-responsibility, protect-internal-state, test-behavior), 3
  (no-flag-parameters, descriptive-test-names), 4 (preserve-error-context, minimal-public-surface), 5
  (duplicated-knowledge), 9 (intent-revealing-names, abstraction-level, magic values), 11 (comments).
  Width > 0.3 or undefined: 8 of 17 (was 7); 12 policies have ≤ 4 violations. Production vs.
  `chunk=0`: per policy 1 of 17 dev and 0 of 14 test intervals exclude 0; pooled dev +0.022 to +0.061,
  test −0.005 to +0.077. Test needs 274 more violations to reach 20 per policy. Conclusion unchanged.

## H2: an LLM labeler reproduces adjudicated gold

- **Hypothesis**: a labeler from a different model family than Clef, given the policy text and the
  file, agrees with adjudicated gold on clear cases about as well as the original blind labelers agreed
  with each other (κ 0.80).
- **Prediction**: Cohen's κ ≥ 0.6 between labeler and gold over clear cases (violates vs. clean), with
  violation recall ≥ 0.7; it will be worse on the thin architecture/encapsulation policies.
- **Method**: blind labeler prompt (policy, numbered file, answer label + lines + note), run on a sample
  of existing cases stratified so every clear violation is included plus an equal number of clean cases;
  compute κ, recall, precision, per policy. Disagreements are reviewed to see whether gold or labeler
  erred.
- **Result** (2026-10-20). Setup: one request per file with every matching semantic policy (the
  efficient shape for labeling new files), structured output (label, lines, note), blind to gold, all
  101 semantic files. Labelers: Claude (`completion` model `default`) and `openai-codex/gpt-6.1-sol`
  (reached by setting `modelRoles.slow` to it for this session only, with approval, and restoring `{}`
  afterward; completion() records no model id, so routing rests on that setting). 0 failures; about
  0.56M input tokens for gpt-6.1-sol. **Confound found first**: the existing gold was produced and
  adjudicated by `claude-opus-5-5` subagents (session `01a155fb`, agents `SemB*`, `SecondN*`,
  `Ambiguity*`, `Adjudicate*`), so the Claude labeler checks *reproducibility* of gold and gpt-6.1-sol
  is the cross-family check. Raw labels: `evals/.cache/research/labels/<model>/<file>.json`.

  | Labeler vs. gold, clear cases | Cases | κ | Recall | Precision |
  |---|---|---|---|---|
  | Claude | 1,478 | 0.767 | 0.759 (126/166) | 0.829 |
  | gpt-6.1-sol | 1,479 | 0.512 | 0.964 (160/166) | 0.423 (160/378) |
  | Claude vs. gpt-6.1-sol | 1,478 | 0.403 | – | – |

  - Claude κ by origin: real 0.717, planted 0.815, synthetic 0.942. Lowest per policy:
    `minimal-public-surface` 0.56 (recall 0.4), `comments-explain-why` 0.57 (recall 0.54). Of gold's 76
    ambiguous cases, Claude called 21 violations.
  - gpt-6.1-sol κ by origin: real 0.495, synthetic 0.536, planted 0.458. It called 61 of the 76
    ambiguous cases violations. Highest per policy: comments 0.81, no-flag-parameters 0.76,
    names-match-behavior 0.76. Lowest: explicit-dependencies 0.22 (precision 0.17), magic values 0.27,
    single-responsibility 0.32.
  - Adjudication of all 224 clear disagreements between gold and gpt-6.1-sol (Claude `default`, blinded
    to which reviewer was gold, arguments in random order; all answered after retrying 4 schema
    failures; about 0.79M input tokens). Of the 218 violations only gpt-6.1-sol flagged: **113 clean
    (gold upheld), 69 ambiguous, 36 violations gold missed**. Of its 6 misses: 2 upheld for gold, 2
    ambiguous, 2 clean.
  - The adjudicator shares gold's family and leans toward gold, so 36 + 69 of 218 going against gold
    is a conservative count. If the 36 hold up, gold has about 22% more clear semantic violations than
    its 166, which means one Claude pass's recall vs. *truth* is below the 0.76 measured against gold.
  - Spot check of one adjudicated "gold miss" (rgo-20, Go `%v` instead of `%w` when wrapping, lines
    111 and 161): the message keeps the cause's text but drops the error chain; I read it as ambiguous
    under the rule, not a clear miss; both models called it a violation, so it was applied as one.
  - Queue triage (local, no model calls): a "likely miss" was applied as `violates` (gpt-6.1-sol's
    lines and note) when gold's note names none of the identifiers or lines gpt-6.1-sol flagged, i.e.
    gold never considered that code; all 71 adjudicated `ambiguous` were applied as `ambiguous` with
    both readings in the note. Twins whose flagged text is identical and whose gold matched got the
    same change. That applied 98 labels. The remaining 20 (gold's note discusses the flagged code) were
    decided by the rule that where gpt-6.1-sol and the Claude adjudicator agree, their verdict replaces
    gold; they agreed on all 20 (18 violates, 2 complies), plus 1 twin. **Total: 119 labels changed**
    (39 complies → violates, 76 complies → ambiguous, 2 violates → ambiguous, 2 violates → complies;
    `evals/.cache/research/relabel-applied.json`); `bun evals/validate.ts --require-splits` passes and
    nothing is left for review.
  - After the relabel, clear semantic violations: real 137, planted 38, synthetic 26; semantic
    ambiguous cases 154 of 1,555. Each hypothesis below has a "Re-score" bullet with its numbers against this gold.
- **Conclusion**: prediction holds for the Claude labeler (κ 0.767 ≥ 0.6, recall 0.76 ≥ 0.7) and the
  thin-policy part is partly right (minimal-public-surface is worst; architecture is fine). It fails
  for gpt-6.1-sol (κ 0.51): it over-flags (precision 0.42) but catches nearly every gold violation
  (recall 0.96). Decisions:
  1. New files are labeled by the Claude labeler with the policies-per-file prompt; gpt-6.1-sol labels
     them independently as the second model; disagreements go to adjudication. A single Claude pass
     misses about a quarter of gold's violations, and gpt-6.1-sol's recall covers that gap.
  2. gpt-6.1-sol is not a labeler on its own: most of its extra flags are upheld as clean or ambiguous.
  3. Gold is single-family and was missing violations. Where both models agree against gold, their
     verdict now replaces it (see Result); Clef's measured recall was understated wherever gold missed
     violations.

## H3: review comments yield real violations

- **Hypothesis**: PR review comments that cite a semantic concern, plus the commit that addressed them,
  give real violating/complying file pairs for the thin policies.
- **Prediction**: after keyword filtering, ≥ 20% of candidate comments map to a clear violation of one of
  our semantic policies in the commented file, and a few hundred comments per large repo give ≥ 5 usable
  pairs per thin policy across 5–10 repos.
- **Method**: `gh api` review comments for permissively licensed repos; filter by rule keywords; fetch the
  file at the comment's commit and after the fix; label with the H2 labeler; count yield per policy.
- **Result** (2026-10-20). Tool: `evals/mine.ts` (fetch, license check, keyword filter; raw pages cached in
  `evals/.cache/research/review/`). Then, in the research kernel: a Claude `default` classifier picked
  the one policy (or none) each top-level comment says the code breaks, given the comment and its diff
  hunk; the file was fetched at the comment's commit ("before") and at the PR's merge commit ("after");
  two independent Claude labeler passes (H2 prompt, target policy only) labeled each side. Funnel:

  | Stage | Count |
  |---|---|
  | Review comments fetched (12 repos × 1,000 newest) | 12,000 |
  | On a source file, not a bot | 9,820 → 7,909 |
  | Matched a policy keyword | 1,129 |
  | Top-level (not a reply) | 633 |
  | Classifier: comment says the code breaks a policy | 172 (27% of 633; 33 high, 112 medium, 27 low confidence) |
  | "Before" file fetched and ≤ 120 KB | 146 |
  | Both labeler passes: before violates the target policy | **51** (35% of 146) |
  | …with a violation within 3 lines of the commented line | 23 (12 of 26 high-confidence, 9 of 101 medium, 2 of 19 low) |
  | …and the PR merged and both passes call "after" compliant | **8 usable pairs** |

  - Enrichment: at gold's per-policy base rates for real files, 146 random real files with the same
    policy mix would hold about 31 violating files; the mined set holds 51 even under two-pass
    agreement, which is stricter than gold (one Claude pass recalls 0.76 of gold). So it's ≥ 1.65× random.
  - The concentration is in already-populated policies: no-duplicated-knowledge 23/47, comments 13/18.
    The six thinnest test policies got 5 clear violations in total (thin-entry-points,
    separate-decisions, cohesive-modules: 0).
  - 15 of 23 located violations come from PRs that were not merged (no "after" side). Mined files are
    large (median about 15 KB), which is the bin H9 says is underpopulated.
  - API cost is negligible (about 10 requests per 1,000 comments; 830 requests total, no rate limit).
    The cost is model calls: 1 classification per top-level comment plus 4 labels per candidate.
- **Conclusion**: refuted as stated. 51 of 1,129 keyword candidates (4.5%) are clear violations, not
  ≥ 20%, and no thin policy reached 5 usable pairs (8 pairs in total). Review mining roughly doubles
  the violation rate per labeled file, so it's a more efficient source of real violations than random
  files, but at about 4 clear violations per 1,000 comments, filling the thin policies (≈ 0.4 per 1,000
  comments) would take about 100k comments per policy. Use it as one source among several, for its
  real large files and located violations, not as the answer for thin policies. Keep the classifier's
  high-confidence cut (46% located) and drop replies.
- **Re-score (2026-10-21, relabeled gold)**: gold's real-file base rates rose, so 146 random files with
  the same policy mix would hold about 34 violating files; the mined 51 is **1.5×** random (was ≥ 1.65×).
  The mined labels themselves don't depend on corpus gold. Conclusion unchanged.

## H4: review-mined violations are harder than planted ones

- **Hypothesis**: Clef orders review-mined pairs correctly less often than planted pairs.
- **Prediction**: pair accuracy on mined pairs is lower than on planted pairs by ≥ 0.1.
- **Method**: score mined pairs with production; compare pair accuracy and violation scores with the
  existing planted pairs per policy.
- **Result** (2026-10-20). Production scores (semantic policies only; control policies left out of the
  requests, a small departure from run.ts) for the 146 mined "before" files and 83 "after" files:
  1,440 requests sent.
  - Mined clear violations (both passes): 51, mean 0.330. Planted (old 29 + new 32): 61, mean about
    0.43. Mined − planted: **−0.174 to −0.030**. Mined − real corpus violations: −0.039 to +0.072
    (same difficulty); for files > 9 KB only: 0.329 vs. 0.323 (−0.055, +0.067).
  - Within the mined pool (target policy; 51 violating vs. 89 labeled clean by both passes, the clean
    ones being code a reviewer flagged), AUROC 0.734, below the real-corpus 0.802: hard negatives.
  - Mined pairs ordered correctly: 8 of 8 (too few to compare with planted's 84%).
- **Conclusion**: supported on scores (mined violations score 0.03–0.17 lower than planted), not
  testable on pair accuracy (8 pairs). Mined violations match the difficulty of the existing real ones
  (difference within ±0.07), so they're a faithful way to grow `real`, and the reviewer-flagged files
  labeled clean are useful hard negatives.
- **Re-score (2026-10-21, relabeled gold)**: planted violations now 38 + 32 LLM plants, mean 0.401;
  mined − planted **−0.143 to −0.000**; mined − real corpus (137 violations) −0.021 to +0.090; files
  > 9 KB: 0.329 vs. 0.310 (−0.039, +0.080). Still lower than planted, but now at the edge of noise.

## H5: Clef-based candidate sampling is biased

- **Hypothesis**: if new violating files are found by pre-screening with Clef, the corpus over-represents
  violations Clef already scores high.
- **Prediction**: of clear violations found by an independent sampler (another model's pre-screen), Clef
  scores at least a third below its review floor.
- **Method**: pool of unlabeled OSS files; pre-screen with both Clef and the H2 labeler; label the union;
  compare Clef recall on violations found only by the independent sampler.
- **Result** (2026-10-20). Method changed: instead of a second model's pre-screen, the independent
  samplers are the existing gold (real files) and the H3 mined pool labeled by two Claude passes; both
  are chosen without Clef. A Clef pre-screen is simulated as keeping cases scored above the review
  floor (0.3). Caught = scored ≥ 0.45 (production threshold).

  | Pool | Clear violations | Clef ≤ 0.3 (dropped by pre-screen) | Caught, true | Caught, measured on pre-screened corpus | Violation rate before → after pre-screen |
  |---|---|---|---|---|---|
  | Real corpus, semantic | 119 | 67 (56%) | 19% | 44% | 14% → 43% |
  | Real corpus, 9 thin policies | 36 | 16 (44%) | 33% | 60% | 7% → 29% |
  | Mined pool, target policy | 51 | 30 (59%) | 25% | 62% | 36% → 66% |

  - Clear-case AUROC on real files falls from 0.802 to 0.631 if only pre-screened cases are kept.
- **Conclusion**: supported (44–59% of violations score below the floor, above the predicted third). A
  Clef pre-screen triples or quadruples violations per labeled file, so it's the most efficient
  sampler here, but a corpus built from it would report about 2× Clef's true catch rate and lose the
  violations Clef misses, which are what we most need to measure. If used, pre-screen as a stratified
  sample: label a known fraction of files below the floor too and weight by inverse sampling fraction.
  Record the sampling stratum on each file.
- **Re-score (2026-10-21, relabeled gold)**: real corpus, semantic: 137 violations, 84 (61%) at or below
  the floor; caught 16% true vs. 42% on a pre-screened corpus; violation rate 17% → 54%. Thin 9
  policies: 42 violations, 21 (50%) dropped; 29% vs. 57%; 9% → 39%. AUROC 0.804 → 0.624 if only
  pre-screened cases are kept. Conclusion unchanged; the bias is slightly larger.

## H6: real-world rule wording changes quality

- **Hypothesis**: rules written the way users write them (one terse line, or a style guide's own text)
  score worse than our polished policies on the same gold.
- **Prediction**: terse one-line variants lower semantic AUROC on dev by ≥ 0.03 and raise false alarms on
  exemption cases (gold notes that cite an exemption).
- **Method**: variant policy directories with the same names and globs; score dev with production
  through an eval-only policies directory option; paired bootstrap vs. the corpus policies.
- **Result** (2026-10-20). Two variant policy directories, same names, globs, and controls, so request
  packing matches; all 101 semantic files scored with production (265 requests each). False alarm =
  clean case scored ≥ 0.45; caught = violation scored ≥ 0.45.
  1. **Terse**: each semantic policy replaced by one line as users write them in AGENTS.md
     (e.g. "Don't use boolean flag parameters.", "No magic numbers.", "Use descriptive names.").

  | Split | AUROC polished → terse (paired interval) | False alarms | Caught |
  |---|---|---|---|
  | dev | 0.871 → 0.822 (−0.092, −0.010) | 1.3% → 4.9% | 27% → 38% |
  | test | 0.835 → 0.791 (−0.079, −0.004) | 1.4% → 7.2% | 31% → 36% |

     - The 42 `complies` cases whose gold note cites an exemption or intrinsic reason: mean score 0.27 →
       0.35, flagged 5 → 10.
     - Largest per-policy drops: minimal-public-surface 0.865 → 0.589, intent-revealing-names 0.945 →
       0.703, separate-decisions 0.900 → 0.770 (false alarms 0% → 30%), comments 0.861 → 0.742.
  2. **Style-guide text**, verbatim, for the three policies with a close published equivalent: PEP 8
     on comments, Google TypeScript Style Guide "Descriptive names", Uber Go Style Guide "Error
     Wrapping" (Apache-2.0). AUROC polished → source: comments 0.861 → 0.800 (−0.130, +0.005);
     naming **0.945 → 0.707 (−0.436, −0.071)**; errors 0.906 → 0.965 (−0.016, +0.161). Caught falls for
     errors (50% → 17%). Uber's text explicitly allows `%v`, which also supports reading the H2 rgo-20
     case as ambiguous.
  - Caveat: gold was labeled against the polished text. A terse or borrowed rule means something
    slightly different (it drops our exemptions and examples), so part of each drop is a change in the
    rule, not only Clef's reading of it.
  - The corpus policies are all paragraphs (56–124 words; the terse variants are 3–12). The README
    said "some are one-liners"; it was corrected.
- **Conclusion**: supported: terse wording costs about 0.045 AUROC on both splits (above the predicted
  0.03) and raises false alarms about 4–5×, concentrated on exemption cases. Real-world wording is a
  distinct axis the corpus doesn't cover. Since users bring their own wording, the eval should carry
  rule-wording variants as their own policy sets with their own gold (labels against *that* wording),
  and report quality per wording.
- **Re-score (2026-10-21, relabeled gold)**: terse vs. polished: dev 0.849 → 0.801 (−0.087, −0.010),
  false alarms 0.7% → 4.7%, caught 22% → 32%; test 0.834 → 0.776 (−0.089, −0.030), false alarms 1.3%
  → 5.9%, caught 24% → 30%. 34 exemption-cited `complies` cases: mean 0.261 → 0.351, flagged 3 → 9. Per
  policy: minimal-public-surface 0.912 → 0.665, intent-revealing-names 0.821 → 0.685,
  separate-decisions 0.937 → 0.729 (false alarms 0% → 29%), comments 0.820 → 0.783. Style-guide
  text: comments 0.820 → 0.801 (−0.087, +0.048); naming 0.821 → 0.694 (−0.276, +0.015), **now within
  noise**; errors 0.903 → 0.974 (**+0.008, +0.150**, now outside noise in the source text's favor),
  while caught falls 38% → 12%. The terse conclusion holds and is slightly stronger; the style-guide
  results are mixed and rule-specific.

## H7: planted violations overstate quality

- **Hypothesis**: violations planted by mechanical per-rule edits are easier for Clef than real ones.
- **Prediction**: for policies with both, the mean Clef score of planted violations exceeds that of real
  violations by ≥ 0.1.
- **Method**: compare existing planted vs. real violation scores per policy; then generate operator-planted
  twins, verify labels, and compare again.
- **Result** (2026-10-20).
  1. Existing corpus (cached production scores, clear violations): planted 29, mean 0.374; real 119,
     mean 0.315; synthetic 18, mean 0.679. Planted − real +0.059 (−0.015, +0.134); per policy, planted
     is higher in 8 of 14. Synthetic − real **+0.36 (+0.285, +0.439)**, and synthetic AUROC is 0.998
     vs. 0.857 planted and 0.802 real.
  2. New LLM-planted twins (`evals/.cache/research/plants/`): Claude `default` made one minimal edit
     (returned as a line-range replacement, median 19 lines) introducing a violation of one of the 9
     thinnest policies into 4 random real files per policy whose gold for that policy is `complies`
     (files < 20 KB). 36 made; both labeler passes confirmed 32, every one located on the edited lines;
     4 had 0/2 votes (rejected). Scored with production through the cached client (95 new requests;
     `evals/.cache/research/score.ts`, verified byte-for-byte against `run.ts`: 156 cached scores, 0
     differences).

  | Violations of the 9 thin policies | n | Mean score | Surfaced (> 0.3) | Caught (≥ 0.45) |
  |---|---|---|---|---|
  | Real | 36 | 0.390 | 56% | 33% |
  | Hand-planted (existing) | 15 | 0.469 | – | – |
  | LLM-planted (new) | 32 | 0.484 | 78% | 59% |

  - LLM-planted − real: +0.094 (+0.001, +0.189); against real violations in files < 20 KB, to match
    plant sources: +0.115 (+0.014, +0.215).
  - Twins ordered correctly (plant above its original): 27 of 32 (84%), mean lift +0.257.
    `minimal-public-surface` is the exception: plants average 0.25, and 1 of 3 twins is ordered.
- **Conclusion**: supported for new LLM plants (+0.09 to +0.12, interval excluding 0, near the
  predicted 0.1); not shown for the existing hand-planted twins. The bigger inflation is synthetic files:
  they are almost perfectly separable, so pooled "all origins" numbers overstate real-code quality. LLM
  planting is cheap (3 model calls per verified twin, 89% confirmed) and is the only source here that
  fills thin policies on demand, so use it, but keep `planted` separate and never pool it with `real`
  for headline numbers, and don't add more `synthetic` files.
- **Re-score (2026-10-21, relabeled gold)**: existing corpus: planted 38 (mean 0.331), real 137 (0.297),
  synthetic 26 (0.538). Planted − real −0.032 to +0.102; synthetic − real **+0.135 to +0.343** (was
  +0.36); AUROC synthetic 0.921 (was 0.998), planted 0.822, real 0.804. Real thin-policy violations: 42,
  mean 0.369, surfaced 50%, caught 29%. LLM plants − real thin: **+0.022 to +0.208**; vs. real < 20 KB
  (29, mean 0.352): +0.035 to +0.231. One plant source (rgo-14, single-responsibility) is now
  `ambiguous` in gold, not `complies`. Conclusion holds: LLM plants run about 0.1 easier; synthetic
  files remain the larger inflation, though less extreme than before the relabel.

## H8: memorization of famous repos

- **Hypothesis**: Clef's quality is higher on files from very popular repos.
- **Prediction**: no measurable difference given current sample sizes (stated as the null; a large gap
  would be the surprise).
- **Method**: split real cases by repo stars (top third vs. rest), compare AUROC with a bootstrap.
- **Result** (2026-10-20; cached production scores; real files only; stars from `gh api repos/<repo>` today):
  top third by stars (≥ 78k: VS Code, Excalidraw, Kubernetes, Supabase, FastAPI, Home Assistant, Django,
  Hugo, gin, fzf, caddy) has 21 files and 49 clear violations, AUROC 0.802; the rest (38 files, 70
  violations) 0.801. Difference −0.093 to +0.086. Within size bins: small 0.821 vs 0.820, mid 0.809 vs
  0.764, large 0.787 vs 0.781.
- **Conclusion**: null not rejected, but the test is weak: the interval is ±0.09, and the "rest" are
  popular too (only 4 of 31 repos have under 5k stars). This cannot rule out memorization. A decisive
  test needs code Clef cannot have seen: files from commits after its training cutoff, or small repos.
  New real files should prefer recent commits, and record the commit date so this can be re-run.
- **Re-score (2026-10-21, relabeled gold)**: famous 21 files, 58 violations, AUROC 0.800; rest 38
  files, 79 violations, 0.805; difference −0.080 to +0.074. Conclusion unchanged.

## H9: size no longer predicts quality with excerpts

- **Hypothesis**: production (excerpts above 4 KB) removes the size effect seen with whole files.
- **Prediction**: AUROC for files above 9 KB is within 0.05 of files under 4 KB under production, while
  `chunk=0` keeps the earlier 0.90 vs 0.74 gap.
- **Method**: bin cached production and `chunk=0` scores by file size; bootstrap the difference.
- **Result** (2026-10-20; cached scores from H1, all splits, semantic; sizes in bytes; 95% bootstrap over
  files):

  | Bin | Files | Clear violations | AUROC production | AUROC `chunk=0` | Clean mean score (prod / chunk=0) | Violation mean score (prod / chunk=0) |
  |---|---|---|---|---|---|---|
  | < 4 KB | 40 | 33 | 0.915 | 0.915 | 0.12 / 0.12 | 0.465 / 0.465 |
  | 4–9 KB | 31 | 49 | 0.828 | 0.834 | 0.16 / 0.13 | 0.356 / 0.319 |
  | > 9 KB | 30 | 84 | 0.789 | 0.734 | 0.19 / 0.14 | 0.330 / 0.261 |

  - Large − small AUROC: production −0.209 to −0.046; `chunk=0` −0.271 to −0.093. Both exclude 0.
  - Excerpts still help on large files: production − `chunk=0` +0.030 to +0.081.
  - Not a policy-mix artifact: within-policy large − small AUROC is negative for 14 of 16 policies
    with cases in both bins (mean −0.113 production, −0.146 `chunk=0`).
  - Mechanism: under production, clean cases in large files score higher (0.12 → 0.19), consistent with
    taking the highest of many excerpt scores, while violations still score lower (0.465 → 0.330).
- **Conclusion**: refuted. Excerpts shrink the size effect by about a quarter, but files above 9 KB are
  still about 0.13 AUROC worse. Half of the corpus's clear violations (84 of 166) sit in 30 large files,
  so pooled numbers depend heavily on size mix; reports should break results out by size, and new data
  should be sampled by size. Product follow-up (not an eval change): taking the highest score across
  more excerpts inflates clean scores, so a correction for the number of excerpts may be worth testing.
- **Re-score (2026-10-21, relabeled gold)**:

  | Bin | Files | Clear violations | AUROC production | AUROC `chunk=0` | Clean mean (prod / chunk=0) | Violation mean (prod / chunk=0) |
  |---|---|---|---|---|---|---|
  | < 4 KB | 40 | 42 | 0.868 | 0.868 | 0.117 / 0.117 | 0.404 / 0.404 |
  | 4–9 KB | 31 | 61 | 0.812 | 0.805 | 0.151 / 0.126 | 0.323 / 0.287 |
  | > 9 KB | 30 | 98 | 0.795 | 0.758 | 0.176 / 0.131 | 0.312 / 0.249 |

  - Large − small: production **−0.150 to +0.005** (now includes 0); `chunk=0` −0.194 to −0.027.
    Production − `chunk=0` on large files +0.012 to +0.064. Within policy, large − small is negative
    for 10 of 16 policies (mean −0.058) under production, 13 of 16 (−0.075) under `chunk=0`.
  - Most of the change is in small files: the relabel added 9 clear violations there that Clef scores
    low, so small-file AUROC fell 0.915 → 0.868.
  - Conclusion revised: **inconclusive**. The size effect under production shrank to about −0.07 and
    is no longer outside noise; the whole-file effect still is. Keep sampling and reporting by size;
    the excerpt-count follow-up is weaker evidence than it was.

## H10: sampled real files carry violations at the curated rate

- **Hypothesis**: files drawn at random (`evals/sample.ts`: 99 permissively licensed repos from GitHub
  search, three star tiers × three languages, pushed after 2026-09-15; up to 3 files per repo, 30% test
  files, size bins drawn uniformly) carry clear semantic violations at about the rate of the curated
  real files.
- **Prediction** (written before labeling): clear semantic violations per file within 0.5×–2× of the
  curated rate (137 in 59 files, 2.3 per file), and for the 9 thin policies within 0.5×–2× of 0.71 per
  file. Sampled files skew toward newer and smaller projects, so the rate leans higher, not lower.
- **Method**: label every new file with the H11 protocol; compare per-file rates with a bootstrap
  over files.
- **Result** (2026-10-21). 291 files sampled from 99 repos; 2 skipped (CRLF line endings), 1 dropped
  because the Claude labeler refused it (a trading bot's bridge module, usage-policy refusal), 288
  ingested (146 dev, 142 test, split by repo within language × star tier). 249 of 291 were last changed
  in 2026. Clear semantic violations per file, 95% bootstrap over files of the ratio:

  | Source | Files | Per file | vs. curated | Thin 9 policies per file | vs. curated |
  |---|---|---|---|---|---|
  | Curated | 59 | 2.32 | – | 0.71 | – |
  | Sampled | 288 | 2.05 | 0.88× [0.68, 1.17] | 0.81 | 1.14× [0.74, 1.91] |
  | Mined (H3 source, high-confidence comments) | 104 | 4.04 | 1.74× [1.34, 2.31] | 1.69 | 2.4× [1.55, 4.04] |

  - Sampled rate by size: 0.74 per file under 4 KB, 1.74 at 4–9 KB, 3.95 above 9 KB.
  - Mined: 130 high-confidence top-level comments from 2,229 top-level candidates across 45 repos
    (12 from H3 plus 33 of 36 new; 3 skipped for license NOASSERTION); 104 distinct files after dropping
    repeats, non-Go/Python/TypeScript files and files above 100 KB. The file breaks the comment's policy
    in 68 of 104 (65%).
- **Conclusion**: supported. Random files carry violations at the curated rate, including the thin
  policies, so random sampling is a usable source for every policy but cohesive-modules (5 violations in
  288 files). Mined files carry about 1.7× as many per file because they are large.

## H11: the two-model protocol on new files

- **Hypothesis**: on files the protocol has never seen, Claude and gpt-6.1-sol disagree about as often
  as in H2, and adjudication resolves gpt-6.1-sol's extra flags in similar proportions.
- **Prediction**: Claude vs. gpt-6.1-sol κ on clear labels between 0.3 and 0.5 (H2: 0.40); of
  violations only gpt-6.1-sol flags, 35–60% are adjudicated violates or ambiguous (H2: 105 of 218, 48%).
- **Method**: Claude (`default`) and gpt-6.1-sol (`slow` mapped for the session) each label every
  matching policy of every new real file (one request per file); disagreements on violates vs. clean
  go to a blinded Claude adjudicator (H2 prompt, arguments in random order). Agreement of two of the
  three is gold; an adjudicated `ambiguous` is `ambiguous`. Prompts: `evals/.cache/research/pipeline.py`.
- **Result** (2026-10-21; 0 label failures after retries, 1 refusal):

  | Files | Semantic cases | κ (Claude vs. gpt-6.1-sol) | Violations flagged: Claude / gpt-6.1-sol | gpt-only flags → violates / ambiguous / clean | Claude-only flags → violates / ambiguous / clean |
  |---|---|---|---|---|---|
  | Sampled, 288 | 4,446 | 0.501 | 451 / 986 | 576 → 177 / 183 / 216 (62.5% upheld or ambiguous) | 41 → 4 / 14 / 23 |
  | Mined, 104 | 1,590 | 0.444 | 282 / 622 | 360 → 151 / 120 / 89 (75.3%) | 20 → 7 / 5 / 8 |
  | Wording sets, 101 files × 3 | – | – | – | 991 disagreements adjudicated | – |

  - Source of the semantic gold on sampled and mined files: 5,039 cases where the two labelers agree,
    339 adjudicated violates, 336 adjudicated clean, 322 adjudicated ambiguous.
  - Spot check of 3 random adjudicated-violates cases: `data` holding a parsed shortcut file (graphify),
    a 50-line function's `param: RestartFromStep` (workers-sdk), and a photo-URL rule repeated word for word
    in three GAM methods. All three fit the rule as written.
  - Post-hoc check (not predicted; prompted by sampled files scoring much higher than curated ones, see
    H15 and README): the protocol was applied to the 59 curated real files using the H2 Claude and
    gpt-6.1-sol labels plus 236 new adjudications. Its gold agrees with the existing gold on 128 of 137
    violations (9 → ambiguous), contradicts one clear label (clean → violates), and turns 40 ambiguous
    cases into violations. Clef's AUROC on curated files is 0.804 against existing gold and 0.809
    against protocol gold (paired difference −0.014 to +0.025). So the protocol doesn't make Clef
    look better; the sampled-vs-curated gap is in the files.
- **Conclusion**: mostly as predicted. κ sits at the top of the predicted range (0.50 sampled, 0.44
  mined). The adjudicator upholds or calls ambiguous more gpt-only flags than predicted (63–75% vs.
  35–60%), so on new files Claude alone would miss more violations than H2 suggested. Keep gpt-6.1-sol
  as the second labeler. Claude-only flags mostly fail (4 of 41 upheld on sampled files).

## H12: LLM plants at scale

- **Hypothesis**: H7's finding (LLM plants score about 0.1 above real violations) holds with many more
  plants, verified by both model families.
- **Prediction**: plants confirmed by both Claude and gpt-6.1-sol on the edited lines: 80–95% (H7: 89%
  with two Claude passes). Mean production score of plants − real violations of the same policies:
  +0.05 to +0.15, interval excluding 0.
- **Method**: one twin per unpaired real host whose gold for the policy is `complies`, hosts drawn across
  size bins, as many per policy and split as needed to reach 20 clear violations; the H7 plant prompt;
  verified by a full Claude labeling pass on the twin and gpt-6.1-sol on the target policy plus any policy
  the edit touched; the twin's other labels are its host's, shifted past the edit.
- **Result** (2026-10-21). Gap after adding sampled and mined files: 89 violations in 10 policy–split cells.
  142 plant attempts (1.4× the gap plus one per cell, 3 more for protect-internal-state test); 119
  confirmed by both models on the edited lines (**84%**). Of the 23 rejected, both models missed the
  violation in 9, only Claude in 10, only gpt-6.1-sol in 4. 55 of the 119 kept edits touched other
  policies' lines (112 cases); those went through the protocol (93 agree, 4 adjudicated violates, 7
  adjudicated clean, 8 ambiguous). Plants:
  cohesive-modules 45, thin-entry-points 25, test-behavior 24, names-match-behavior 11,
  protect-internal-state 7, descriptive-test-names 6, separate-decisions 1.

  | Production scores, same 7 policies | n | Mean | Surfaced (> 0.3) | Caught (≥ 0.45) |
  |---|---|---|---|---|
  | LLM plants | 119 | 0.501 | 85% | 58% |
  | Real violations | 192 | 0.400 | 64% | 39% |

  - Pooled plants − real: **+0.059 to +0.142**. Weighted by the plants' policy mix (per-policy
    differences): **+0.033 (−0.020, +0.085)**. Per policy: thin-entry-points 0.552 vs. 0.517,
    cohesive-modules 0.427 vs. 0.438, test-behavior 0.615 vs. 0.579, names-match 0.580 vs. 0.451,
    protect-internal-state 0.452 vs. 0.247, descriptive-test-names 0.274 vs. 0.348.
  - Twins scored above their host on the target policy: 116 of 119 (97.5%).
- **Conclusion**: confirmation rate as predicted (84%). The pooled score gap is as predicted and
  outside noise. With policies matched it is +0.03 and within noise, so most of H7's +0.1 was which
  policies got planted, not how. Keep plants as `planted`: the matched gap is not ruled out, and pair
  ordering at 97.5% is far easier than ranking across files.

## H13: wording with wording-matched gold

- **Hypothesis**: H6's quality loss under terse and borrowed wording is not only a change in what the
  rule means: it remains when gold is labeled against each wording's own text.
- **Prediction**: on the 101 original semantic files, terse AUROC is 0.02–0.05 below polished (H6:
  0.045 against polished gold), and terse false alarms at least 2× polished.
- **Method**: wording sets in `evals/corpus/wordings/` (terse; style-guide text; rules from OSS projects'
  AGENTS.md and contributor docs), gold labeled against each set with the H11 protocol, production
  scores per set, paired bootstrap against polished on the same cases.
- **Result** (2026-10-21; `bun evals/wordings.ts --split all|dev|test`; style-guide and agents-md sets
  collected by a subagent with verbatim quotes, pinned permalinks and licenses in `sources.json`;
  agents-md omits names-match-behavior: the only matching rules found were in unlicensed or copyleft repos). False alarms here are clean
  cases given `review` or `violation` (`quality().falseAlarms`), not H6's ≥ 0.45:

  | Set | Split | Clear violations (polished → set) | AUROC polished → set [paired] | False alarms | Caught |
  |---|---|---|---|---|---|
  | terse | dev | 135 → 187 | 0.849 → 0.853 [−0.037, +0.050] | 4.1% → 13.8% | 22% → 37% |
  | terse | test | 66 → 106 | 0.834 → 0.833 [−0.055, +0.048] | 7.2% → 13.9% | 24% → 34% |
  | style-guide | dev | 135 → 180 | 0.849 → 0.819 [−0.066, +0.009] | 4.1% → 11.6% | 22% → 29% |
  | style-guide | test | 66 → 104 | 0.834 → 0.805 [−0.080, +0.021] | 7.2% → 12.7% | 24% → 29% |
  | agents-md | dev | 129 → 198 | 0.847 → 0.801 [**−0.089, −0.002**] | 3.9% → 19.4% | 22% → 26% |
  | agents-md | test | 65 → 124 | 0.832 → 0.827 [−0.055, +0.046] | 7.1% → 18.1% | 25% → 27% |

  - Each wording's gold has 41–66% more violations than polished gold: rules without our exemptions
    forbid more. Per-policy n is small here (101 files), so per-policy rows are in `wordings.ts` output
    only. The largest per-policy drops follow vague wording: terse minimal-public-surface (8 → 2
    violations, AUROC 0.912 → 0.495), agents-md intent-revealing-names (0.821 → 0.463, 7 violations).
- **Conclusion**: refuted for terse ranking: once gold follows the terse text, AUROC is unchanged, so H6's
  0.045 loss was a change in what the rule means. Borrowed wordings lose about 0.03 (one split's interval
  excludes 0). The false-alarm half of the prediction holds for every set (2.3–3.7×). For users, wording
  mostly moves the cut-offs (more `review` on clean code), not Clef's ranking.
- **Re-score (2026-10-21, wording gold extended to all 511 newer semantic files; `wordings.ts --origin
  real`, 451 real files)**: terse dev 0.863 → 0.866 [−0.014, +0.019], test 0.870 → 0.864 [−0.024,
  +0.013]; style-guide dev 0.863 → 0.835 [−0.045, −0.012], test 0.870 → 0.835 [−0.052, −0.017];
  agents-md dev 0.867 → 0.845 [−0.038, −0.005], test 0.874 → 0.851 [−0.040, −0.006]. False alarms 7–8%
  → 12–18%; violations in each set's gold +23–41%. Terse conclusion holds with narrower intervals; the
  borrowed-wording loss is now outside noise on both splits, so borrowed rules cost ranking quality,
  not only cut-off shifts. Labeling: 1,533 Claude and 1,533 gpt-6.1-sol requests, 4,246 adjudications.

## H14: memorization, retested

- **Hypothesis**: Clef scores famous or older code better than code it cannot have trained on.
- **Prediction**: null: AUROC difference within ±0.05 between files from repos under 1k stars and
  above 20k, and between files last changed before and after 2026-07-01, with intervals narrower than
  H8's ±0.09.
- **Method**: real files only, production scores, bootstrap over files; strata from provenance.
- **Result** (2026-10-21, all splits, semantic, real files): sampled files from repos ≥ 20k stars
  (97 files) 0.876 vs. < 1k stars (92 files) 0.908: famous − small **−0.032 [−0.069, +0.006]**. Real files
  last changed before 2026-07-01 (152 files, 350 violations) 0.876 vs. after (299 files, 798
  violations) 0.861: before − after +0.015 [−0.012, +0.043]. Within sampled files only: +0.034
  [−0.001, +0.066].
- **Conclusion**: null not rejected, with intervals of about ±0.04 (H8: ±0.09). If famous code helps,
  the effect is below about 0.01 AUROC; older code may score a little better (within sampled files the
  interval just reaches 0), which is the direction memorization predicts but is confounded with project.

## H15: size effect, retested

- **Hypothesis**: under production, files above 9 KB still score worse than files under 4 KB.
- **Prediction**: large − small AUROC between −0.10 and −0.03, with an interval that excludes 0 now that
  the real corpus is several times larger.
- **Method**: H9's bins on real files only, production scores, bootstrap over files.
- **Result** (2026-10-21, all splits, semantic, real files, production): < 4 KB 133 files, 108 violations,
  AUROC 0.897 [0.862, 0.926]; 4–9 KB 146 files, 293 violations, 0.811 [0.782, 0.838]; > 9 KB 172 files,
  747 violations, 0.836 [0.817, 0.853]. Large − small **−0.061 [−0.095, −0.023]**. Within policy, large −
  small is negative for 14 of 17 policies (mean −0.033). Clean cases score 0.111 / 0.157 / 0.183 by bin,
  violations 0.319 / 0.326 / 0.359.
- **Conclusion**: supported, and H9's "inconclusive" resolves to a real but modest effect. The mechanism
  is the one H9 found: clean cases in large files score higher (more excerpts, highest score kept). The
  middle bin is lowest, so the effect is not monotonic in size.

## Identification rates (H16–H20)

Production surfaces 63% of clear violations on test (review or violation) and calls 42% `violation`, at 10%
of clean cases not passed. H16–H20 look for what would raise those rates. These five were exploratory: no
prediction was written before running them, so read them as a search on dev with test as confirmation.
Metric: AUROC, and TPR@k%: the share of clear violations scored above the score that flags k% of clean
cases (the caught rate at a fixed false-alarm rate, free of any one pair of cut-offs). Real files,
semantic policies, 95% paired bootstrap over files. Scripts and per-case scores:
`evals/.cache/research/ident/` (`shapes.ts`, `aggregate.ts`, `calibrate.ts`, `context-cal.ts`,
`examples-cal.ts`, `selectors.ts`, `matched.ts`, `verdicts.ts`, `out/`).

## H16: where production's misses are

- **Question**: which policies hold the misses, and is the excerpt aggregation (`max`) losing them?
- **Result** (cached production answers, 0 requests): at the score that flags 10% of clean cases (0.273
  dev, 0.279 test), TPR is 0.571 dev / 0.628 test.
  - Misses concentrate: comments-explain-why misses 95% of its violations on both splits and is 30–31% of
    all misses; then no-duplicated-knowledge (13%), intent-revealing-names (12–14%), magic values (10% on
    dev). Comments violations average 0.176, below the clean mean of four other policies
    (single-responsibility clean cases average 0.221).
  - Pooled AUROC 0.863 dev / 0.870 test vs. violation-weighted within-policy AUROC 0.898 / 0.900: a
    third of the ranking loss is policies sitting on different score scales under one pair of cut-offs.
  - Aggregation over excerpts: `max` is best or tied. Mean −0.06, noisy-OR −0.007 to −0.023, logit `max`
    minus a penalty per excerpt −0.03 to −0.09, top-2 mean −0.003 to −0.006; `max` + ½ second-highest
    +0.003 dev [−0.001, +0.008], +0.008 test [+0.004, +0.012]. In excerpted files the highest excerpt
    holds the gold lines in 69–70% of violations.
  - Duplicated knowledge whose copies sit in different excerpts scores like duplication within one
    excerpt (dev: 0.312, n 39, vs. 0.318, n 27), so excerpting is not what hides it.
- **Conclusion**: two levers, ranked: per-policy scale (worth up to +0.035 AUROC if solved) and comments
  (a third of misses). Aggregation is not one.

## H17: per-policy offsets

- **Question**: can each policy's score scale be corrected without the corpus's labels?
- **Result**: offsets in logit space, per policy, applied before pooling.

  | Offset source | AUROC dev | TPR@10% dev | AUROC test | TPR@10% test |
  |---|---|---|---|---|
  | none (production) | 0.863 | 0.571 | 0.870 | 0.628 |
  | Clef on an empty file (contextual calibration) | 0.819 [−0.061, −0.030] | 0.525 | 0.826 [−0.057, −0.031] | 0.536 |
  | Clef on "N/A" | 0.833 | 0.534 | 0.825 | 0.533 |
  | other split's unlabeled scores, 90th percentile | 0.869 [−0.004, +0.017] | 0.630 | 0.878 [−0.001, +0.018] | 0.635 |
  | other split's clean cases, 90th percentile (labels) | 0.895 [+0.023, +0.040] | 0.697 | 0.905 [+0.028, +0.043] | 0.683 |
  | 3 labeled files per class from the other split (mean of 30 draws) | 0.895 | 0.683 | 0.901 | 0.683 |
  | 5 per class | 0.903 | 0.706 | 0.905 | 0.700 |

  - Content-free answers don't track the policy's clean-score level (descriptive-test-names: 0.41 on an
    empty file, clean 90th percentile 0.32–0.35).
  - On the H19 shape (1 KB excerpts), 2–3 examples per class hurt on average (AUROC 0.913 → 0.901–0.913)
    and 5 help (0.914 → 0.924 dev, 0.913 → 0.925 test, 24–27 of 30 draws).
- **Conclusion**: only labels fix the scale. A policy's `examples` could carry them (score the examples,
  center the policy between its clean and violating examples), but it needs about 5 example files per
  class to be safe, and gains less once H19's shape narrows the scale gap.

## H18: other request shapes and models

- **Question**: does any cheap change to production's request rank better? (Dev, 239 real files.)
- **Result**:

  | Variant | AUROC dev | TPR@10% dev | $ / 1k files |
  |---|---|---|---|
  | production | 0.863 | 0.571 | $4.56 |
  | `clef-omni` (new 2026-10-09, $0.15 / M tokens) | 0.784 [−0.098, −0.059] | 0.481 | $2.74 |
  | one policy per request (`batch=1`) | 0.850 [−0.024, −0.003] | 0.545 | $18.97 |
  | 2 KB excerpts | 0.864 [−0.007, +0.010] | 0.612 | – |
  | line numbers in the excerpt | 0.866 [−0.004, +0.010] | 0.581 | – |
  | the whole file's top-level lines as an `outline` | 0.861 [−0.009, +0.004] | 0.584 | – |
  | criteria without "complete" | 0.858 [−0.011, +0.001] | 0.571 | – |
  | policies in reverse order | 0.871 [−0.001, +0.017] | 0.614 | $4.56 |
  | mean of production and reverse order | 0.873 [+0.005, +0.015] | 0.599 | $9.12 |

  - Reversing the order moves each policy's mean logit by −0.16 to +0.37 with no trend by position, so
    order adds noise rather than a positional bias; averaging two orders removes some of it.
- **Conclusion**: refuted. Nothing cheap beats production by more than +0.01 AUROC; clef-omni is clearly
  worse.

## H19: the rule in the state, excerpts as questions

- **Question**: production puts the excerpt in the state and asks one question per rule. Selector items
  use the reverse (the rule in the state, one question per item) and rank far better (README). Does the
  reverse shape help whole-file policies?
- **Method**: per file and policy, one request: state = guidance ("Each question shows one excerpt of a
  file with its path and line range. Decide whether that excerpt contains at least one violation of the
  rule below.") + the rule; one `noul` question per excerpt (path with line range, then the text; the
  production criteria); a policy's score is its highest excerpt. Excerpts cut by `excerpts()`.
- **Result**:

  | Variant | AUROC dev | TPR@10% dev | AUROC test | TPR@10% test | $ / 1k files (dev / test) |
  |---|---|---|---|---|---|
  | production | 0.863 | 0.571 | 0.870 | 0.628 | $4.56 / $4.33 |
  | rule in state, 4 KB excerpts | 0.904 [+0.029, +0.052] | 0.673 | 0.906 [+0.024, +0.049] | 0.689 | $16.06 / $14.82 |
  | 2 KB | 0.910 [+0.035, +0.059] | 0.684 | 0.910 [+0.027, +0.054] | 0.724 | $17.84 / $16.50 |
  | 1 KB | 0.914 [+0.038, +0.063] | 0.704 | 0.913 [+0.030, +0.057] | 0.721 | $21.69 / $20.01 |
  | 500 B | 0.916 [+0.039, +0.067] | 0.740 | – | – | $29.27 |
  | 8 KB | 0.904 [+0.028, +0.053] | 0.661 | – | – | $15.21 |
  | 4 KB, one request per excerpt | 0.891 [+0.017, +0.040] | 0.617 | – | – | $18.95 |

  - 1 KB vs. 4 KB, paired: dev +0.010 [+0.003, +0.018], test +0.007 [+0.000, +0.014]. Judging a file's
    excerpts together beats one request each: −0.013 [−0.019, −0.006].
  - Within-policy AUROC rises 0.898 → 0.928–0.935, and with 4 KB excerpts 15 of 17 policies improve on
    dev; comments caught at 10% false alarms goes from 4 to 26 of 82. The pooled-vs-within gap (H16)
    stays about 0.02.
  - Terse wording, against its own gold (1 KB): dev 0.866 → 0.894 [+0.018, +0.040], test 0.864 → 0.897
    [+0.020, +0.045]. Control rules: dev 0.989 → 0.995 [−0.001, +0.016], test 0.979 → 0.985 [−0.004,
    +0.015].
  - Verdicts on test, cut-offs picked on dev so clean cases are flagged at production's rates (9.8% not
    passed, 2.7% `violation`):

    | Variant | Cut-offs | Caught | Surfaced | False alarms | Ambiguous → `review` | Verdict F1 |
    |---|---|---|---|---|---|---|
    | production | 0.275 / 0.375 | 42% | 63% | 10% | 27% | 0.533 |
    | 4 KB | 0.407 / 0.589 | 43% | 70% | 10% | 29% | 0.538 |
    | 1 KB | 0.478 / 0.615 | 46% | 72% | 10% | 22% | 0.535 |

    With F1-tuned cut-offs instead (1 KB, 0.45 / 0.575): caught 55%, surfaced 78%, false alarms 14%,
    F1 0.544 [−0.009, +0.036]. The gain is in surfacing (TPR@5–20%); at the strict `violation` rate
    (about 3% of clean cases) it is +1 to +4 points, because the cases Clef ranks highest among the clean
    are judgment calls (27 of the 80 highest clean test cases are single-responsibility).
- **Conclusion**: supported, and the largest gain found: AUROC +0.04 to +0.05 on both splits and both
  wordings, surfaced violations 63% → 70–72% at the same false-alarm rate, no loss on control rules.
  The cost is the shape: every policy re-reads the file, so tokens scale with policies × file size
  (3.5× production at 4 KB excerpts, 4.7× at 1 KB). Shipping it means re-tuning the file cut-offs
  (both rise, to about 0.4–0.48 / 0.59–0.62) and one request per file and policy.

## H20: selectors on the grown corpus

- **Question**: the README's selector gains were measured on the 112-file corpus. Do they hold on 451
  real files?
- **Method**: the corpus selector sets (`selectors`, `selectors-evidence`), production item shape; a
  file's score is its highest item score, mapped onto the file scale by the CLI's cut-off correspondence
  (item 0.5 / 0.65 ↔ file 0.275 / 0.375), so pooled numbers compare fairly. 3,334 + 2,566 + 217 dev
  items.
- **Result**:

  | Policy | AUROC dev: file → selector | AUROC test | Gold violation lines a selector item reaches (dev / test) |
  |---|---|---|---|
  | comments-explain-why | 0.850 → 0.949 | 0.788 → 0.942 | 97% / 95% |
  | explain-magic-values | 0.905 → 0.863 | 0.894 → 0.825 | 67% / 66% |
  | descriptive-test-names | 0.843 → 0.963 (20 violations) | 0.872 → 0.851 (16) | 88% / 100% |

  Pooled real semantic with these three judged by selector: AUROC dev 0.863 → 0.894 [+0.021, +0.042],
  test 0.870 → 0.891 [+0.011, +0.032]; TPR@10% 0.571 → 0.674 and 0.628 → 0.691.
- **Conclusion**: a selector is worth it when it reaches nearly every violation (comments); the
  magic-values selector reaches two thirds, so per-file judging beats it. For users: rules about
  individual comments, names, or tests should be selector policies, and their selector must cover the
  violation's lines.

## Synthesis: raising identification rates

1. **Change the file request shape (H19)**: the rule in the state and the file's excerpts as questions,
   one request per file and policy, excerpts of 1–4 KB, cut-offs re-tuned on dev. +0.04 to +0.05 AUROC on
   dev and test; at production's false-alarm rate it surfaces 70–72% of violations instead of 63%. It
   costs 3.5–4.7× production's tokens ($15–22 per 1,000 files vs. $4.5) and changes no CLI surface.
2. **Selector policies for item-shaped rules (H20)**: comments 0.79–0.85 → 0.94–0.95 AUROC. The CLI
   already supports this; the gain depends on the selector reaching the violating lines.
3. **Per-policy offsets from `examples` (H17)**: +0.03 AUROC on production with 3+ example files per
   class, but needs 5 per class on the H19 shape and asks users for whole-file examples. Lowest priority.
4. Not worth doing: other aggregation rules, clef-omni, one policy per request, line numbers, outlines,
   wording of the criteria (H16, H18).

## H21: a selector for every policy

- **Context**: product decision (2026-10-22): there is no default unit of judgment; every policy declares
  a `select` command. The excerpt path (H19) was removed from `src/`. Exploratory, no prediction written.
- **Method**: each corpus policy got a selector built for its rule, designed on dev only by four parallel
  agents (functions, module-level, snippets and errors, tests; steps in `evals/steps/`, structure via
  ast-grep), measured with the item shape and a file's score as its highest item score (0 with no
  items). Baseline: H19's 1 KB excerpt scores. Then confirmed once on test.
- **Result**: real semantic, test: file AUROC 0.913 → 0.930 [+0.006, +0.028], TPR@10% 0.721 → 0.797
  [+0.028, +0.120]; at the shipped cut-offs (0.5 / 0.65) caught 69%, surfaced 86%, false alarms 14% (H19
  at its cut-offs: 55%, 78%, 14%), $14–17 per 1,000 files (H19: $20–22). Dev 0.914 → 0.939. All test
  cases: F1 0.583 (H19: 0.571). Control rules 0.94–1.0. Per policy on test: minimal-public-surface
  +0.072 [+0.020, +0.126]; no-flag-parameters −0.067 [−0.141, −0.003] (82% of clean items flagged);
  names-match-behavior −0.072 [−0.160, +0.001]; protect-internal-state reaches 15 of 27 gold ranges.
  Gold ranges reached: 98% dev, 96% test.
  - Wording sets through the same selectors: AUROC −0.04 to −0.07 (terse 0.930 → 0.888 test, borrowed
    0.859), false alarms about doubled; the selectors reach 98% of polished gold ranges on dev but 87–95%
    of the reworded rules'. Under H19 the loss was at most 0.02.
  - Dev F1 maximum is 0.6 / 0.775; kept 0.5 / 0.65: test F1 0.583 vs. 0.589, caught 74% vs. 55%.
- **Conclusion**: supported. Units and computed evidence chosen per rule beat any one shared unit, and
  cost less. A selector is part of its rule: a different rule text needs its own selector, which is the
  user-facing consequence. Next: no-flag-parameters and names-match-behavior selectors, and
  protect-internal-state coverage (all designed on dev; test exposed them).

## H22: the earlier CLI as a policy

- **Context**: owner direction (2026-10-22): selectors, context, and globs are one concept, and the design
  must hold every earlier strategy, so it can never score below one. Exploratory, no prediction written.
- **Step 1, the excerpt CLI through the item request** (dev, `evals/steps/excerpts.ts` reproducing H19's
  cutter; `ablate.ts`): the item request of H21 (CLI guidance "item … location … context", item criteria,
  `location:`/`item:` layout, policy file with frontmatter as the rule) scored 0.907 vs. H19's 0.914
  [−0.013, −0.001]. Rebuilding H19's exact bodies from the same items gave 0.914 (cache hits), so the
  items were right and the framing cost the gap. Ablations (dev AUROC): H19 framing with the frontmatter
  0.910; item framing without the frontmatter 0.908; H19 framing without the frontmatter **0.919**; item
  framing with H19 item text 0.906–0.909. Test: H19 framing without frontmatter 0.916 vs. 0.913.
- **Design that follows**: the CLI adds nothing. The request's text is the policy body exactly as written;
  each question is an item's text; optional `criteria` set what yes and no mean. Items are `{id, text,
  path?, lines?}` (context goes into `text`); frontmatter is `select`, `criteria`, `limit` (globs,
  `evidence` steps, `{{name}}`, and `examples` are gone: files are the selector's to pick, context and
  examples are text). Corpus policies carry the earlier framing in their bodies; their selectors end in
  `present.ts` (the old `location:`/`item:` layout). `evals/corpus/selectors-excerpts/` is H19 as policies.
- **Result** (real semantic, file AUROC, paired over the same cases):

  | Split | H19 | Excerpt policies | Rule selectors | Rule − excerpt policies | TPR@10%: excerpt → rule |
  |---|---|---|---|---|---|
  | dev | 0.914 | 0.918 [−0.002, +0.010] | 0.937 | +0.019 [+0.008, +0.029] | 0.707 → 0.828 |
  | test | 0.913 | 0.914 [−0.005, +0.006] | 0.930 | +0.016 [+0.006, +0.027] | 0.702 → 0.801 |

  - Per rule, choosing the rule selector only where its dev gain over the excerpt policy is outside noise
    selects none (n is 4–82 violations per rule; test-behavior's interval starts at +0.000), which
    forfeits the pooled gain. no-flag-parameters: dev 0.961 → 0.976, test 0.977 → 0.915 [−0.133,
    −0.003].
  - CLI run (`run.ts`, cut-offs 0.5 / 0.65): test caught 69%, surfaced 85%, false alarms 13%, $13.98 per
    1,000 files. Dev F1 maximum 0.575 / 0.725 gives test F1 0.591 vs. 0.580 but catches 63% vs. 73%
    (all cases); kept 0.5 / 0.65.
  - Wording sets through the corpus selectors: −0.03 to −0.05 (style-guide −0.03, terse and agents-md
    −0.045 to −0.05); without the frontmatter in the request, about 0.02 less loss than H21.
  - history.ts: today's date on each item no longer helps (0.877 → 0.859, within noise); computed age
    still decides it (1.000). examples.ts: examples in the body improve Brier on both splits (−0.006 to
    −0.009) and leave AUROC unchanged.
- **Conclusion**: supported. The earlier CLI is a policy, scoring what it scored, so the design contains
  it; selectors built per rule beat it pooled. Per-rule regressions (no-flag-parameters) are selector
  quality, found only on held-out data; the excerpt policy is the fallback a tuning agent compares against.

---

## Run log

- 2026-10-20: notebook created; baseline counts computed from `evals/corpus/*.jsonl`.
- 2026-10-20: H1, H9, H8 from cached scores (`run.ts --split all --category semantic production
  production,chunk=0`, 0 requests).
- 2026-10-20: H2 Claude labeling, 101 files; the first launch from worker threads failed (completion
  handles must be created on the kernel's main thread) and was rerun from the main thread.
- 2026-10-20: `evals/mine.ts` written (subagent) and run on 12 repos; 172 comments classified as policy
  concerns, 146 before files and 83 after files fetched and labeled twice (482 label calls).
- 2026-10-20: `evals/.cache/research/score.ts` (throwaway scorer, parity with `run.ts` checked);
  Clef requests sent: 95 (plants), 1,440 (mined), 265 (terse), 265 (style-guide text).
- 2026-10-20: H2 gpt-6.1-sol labeling through a session-only `modelRoles.slow` mapping (approved,
  restored afterward): 101 labels, 224 Claude adjudications, review queue built.
- 2026-10-21: 119 gold labels changed from the H2 triage and the both-models-agree rule (corpus
  validated). Every hypothesis then re-scored from cached answers (Re-score bullets; H9 verdict changed).
- 2026-10-21: README findings re-scored against the relabeled gold: `run.ts` sweeps (dev, test), whole-file
  rows, cut-off and clef-flash checks, `items.ts`, `compare.ts`, `examples.ts`, `cutoffs.ts`, `packing.ts`.
  Cache misses re-sent 4,169 requests (12.4M input tokens, about $2.98), counted from new cache entries;
  `packing.ts` also sends real requests by design. The file cut-off gap (0.275 / 0.55 vs. 0.3 / 0.45) is
  +0.018 [−0.011, +0.049] F1 on dev and +0.009 [−0.023, +0.042] on test: within noise, so the default
  stays. Outputs: `evals/.cache/research/rescore/`.
- 2026-10-21: corpus growth (H10–H15). Provenance backfilled on the 112 files (commit dates from `gh
  api`). `evals/sample.ts` written and run on 99 repos (291 files). `evals/mine.ts` run on 36 more repos;
  it crashed once on a TLS timeout, so `gh api` calls now retry and the run resumed from cache. Model
  calls, all through `completion()` with `modelRoles.slow` set to `openai-codex/gpt-6.1-sol` for the
  session only (approved; restored to `{}` afterward): 837 Claude and 838 gpt-6.1-sol labeling requests
  (new files, twins, three wording sets), 2,254 Claude adjudications, 142 plant edits, and 1,596 comment
  classifications. Clef: 2,836 new cache entries, 14.9M input tokens, about $3.58 (whole corpus under
  production, `chunk=0` on semantic dev and test, and the style-guide and agents-md wording sets).
  `run.ts` scoring moved to `evals/scoring.ts`; the 1,555 cases scored before reproduce exactly.
  Kernel code: `evals/.cache/research/pipeline.py` and `pipeline-session.py` (every cell in run order);
  outputs in `evals/.cache/research/{new-labels,new-adjudications,plants-new,growth}/`.
- 2026-10-21: wording gold extended to the 511 sampled, mined and LLM-planted semantic files (same
  protocol, `modelRoles.slow` mapped for the session and restored). `wordings.ts` gained `--origin`.
  Clef: 4,647 new cache entries, 19.0M input tokens, about $4.57.
- 2026-10-21: file cut-offs changed to 0.275 / 0.375 (`src/lint.ts`). Re-scored from cache, real semantic:
  verdict F1 0.541 dev / 0.533 test, caught 38% / 42%, false alarms 10% / 10%; wording tables re-scored
  with `wordings.ts --origin real`. No new requests.
- 2026-10-21: identification-rate study (H16–H20). Clef: 74,769 new cache entries, 244.3M input tokens
  (`clef`) plus 4.4M (`clef-omni`), about $59.30. Most of it is H19's sweep (one request per file and
  policy) on dev and test, terse wording, and control rules.
- 2026-10-21: H19 shipped. `src/clef.ts` judges files with the rule in the state and 1 KB excerpts as
  questions; file cut-offs 0.45 / 0.575 (dev F1 maximum, all cases). `evals/strategy.ts` gained `shape`
  (`rule` | `file`; the earlier production is `shape=file,chunk=4000`). Test, all cases: F1 0.571 vs.
  0.558; real semantic: AUROC 0.913, caught 55%, surfaced 78%, false alarms 14%. Wording sets re-scored
  (`wordings.ts --origin real`): terse −0.016 to −0.020 AUROC, borrowed wordings within noise.
- 2026-10-22: selectors required for every policy (H21). `src/` lost whole-file judging; `evals/run.ts`
  rewritten around selectors (strategy.ts, scoring.ts, items.ts, compare.ts removed); wording files hold
  only rule bodies. Clef: 34,520 new cache entries, 164.5M input tokens, about $39.47.
- 2026-10-22: one concept (H22). Frontmatter is `select`, `criteria`, `limit`; the body is the request's
  text; items are id, text, path, lines. Corpus globs moved into selectors (a POSIX `case` filter, checked
  to accept exactly each policy's labeled files); `excerpts.ts`, `present.ts`, and the excerpt policies
  added; `selectors-evidence` and `selectors-evidence-constants` removed. Clef: 73,810 new cache entries,
  341.8M input tokens, about $82.04.
- Artifacts (gitignored, local only): `evals/.cache/research/` holds labels, adjudications, mined
  candidates and files, plants, policy variants, and score outputs behind every number above.
