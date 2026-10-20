import { Array as Arr, Effect, Result } from "effect"
import { Clef, type Judgment } from "./clef.ts"
import { matches, type Policy } from "./policy.ts"
import type { SourceFile } from "./source.ts"

export type Verdict = "pass" | "review" | "violation" | "inconclusive"

export interface Finding {
  readonly path: string
  readonly policy: string
  readonly verdict: Verdict
  readonly violates?: number
  readonly reason?: string
}

// Calibrated in better-typescript's evals: violation scores at or below 0.55 were mostly false.
const reviewFloor = 0.55

export const classify = ({ violates }: Judgment, threshold: number): Verdict => {
  if (violates <= reviewFloor) return "pass"
  return violates >= threshold ? "violation" : "review"
}

/** Judges every file against every policy whose globs match its path, batching each file's policies. */
export const lint = Effect.fn("lint")(function*(
  files: ReadonlyArray<SourceFile>,
  policies: ReadonlyArray<Policy>,
  threshold: number
) {
  const clef = yield* Clef
  const findings = yield* Effect.forEach(files, (file) => {
    const applicable = policies.filter((policy) => matches(policy, file.path))
    return clef.judge(file, applicable).pipe(
      Effect.map((judgments) =>
        Arr.zipWith(applicable, judgments, (policy, judgment) =>
          Result.match(judgment, {
            onSuccess: (judgment): Finding => ({
              path: file.path,
              policy: policy.name,
              verdict: classify(judgment, threshold),
              ...judgment
            }),
            onFailure: ({ bytes }): Finding => ({
              path: file.path,
              policy: policy.name,
              verdict: "inconclusive",
              reason: `request is ${bytes} bytes; Clef would truncate it`
            })
          }))
      )
    )
  }, { concurrency: 8 })
  return findings.flat()
})
