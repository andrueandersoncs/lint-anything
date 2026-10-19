import { Effect } from "effect"
import { Clef, type Judgment } from "./clef.ts"
import { matches, type Policy } from "./policy.ts"
import type { SourceFile } from "./source.ts"

export type Verdict = "pass" | "review" | "violation" | "inconclusive"

export interface Finding {
  readonly path: string
  readonly policy: string
  readonly verdict: Verdict
  readonly applies?: number
  readonly violates?: number
  readonly reason?: string
}

// Calibrated in better-typescript's evals: violation scores at or below 0.55 were mostly false.
const reviewFloor = 0.55
const applicabilityGate = 0.7

export const classify = ({ applies, violates }: Judgment, threshold: number): Verdict => {
  if (violates <= reviewFloor) return "pass"
  if (applies < applicabilityGate) return "inconclusive"
  return violates >= threshold ? "violation" : "review"
}

/** Judges every file against every policy whose globs match its path. */
export const lint = Effect.fn("lint")(function*(
  files: ReadonlyArray<SourceFile>,
  policies: ReadonlyArray<Policy>,
  threshold: number
) {
  const clef = yield* Clef
  const checks = files.flatMap((file) =>
    policies.filter((policy) => matches(policy, file.path)).map((policy) => ({ file, policy }))
  )
  return yield* Effect.forEach(checks, ({ file, policy }) =>
    clef.judge(file, policy).pipe(
      Effect.map((judgment): Finding => ({
        path: file.path,
        policy: policy.name,
        verdict: classify(judgment, threshold),
        ...judgment
      })),
      Effect.catchTag("RequestTooLarge", ({ bytes }) =>
        Effect.succeed<Finding>({
          path: file.path,
          policy: policy.name,
          verdict: "inconclusive",
          reason: `request is ${bytes} bytes; Clef would truncate it`
        }))
    ), { concurrency: 8 })
})
