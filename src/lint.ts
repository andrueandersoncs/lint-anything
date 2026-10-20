import { Array as Arr, Effect, Result } from "effect"
import { Clef, type Judgment, type RequestTooLarge } from "./clef.ts"
import { matches, type Policy } from "./policy.ts"
import { type Item, runSelector } from "./select.ts"
import type { SourceFile } from "./source.ts"

export type Verdict = "pass" | "review" | "violation" | "inconclusive"

/** One judgment: of a whole file, or of one item a policy's selector emitted (`item`, its id). */
export interface Finding {
  readonly policy: string
  readonly verdict: Verdict
  readonly path?: string
  readonly item?: string
  readonly lines?: readonly [number, number]
  readonly violates?: number
  readonly reason?: string
}

// Tuned in evals/ on the dev split (semantic and control rules together) for the excerpt request shape,
// then confirmed on the held-out test split: scores at or below the floor are clean, scores between
// the floor and the threshold are the band where violations blur into genuinely contested cases.
export const reviewFloor = 0.3
export const defaultThreshold = 0.45

// Selector items score higher than whole files, so they have their own cut-offs, picked on the dev split
// of evals/items.ts and confirmed on test: about 2% of clean items reach the threshold and 7% the floor.
export const itemReviewFloor = 0.5
export const defaultItemThreshold = 0.65

const classify = ({ violates }: Judgment, floor: number, threshold: number): Verdict =>
  violates <= floor ? "pass" : violates >= threshold ? "violation" : "review"

const toFinding = (
  judgment: Result.Result<Judgment, RequestTooLarge>,
  base: Omit<Finding, "verdict" | "violates" | "reason">,
  floor: number,
  threshold: number
): Finding =>
  Result.match(judgment, {
    onSuccess: (judgment): Finding => ({ ...base, verdict: classify(judgment, floor, threshold), ...judgment }),
    onFailure: ({ bytes }): Finding => ({ ...base, verdict: "inconclusive", reason: `request is ${bytes} bytes; Clef would truncate it` })
  })

const itemLocation = (item: Item) => ({
  item: item.id,
  ...(item.path === undefined ? {} : { path: item.path }),
  ...(item.lines === undefined ? {} : { lines: item.lines })
})

/**
 * Judges every file against every policy without a selector whose globs match its path, batching each
 * file's policies. Then runs each selector policy on the files its globs match (skipping it when none
 * do; a selector without globs always runs, with no arguments) and judges its items.
 */
export const lint = Effect.fn("lint")(function*(
  files: ReadonlyArray<SourceFile>,
  policies: ReadonlyArray<Policy>,
  cutoffs: { readonly threshold: number; readonly itemThreshold: number }
) {
  const clef = yield* Clef
  const filePolicies = policies.filter((policy) => policy.select === undefined)
  const fileFindings = yield* Effect.forEach(files, (file) => {
    const applicable = filePolicies.filter((policy) => matches(policy, file.path))
    return clef.judge(file, applicable).pipe(
      Effect.map((judgments) =>
        Arr.zipWith(applicable, judgments, (policy, judgment) =>
          toFinding(judgment, { path: file.path, policy: policy.name }, reviewFloor, cutoffs.threshold))
      )
    )
  }, { concurrency: 8 })
  const itemFindings = yield* Effect.forEach(policies, (policy) => {
    const select = policy.select
    if (select === undefined) return Effect.succeed([])
    const paths = files.filter((file) => matches(policy, file.path)).map((file) => file.path)
    if (policy.globs.length > 0 && paths.length === 0) return Effect.succeed([])
    return runSelector({ ...policy, select }, paths).pipe(
      Effect.flatMap((items) =>
        clef.judgeItems(policy, items).pipe(
          Effect.map((judgments) =>
            Arr.zipWith(items, judgments, (item, judgment) =>
              toFinding(judgment, { policy: policy.name, ...itemLocation(item) }, itemReviewFloor, cutoffs.itemThreshold))
          )
        )
      )
    )
  })
  return [...fileFindings.flat(), ...itemFindings.flat()]
})
