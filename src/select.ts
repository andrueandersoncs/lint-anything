import { Effect, Runtime, Schema } from "effect"
import type { Policy } from "./policy.ts"

/**
 * One thing a policy's selector picked out to judge. `id` names it in findings; `path` and `lines`
 * (1-based, inclusive) locate it; `context` is extra text the judge reads alongside it.
 */
export const Item = Schema.Struct({
  id: Schema.NonEmptyString,
  text: Schema.NonEmptyString,
  path: Schema.optional(Schema.NonEmptyString),
  lines: Schema.optional(Schema.Tuple([Schema.Int, Schema.Int]).check(
    Schema.makeFilter(([start, end]) => (1 <= start && start <= end) || "lines must be [start, end] with 1 <= start <= end")
  )),
  context: Schema.optional(Schema.String)
})
export type Item = typeof Item.Type

export class SelectorError extends Schema.TaggedError<SelectorError>()("SelectorError", {
  message: Schema.String
}) {
  override readonly [Runtime.errorExitCode] = 2
}

const decodeItem = Schema.decodeUnknownEffect(Schema.fromJsonString(Item))

/**
 * Runs `policy.select` with `sh -c`, passing `paths` as its arguments (`"$@"`), from `cwd`. Its stdout
 * must be JSONL: one item per non-empty line. A non-zero exit or an invalid line fails the run.
 */
export const runSelector = Effect.fn("runSelector")(function*(
  policy: Policy & { readonly select: string },
  paths: ReadonlyArray<string>,
  cwd?: string
) {
  const result = yield* Effect.promise(() => {
    const command = Bun.$`sh -c ${policy.select} sh ${paths}`.quiet().nothrow()
    return cwd === undefined ? command : command.cwd(cwd)
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
      decodeItem(line).pipe(
        Effect.mapError((error) =>
          new SelectorError({ message: `${policy.name}: selector output line ${number} is not a valid item: ${error.message}` })
        )
      )
  )
})
