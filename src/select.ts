import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { Effect, Runtime, Schema } from "effect"
import { formatItem, type Item, parseItem } from "./item.ts"
import { type Policy, resolveReferences } from "./policy.ts"

export class SelectorError extends Schema.TaggedError<SelectorError>()("SelectorError", {
  message: Schema.String
}) {
  override readonly [Runtime.errorExitCode] = 2
}

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

// Policies often share a selector or an evidence step; within one process each distinct run happens once.
const runs = new Map<string, Promise<Awaited<ReturnType<typeof Bun.$>>>>()

/**
 * Runs `command` with `sh -c` and `paths` as `"$@"`, from `cwd`, with `$LINT_ANYTHING` and `env` set,
 * once per distinct command, arguments, directory, and evidence (by content, not by file path).
 */
const shell = (command: string, paths: ReadonlyArray<string>, cwd: string | undefined, env: Readonly<Record<string, string>>) =>
  Effect.promise(() => {
    const evidence = Object.entries(env).map(([name, file]) => [name, readFileSync(file, "utf8")])
    const key = JSON.stringify([command, paths, cwd ?? process.cwd(), evidence])
    let run = runs.get(key)
    if (run === undefined) {
      const started = Bun.$`sh -c ${command} sh ${paths}`.env({ ...process.env, LINT_ANYTHING: selfCommand, ...env }).quiet().nothrow()
      run = Promise.resolve(cwd === undefined ? started : started.cwd(cwd))
      runs.set(key, run)
    }
    return run
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
