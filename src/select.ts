import { Effect, Runtime, Schema } from "effect"
import { parseItem } from "./item.ts"
import type { Policy } from "./policy.ts"

export class SelectorError extends Schema.TaggedError<SelectorError>()("SelectorError", {
  message: Schema.String
}) {
  override readonly [Runtime.errorExitCode] = 2
}

type ShellOutput = Awaited<ReturnType<typeof Bun.$>>

/**
 * The selectors one lint run has started, so policies with the same selector run it once. Create one per
 * run: files may change between runs.
 */
export type SelectorRuns = Map<string, Promise<ShellOutput>>

/**
 * Runs `policy.select` with `sh -c`, passing `paths` as its arguments (`"$@"`), from `cwd`. Its stdout must
 * be JSONL: one item per non-empty line. A non-zero exit or an invalid line fails the run. With `runs`, a
 * selector already run with the same command, arguments, and directory reuses that run's output.
 */
export const runSelector = Effect.fn("runSelector")(function*(
  policy: Policy,
  paths: ReadonlyArray<string>,
  cwd?: string,
  runs?: SelectorRuns
) {
  const result = yield* Effect.promise(() => {
    const start = () => {
      const started = Bun.$`sh -c ${policy.select} sh ${paths}`.quiet().nothrow()
      return Promise.resolve(cwd === undefined ? started : started.cwd(cwd))
    }
    if (runs === undefined) return start()
    const key = JSON.stringify([policy.select, paths, cwd ?? process.cwd()])
    let run = runs.get(key)
    if (run === undefined) {
      run = start()
      runs.set(key, run)
    }
    return run
  })
  if (result.exitCode !== 0) {
    return yield* new SelectorError({
      message: `${policy.name}: selector exited ${result.exitCode}: ${result.stderr.toString().trim().slice(0, 500)}`
    })
  }
  const lines = result.stdout.toString().split("\n")
  return yield* Effect.forEach(
    lines.flatMap((line, index) => (line.trim() === "" ? [] : [{ line, number: index + 1 }])),
    ({ line, number }) =>
      parseItem(line).pipe(
        Effect.mapError((reason) =>
          new SelectorError({ message: `${policy.name}: selector output line ${number} is not a valid item: ${reason}` })
        )
      )
  )
})
