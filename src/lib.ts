/**
 * lint-anything as an Effect library (Bun only). The stages a lint run composes, usable on their own:
 *
 * - `select`: runs a policy's selector and returns its items, sorted as they are judged.
 * - `judge`: asks Clef whether each item violates the policy (needs the `Clef` service).
 * - `decide`: turns answers into findings, `limit` included; pure.
 * - `lint`: all three for every policy, as the CLI runs them.
 *
 * `Clef.ask` is the judge without policies: yes/no questions under a shared state, packed, cached, and
 * retried. `Clef.layer(cacheDirectory?)` reads `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_AUTH_TOKEN` (and
 * optionally `CLOUDFLARE_API_BASE_URL`) from the environment. `loadPolicies` needs `FileSystem` and `Path`,
 * for example from `BunServices.layer` in `@effect/platform-bun`.
 *
 * `scorePolicy` measures a policy against labeled code (`loadLabels`: `.lint-anything/labels/<policy>.jsonl`),
 * with the metrics and bootstrap intervals the evals use; the skill's score script is built on it.
 */
export {
  cacheMaxAgeMs,
  Clef,
  ClefError,
  inputTokenPrice,
  model,
  noUsage,
  planRequests,
  type Question,
  RequestTooLarge,
  sumUsage,
  type Usage
} from "./clef.ts"
export { type Item, parseItem } from "./item.ts"
export {
  aggregate,
  decide,
  defaultThreshold,
  type Finding,
  itemQuestion,
  judge,
  lint,
  reviewFloor,
  select,
  type Verdict,
  verdictOf
} from "./lint.ts"
export { loadPolicies, parsePolicy, type Policy, PolicyError } from "./policy.ts"
export { killRunningSelectors, runSelector, SelectorError, type SelectorRuns, selectorTimeoutMinutes } from "./select.ts"
export {
  auroc,
  bootstrapInterval,
  brier,
  caught,
  cliThresholds,
  concordance,
  falseAlarms,
  itemLabel,
  itemsOf,
  type Label,
  LabelError,
  type LabelRecord,
  loadLabels,
  pairedInterval,
  parseLabels,
  type PolicyScore,
  type Quality,
  quality,
  type Range,
  reachedRanges,
  type Scored,
  scorePolicy,
  type ScoreVerdict,
  type Split,
  targetKey,
  targetScore,
  type Thresholds,
  tuneThresholds,
  verdict,
  verdictF1
} from "./score.ts"
