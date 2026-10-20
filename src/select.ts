import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { Effect, Runtime, Schema } from "effect"
import { type Policy, resolveReferences } from "./policy.ts"

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

/**
 * Runs a built-in selector step: reads items (JSONL) on stdin, passes each through `step`, and writes them
 * back (JSONL) to stdout in order. An invalid input line fails with the step's `name`.
 */
export const itemStep = Effect.fnUntraced(function*<E, R>(name: string, step: (item: Item) => Effect.Effect<Item, E, R>) {
  const input = yield* Effect.promise(() => Bun.stdin.text())
  const output: Array<string> = []
  for (const [index, line] of input.split("\n").entries()) {
    if (line.trim() === "") continue
    const item = yield* parseItem(line).pipe(
      Effect.mapError((reason) => new SelectorError({ message: `${name}: input line ${index + 1} is not a valid item: ${reason}` }))
    )
    output.push(formatItem(yield* step(item)))
  }
  if (output.length === 0) return
  // Bun.write(Bun.stdout, …) garbles large output on a pipe; process.stdout.write does not.
  const text = `${output.join("\n")}\n`
  yield* Effect.callback<void>((resume) => {
    process.stdout.write(text, () => resume(Effect.void))
  })
})

/** The shell command that runs this CLI, given to selectors as `$LINT_ANYTHING` for its helper subcommands. */
export const selfCommand = `${process.execPath} ${resolve(import.meta.dir, "../index.ts")}`

/** Runs `command` with `sh -c` and `paths` as `"$@"`, from `cwd`, with `$LINT_ANYTHING` and `env` set. */
const shell = (command: string, paths: ReadonlyArray<string>, cwd: string | undefined, env: Readonly<Record<string, string>>) =>
  Effect.promise(() => {
    const run = Bun.$`sh -c ${command} sh ${paths}`.env({ ...process.env, LINT_ANYTHING: selfCommand, ...env }).quiet().nothrow()
    return cwd === undefined ? run : run.cwd(cwd)
  })

/**
 * Runs `policy`'s evidence steps in order, then `use` with the policy whose `{{name}}` references are
 * filled in and an environment with `$EVIDENCE_<name>`: the path of a file holding each step's output.
 * Every step sees the outputs of the steps before it the same way. The files are removed afterwards.
 */
export const withEvidence = <A, E, R>(
  policy: Policy,
  paths: ReadonlyArray<string>,
  cwd: string | undefined,
  use: (policy: Policy, env: Readonly<Record<string, string>>) => Effect.Effect<A, E, R>
): Effect.Effect<A, E | SelectorError, R> =>
  policy.evidence.length === 0
    ? use(policy, {})
    : Effect.acquireUseRelease(
      Effect.sync(() => mkdtempSync(join(tmpdir(), "lint-anything-"))),
      (directory) =>
        Effect.gen(function*() {
          const env: Record<string, string> = {}
          const outputs = new Map<string, string>()
          for (const step of policy.evidence) {
            const result = yield* shell(step.command, paths, cwd, env)
            if (result.exitCode !== 0) {
              return yield* new SelectorError({
                message: `${policy.name}: evidence step ${step.name} exited ${result.exitCode}: ${result.stderr.toString().trim().slice(0, 500)}`
              })
            }
            const output = result.stdout.toString().replace(/\n+$/, "")
            const file = join(directory, step.name)
            writeFileSync(file, output)
            env[`EVIDENCE_${step.name}`] = file
            outputs.set(step.name, output)
          }
          return yield* use(resolveReferences(policy, outputs), env)
        }),
      (directory) => Effect.sync(() => rmSync(directory, { recursive: true, force: true }))
    )

/**
 * Runs `policy.select` with `sh -c`, passing `paths` as its arguments (`"$@"`), from `cwd`, with
 * `$LINT_ANYTHING` and `env` (from `withEvidence`) set. Its stdout must be JSONL: one item per non-empty
 * line. A non-zero exit or an invalid line fails the run.
 */
export const runSelector = Effect.fn("runSelector")(function*(
  policy: Policy & { readonly select: string },
  paths: ReadonlyArray<string>,
  cwd?: string,
  env: Readonly<Record<string, string>> = {}
) {
  const result = yield* shell(policy.select, paths, cwd, env)
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
