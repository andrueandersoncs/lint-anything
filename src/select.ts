import { resolve } from "node:path"
import { Effect, Runtime, Schema } from "effect"
import type { Policy } from "./policy.ts"

const Located = Schema.Struct({
  id: Schema.NonEmptyString,
  text: Schema.NonEmptyString,
  path: Schema.optional(Schema.NonEmptyString),
  lines: Schema.optional(Schema.Tuple([Schema.Int, Schema.Int]).check(
    Schema.makeFilter(([start, end]) => (1 <= start && start <= end) || "lines must be [start, end] with 1 <= start <= end")
  ))
})
const located = new Set(Object.keys(Located.fields))

/**
 * One thing a policy's selector picked out to judge. `id` names it in findings; `path` and `lines`
 * (1-based, inclusive) locate it. Every other field is evidence: a named string the judge reads
 * alongside the item, in the order the selector wrote them.
 */
export interface Item extends Schema.Schema.Type<typeof Located> {
  readonly evidence: ReadonlyArray<readonly [name: string, value: string]>
}

export class SelectorError extends Schema.TaggedError<SelectorError>()("SelectorError", {
  message: Schema.String
}) {
  override readonly [Runtime.errorExitCode] = 2
}

/** Parses one JSONL line into an item; fails with a message saying what is wrong with it. */
export const parseItem = Effect.fn("parseItem")(function*(line: string) {
  const value: unknown = yield* Effect.try({ try: () => JSON.parse(line), catch: () => "not valid JSON" })
  if (typeof value !== "object" || value === null || Array.isArray(value)) return yield* Effect.fail("not a JSON object")
  const fields = yield* Schema.decodeUnknownEffect(Located)(value).pipe(Effect.mapError((error) => error.message))
  const evidence: Array<readonly [string, string]> = []
  for (const [name, field] of Object.entries(value)) {
    if (located.has(name)) continue
    if (typeof field !== "string") return yield* Effect.fail(`evidence field ${name} must be a string`)
    evidence.push([name, field])
  }
  return { ...fields, evidence } satisfies Item
})

/** The item as one JSONL line, evidence fields after the located ones. */
export const formatItem = ({ evidence, ...located }: Item) =>
  JSON.stringify({ ...located, ...Object.fromEntries(evidence) })

/** The shell command that runs this CLI, given to selectors as `$LINT_ANYTHING` for its helper subcommands. */
export const selfCommand = `${process.execPath} ${resolve(import.meta.dir, "../index.ts")}`

/**
 * Runs `policy.select` with `sh -c`, passing `paths` as its arguments (`"$@"`), from `cwd`, with
 * `$LINT_ANYTHING` set. Its stdout must be JSONL: one item per non-empty line. A non-zero exit or an
 * invalid line fails the run.
 */
export const runSelector = Effect.fn("runSelector")(function*(
  policy: Policy & { readonly select: string },
  paths: ReadonlyArray<string>,
  cwd?: string
) {
  const result = yield* Effect.promise(() => {
    const command = Bun.$`sh -c ${policy.select} sh ${paths}`.env({ ...process.env, LINT_ANYTHING: selfCommand }).quiet().nothrow()
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
      parseItem(line).pipe(
        Effect.mapError((reason) =>
          new SelectorError({ message: `${policy.name}: selector output line ${number} is not a valid item: ${reason}` })
        )
      )
  )
})
