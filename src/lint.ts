import { Array as Arr, Effect, Result } from "effect"
import { DecisionModel, type Question, type Unanswered } from "./decision-model.ts"
import type { Item } from "./item.ts"
import type { Policy } from "./policy.ts"
import { runSelector, type SelectorRuns } from "./select.ts"

export type Verdict = "pass" | "review" | "violation" | "inconclusive"

/** One judgment: of one item a policy's selector emitted (`item`, its id). */
export interface Finding {
  readonly policy: string
  readonly verdict: Verdict
  readonly item: string
  readonly path?: string
  readonly lines?: readonly [number, number]
  readonly violates?: number
  readonly reason?: string
}

// Checked on the eval corpus with its selectors (README, Evals): F1 is flat between these and the dev F1
// maximum (0.6 / 0.775; test 0.583 vs. 0.589), and these catch about a third more violations.
export const reviewFloor = 0.5
export const defaultThreshold = 0.65

/** The verdict for violation probability `violates` under the given cut-offs. */
export const verdictOf = (violates: number, floor: number, threshold: number): Verdict =>
  violates <= floor ? "pass" : violates >= threshold ? "violation" : "review"

// Nothing is added to what the policy says: the request's text is the policy body, each question is an
// item's text, and the policy's criteria say what yes (violates) and no mean (a decision API without
// criteria gets them in the question's instructions). Packing a policy's items as
// questions of one request won the eval suite's sweep (README, Evals); one request per item cost 2.5×.
/** The question that judges `item` against `policy`, asked under the policy body. */
export const itemQuestion = (policy: Policy, item: Item): Question => ({ instructions: item.text, criteria: policy.criteria })

const toFinding = (
  violates: Result.Result<number, Unanswered>,
  base: Omit<Finding, "verdict" | "violates" | "reason">,
  policy: Policy,
  threshold: number
): Finding =>
  Result.match(violates, {
    onSuccess: (violates): Finding => {
      const verdict = verdictOf(violates, reviewFloor, threshold)
      // A decision model answers only with a probability, so a finding's reason is what the policy says a
      // violation is.
      return { ...base, verdict, violates, ...(verdict === "pass" ? {} : { reason: policy.criteria.true }) }
    },
    onFailure: (error): Finding => ({ ...base, verdict: "inconclusive", reason: error.message })
  })

const itemLocation = (item: Item) => ({
  item: item.id,
  ...(item.path === undefined ? {} : { path: item.path }),
  ...(item.lines === undefined ? {} : { lines: item.lines })
})

const byLocation = (a: Item, b: Item) =>
  (a.path ?? "").localeCompare(b.path ?? "") || (a.lines?.[0] ?? 0) - (b.lines?.[0] ?? 0) || a.id.localeCompare(b.id)

/**
 * Select stage: runs `policy.select` from `cwd` (default: the current directory) and returns its items in
 * the order they are judged. With `runs`, policies with the same selector run it once.
 */
export const select = Effect.fn("select")(function*(
  policy: Policy,
  cwd?: string,
  runs?: SelectorRuns
) {
  // Answers depend on how items are packed into requests, and tools like rg emit matches in varying
  // order; sorting makes the packing, and so the verdicts, repeatable.
  return (yield* runSelector(policy, cwd, runs)).toSorted(byLocation)
})

/**
 * Judge stage: asks the decision model whether each item violates `policy`, under the policy body. Results
 * follow `items` order: the probability that the item violates the rule, or why there is none
 * (`RequestTooLarge`, `Declined`).
 */
export const judge = Effect.fn("judge")(function*(policy: Policy, items: ReadonlyArray<Item>) {
  const model = yield* DecisionModel
  return yield* model.ask(policy.name, policy.body, items.map((item) => itemQuestion(policy, item)))
})

/**
 * Decide stage: one finding per item of `items`, given their `answers` (from `judge`, in the same order),
 * under `threshold`.
 */
export const decide = (
  policy: Policy,
  items: ReadonlyArray<Item>,
  answers: ReadonlyArray<Result.Result<number, Unanswered>>,
  threshold: number
): Array<Finding> =>
  Arr.zipWith(items, answers, (item, violates) =>
    toFinding(violates, { policy: policy.name, ...itemLocation(item) }, policy, threshold))

// Policies judged at once. The decision model bounds requests in flight across the run, so this only lets one policy's
// selector run, and its requests fill slots, while another's are in flight. Each policy's requests are
// packed alone, so concurrency changes no answer.
const policyConcurrency = 8

/**
 * Runs each policy's selector from the current directory and judges the items it selects. Findings follow
 * `policies` order.
 */
export const lint = Effect.fn("lint")(function*(
  policies: ReadonlyArray<Policy>,
  threshold: number
) {
  // Policies with the same selector run it once in this run.
  const runs: SelectorRuns = new Map()
  const findings = yield* Effect.forEach(policies, (policy) =>
    Effect.gen(function*() {
      const items = yield* select(policy, undefined, runs)
      return decide(policy, items, yield* judge(policy, items), threshold)
    }), { concurrency: policyConcurrency })
  return findings.flat()
})
