/**
 * lint-anything as an Effect library (Bun only). The stages a lint run composes, usable on their own:
 *
 * - `select`: runs a policy's selector and returns its items, sorted as they are judged.
 * - `judge`: asks a decision model whether each item violates the policy (needs the `DecisionModel` service).
 * - `decide`: turns answers into findings, one per item; pure.
 * - `lint`: all three for every policy, as the CLI runs them.
 *
 * `DecisionModel.ask` is the judge without policies: yes/no questions under a shared state, packed, cached,
 * and retried. `DecisionModel.layer(cacheDirectory?)` asks the model the environment configures
 * (`configuredTarget`): Clef on Workers AI with `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_AUTH_TOKEN` (and
 * optionally `CLOUDFLARE_API_BASE_URL`) by default, or `LINT_ANYTHING_MODEL` at `LINT_ANYTHING_ENDPOINT`, any
 * System One or OpenAI Decisions endpoint, with `LINT_ANYTHING_API_KEY`. `DecisionModel.layerFor(target)`
 * takes the model from code instead (`workersAiTarget`, `endpointTarget`). `loadPolicies` needs `FileSystem`
 * and `Path`, for example from `BunServices.layer` in `@effect/platform-bun`.
 *
 * `scorePolicy` measures a policy against labeled code (`loadLabels`: `.lint-anything/labels/<policy>.jsonl`),
 * with the metrics and bootstrap intervals the evals use; the skill's score script is built on it.
 */
import { DecisionModel, DecisionModelError } from "./decision-model.ts"

export {
  cacheMaxAgeMs,
  clef,
  clefInputTokenPrice,
  configuredModel,
  configuredTarget,
  Declined,
  decodeReply,
  DecisionModel,
  DecisionModelError,
  endpointTarget,
  type Format,
  type Model,
  noUsage,
  planRequests,
  type Planned,
  type Question,
  RequestTooLarge,
  sumUsage,
  type Target,
  type Unanswered,
  type Usage,
  workersAiTarget
} from "./decision-model.ts"

/** @deprecated Renamed `DecisionModel`: it asks whichever decision model is configured, Clef by default. */
export const Clef = DecisionModel
/** @deprecated Renamed `DecisionModel`. */
export type Clef = DecisionModel
/** @deprecated Renamed `DecisionModelError`. */
export const ClefError = DecisionModelError
/** @deprecated Renamed `DecisionModelError`. */
export type ClefError = DecisionModelError
export { type Item, parseItem } from "./item.ts"
export {
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
