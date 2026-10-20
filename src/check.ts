import { Effect, Result } from "effect"
import { Clef } from "./clef.ts"
import { defaultItemThreshold, defaultThreshold, itemReviewFloor, reviewFloor, type Verdict, verdictOf } from "./lint.ts"
import { type Policy, withoutExamples } from "./policy.ts"
import { withEvidence } from "./select.ts"

/**
 * How one example fared: `agree` when a violating example is a `violation` or a clean one passes,
 * `disagree` when a violating example passes or a clean one is a `violation`, `unsure` otherwise (`review`,
 * or a request too large to send).
 */
export interface ExampleResult {
  readonly policy: string
  readonly example: string
  readonly violates: boolean
  readonly verdict: Verdict
  readonly score?: number
  readonly outcome: "agree" | "unsure" | "disagree"
}

export const outcomeOf = (violates: boolean, verdict: Verdict): ExampleResult["outcome"] =>
  verdict === (violates ? "violation" : "pass")
    ? "agree"
    : verdict === (violates ? "pass" : "violation")
    ? "disagree"
    : "unsure"

/**
 * Judges every policy's examples against the rule without them, so the rule's wording alone has to get
 * them right. Selector policies judge examples as items, with the item cut-offs; other policies judge each
 * example as a whole file, with the file cut-offs. Evidence steps run with no arguments to fill `{{name}}`.
 */
export const check = Effect.fn("check")(function*(
  policies: ReadonlyArray<Policy>,
  cutoffs: { readonly threshold: number; readonly itemThreshold: number } = { threshold: defaultThreshold, itemThreshold: defaultItemThreshold }
) {
  const clef = yield* Clef
  const results: Array<ExampleResult> = []
  for (const policy of policies.filter((policy) => policy.examples.length > 0)) {
    const rule = yield* withEvidence(withoutExamples(policy), [], undefined, (resolved) => Effect.succeed(resolved))
    const judgments = policy.select !== undefined
      ? yield* clef.judgeItems(rule, policy.examples.map(({ item }) => item))
      : yield* Effect.forEach(policy.examples, ({ item }) =>
        clef.judge({ path: item.path ?? item.id, source: item.text }, [rule]).pipe(Effect.map((judged) => judged[0]!)))
    const [floor, threshold] = policy.select !== undefined ? [itemReviewFloor, cutoffs.itemThreshold] : [reviewFloor, cutoffs.threshold]
    policy.examples.forEach(({ violates, item }, index) => {
      const judgment = judgments[index]!
      const verdict = Result.isSuccess(judgment) ? verdictOf(judgment.success.violates, floor, threshold) : "inconclusive"
      results.push({
        policy: policy.name,
        example: item.id,
        violates,
        verdict,
        ...(Result.isSuccess(judgment) ? { score: judgment.success.violates } : {}),
        outcome: outcomeOf(violates, verdict)
      })
    })
  }
  return results
})
