import { Array as Arr, Effect, Result } from "effect"
import { Clef, type Judgment, type RequestTooLarge } from "./clef.ts"
import type { Item } from "./item.ts"
import type { Policy } from "./policy.ts"
import { runSelector, SelectorError, type SelectorRuns } from "./select.ts"

export type Verdict = "pass" | "review" | "violation" | "inconclusive"

/**
 * One judgment: of one item a policy's selector emitted (`item`, its id), or of a policy's `limit` over its
 * items (`violating`, the ids of the items that count).
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

/** Where an item is, for a reason: its `lines` within its group's file, else its `path:lines`, else its id. */
const itemPlace = (finding: Finding, inFile: boolean) =>
  finding.lines === undefined
    ? finding.item!
    : `${inFile ? "" : `${finding.path}:`}${finding.lines[0]}-${finding.lines[1]}`

/**
 * A `limit` policy's findings: its item findings counted per file (or once per run). A group is a
 * `violation` when more than `max` of its items are violations, and `inconclusive` when it isn't but its
 * items that weren't judged could put it over. Items in `review` are counted in the reason but not against
 * the limit. The reason says where the violating items are.
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
    const unjudged = group.filter((item) => item.verdict === "inconclusive").length
    const verdict = violating.length > limit.max
      ? "violation"
      : violating.length + unjudged > limit.max
      ? "inconclusive"
      : "pass"
    const places = violating.map((item) => itemPlace(item, path !== undefined)).join(", ")
    return {
      policy,
      ...(path === undefined ? {} : { path }),
      verdict,
      reason: [
        `${violating.length} of ${group.length} items violate the rule (at most ${limit.max} allowed)${places === "" ? "" : `: ${places}`}`,
        ...(review > 0 ? [`${review} more in review`] : []),
        ...(unjudged > 0 ? [`${unjudged} not judged (request too large)`] : [])
      ].join("; "),
      violating: violating.map((item) => item.item!)
    }
  })
}

// Checked on the eval corpus with its selectors (README, Evals): F1 is flat between these and the dev F1
// maximum (0.6 / 0.775; test 0.583 vs. 0.589), and these catch about a third more violations.
export const reviewFloor = 0.5
export const defaultThreshold = 0.65

/** The verdict for violation probability `violates` under the given cut-offs. */
export const verdictOf = (violates: number, floor: number, threshold: number): Verdict =>
  violates <= floor ? "pass" : violates >= threshold ? "violation" : "review"

const toFinding = (
  judgment: Result.Result<Judgment, RequestTooLarge>,
  base: Omit<Finding, "verdict" | "violates" | "reason">,
  policy: Policy,
  threshold: number
): Finding =>
  Result.match(judgment, {
    onSuccess: (judgment): Finding => {
      const verdict = verdictOf(judgment.violates, reviewFloor, threshold)
      // Clef answers only with a probability, so a finding's reason is what the policy says a violation is.
      return { ...base, verdict, ...judgment, ...(verdict === "pass" ? {} : { reason: policy.criteria.true }) }
    },
    onFailure: ({ bytes }): Finding => ({ ...base, verdict: "inconclusive", reason: `request is ${bytes} bytes; Clef would truncate it` })
  })

const itemLocation = (item: Item) => ({
  item: item.id,
  ...(item.path === undefined ? {} : { path: item.path }),
  ...(item.lines === undefined ? {} : { lines: item.lines })
})

const byLocation = (a: Item, b: Item) =>
  (a.path ?? "").localeCompare(b.path ?? "") || (a.lines?.[0] ?? 0) - (b.lines?.[0] ?? 0) || a.id.localeCompare(b.id)

// Policies judged at once. Clef bounds requests in flight across the run, so this only lets one policy's
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
  const clef = yield* Clef
  // Policies with the same selector run it once in this run.
  const runs: SelectorRuns = new Map()
  const findings = yield* Effect.forEach(policies, (policy) =>
    runSelector(policy, undefined, runs).pipe(
      // Answers depend on how items are packed into requests, and tools like rg emit matches in varying
      // order; sorting makes the packing, and so the verdicts, repeatable.
      Effect.map((items) => items.toSorted(byLocation)),
      Effect.tap((items) => {
        const pathless = items.find((item) => item.path === undefined)
        return policy.limit?.per === "file" && pathless !== undefined
          ? Effect.fail(new SelectorError({
            message: `${policy.name}: item ${pathless.id} has no path, and limit per file counts items by path; give every item a path or use per: run`
          }))
          : Effect.void
      }),
      Effect.flatMap((items) =>
        clef.judgeItems(policy, items).pipe(
          Effect.map((judgments) => {
            const found = Arr.zipWith(items, judgments, (item, judgment) =>
              toFinding(judgment, { policy: policy.name, ...itemLocation(item) }, policy, threshold))
            return policy.limit === undefined ? found : aggregate(policy.name, policy.limit, found)
          })
        )
      )
    ), { concurrency: policyConcurrency })
  return findings.flat()
})
