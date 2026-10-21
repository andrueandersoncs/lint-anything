import { Array as Arr, Effect, Result } from "effect"
import { Clef, type Judgment, type RequestTooLarge } from "./clef.ts"
import type { Item } from "./item.ts"
import { matches, type Policy } from "./policy.ts"
import { runSelector, type StepRuns, withEvidence } from "./select.ts"
import type { SourceFile } from "./source.ts"

export type Verdict = "pass" | "review" | "violation" | "inconclusive"

/**
 * One judgment: of a whole file, of one item a policy's selector emitted (`item`, its id), or of a policy's
 * `limit` over its items (`violating`, the ids of the items that count).
 */
export interface Finding {
  readonly policy: string
  readonly verdict: Verdict
  readonly path?: string
  readonly item?: string
  readonly lines?: readonly [number, number]
  readonly violates?: number
  readonly reason?: string
  readonly violating?: ReadonlyArray<string>
}

/**
 * A `limit` policy's findings: its item findings counted per file (or once per run). A group is a
 * `violation` when more than `max` of its items are violations; items in `review` are counted in the reason
 * but not against the limit.
 */
export const aggregate = (
  policy: string,
  limit: { readonly max: number; readonly per: "file" | "run" },
  items: ReadonlyArray<Finding>
): Array<Finding> => {
  const groups = new Map<string | undefined, Array<Finding>>()
  if (limit.per === "run") groups.set(undefined, [...items])
  else for (const item of items) groups.set(item.path, [...(groups.get(item.path) ?? []), item])
  return [...groups].map(([path, group]) => {
    const violating = group.filter((item) => item.verdict === "violation")
    const review = group.filter((item) => item.verdict === "review").length
    return {
      policy,
      ...(path === undefined ? {} : { path }),
      verdict: violating.length > limit.max ? "violation" : "pass",
      reason: `${violating.length} of ${group.length} items violate the rule (at most ${limit.max} allowed)${review > 0 ? `; ${review} more in review` : ""}`,
      violating: violating.map((item) => item.item!)
    }
  })
}

// Tuned in evals/ on the dev split of the grown corpus (623 files, semantic and control rules together) for
// the excerpt request shape, then confirmed on the held-out test split: scores at or below the floor are
// clean, scores between the floor and the threshold are the band where violations blur into genuinely
// contested cases.
export const reviewFloor = 0.275
export const defaultThreshold = 0.375

// Selector items score higher than whole files, so they have their own cut-offs, picked on the dev split
// of evals/items.ts and confirmed on test: about 2% of clean items reach the threshold and 7% the floor.
export const itemReviewFloor = 0.5
export const defaultItemThreshold = 0.65

/** The verdict for violation probability `violates` under the given cut-offs. */
export const verdictOf = (violates: number, floor: number, threshold: number): Verdict =>
  violates <= floor ? "pass" : violates >= threshold ? "violation" : "review"

const toFinding = (
  judgment: Result.Result<Judgment, RequestTooLarge>,
  base: Omit<Finding, "verdict" | "violates" | "reason">,
  floor: number,
  threshold: number
): Finding =>
  Result.match(judgment, {
    onSuccess: (judgment): Finding => ({ ...base, verdict: verdictOf(judgment.violates, floor, threshold), ...judgment }),
    onFailure: ({ bytes }): Finding => ({ ...base, verdict: "inconclusive", reason: `request is ${bytes} bytes; Clef would truncate it` })
  })

const itemLocation = (item: Item) => ({
  item: item.id,
  ...(item.path === undefined ? {} : { path: item.path }),
  ...(item.lines === undefined ? {} : { lines: item.lines })
})

const byLocation = (a: Item, b: Item) =>
  (a.path ?? "").localeCompare(b.path ?? "") || (a.lines?.[0] ?? 0) - (b.lines?.[0] ?? 0) || a.id.localeCompare(b.id)

/**
 * Judges every file against every policy without a selector whose globs match its path, batching each
 * file's policies; a policy's evidence steps run once first, with all its matching files. Then runs each
 * selector policy on the files its globs match (skipping it when none do; a selector without globs always
 * runs, with no arguments): its evidence steps, then its selector, then judges its items.
 */
export const lint = Effect.fn("lint")(function*(
  files: ReadonlyArray<SourceFile>,
  policies: ReadonlyArray<Policy>,
  cutoffs: { readonly threshold: number; readonly itemThreshold: number }
) {
  const clef = yield* Clef
  // Policies sharing a selector or evidence step run it once in this run.
  const runs: StepRuns = new Map()
  const pathsFor = (policy: Policy) => files.filter((file) => matches(policy, file.path)).map((file) => file.path)
  const filePolicies = yield* Effect.forEach(
    policies.filter((policy) => policy.select === undefined && pathsFor(policy).length > 0),
    (policy) => withEvidence(policy, pathsFor(policy), undefined, (resolved) => Effect.succeed(resolved), runs)
  )
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
    const paths = pathsFor(policy)
    if (policy.globs.length > 0 && paths.length === 0) return Effect.succeed([])
    return withEvidence(policy, paths, undefined, (resolved, env) =>
      runSelector({ ...resolved, select }, paths, undefined, env, runs).pipe(
        // Answers depend on how items are packed into requests, and tools like rg emit matches in varying
        // order; sorting makes the packing, and so the verdicts, repeatable.
        Effect.map((items) => items.toSorted(byLocation)),
        Effect.flatMap((items) =>
          clef.judgeItems(resolved, items).pipe(
            Effect.map((judgments) => {
              const findings = Arr.zipWith(items, judgments, (item, judgment) =>
                toFinding(judgment, { policy: policy.name, ...itemLocation(item) }, itemReviewFloor, cutoffs.itemThreshold))
              return policy.limit === undefined ? findings : aggregate(policy.name, policy.limit, findings)
            })
          )
        )
      ), runs)
  })
  return [...fileFindings.flat(), ...itemFindings.flat()]
})
