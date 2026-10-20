import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Runtime, Schema } from "effect"
import { parseItem } from "./item.ts"
import { type Policy, resolveReferences } from "./policy.ts"

export class SelectorError extends Schema.TaggedError<SelectorError>()("SelectorError", {
  message: Schema.String
}) {
  override readonly [Runtime.errorExitCode] = 2
}

type ShellOutput = Awaited<ReturnType<typeof Bun.$>>

/**
 * The steps one lint run has started, so policies that share a selector or an evidence step run it once.
 * Create one per run: files may change between runs.
 */
export type StepRuns = Map<string, Promise<ShellOutput>>

/**
 * Runs `command` with `sh -c` and `paths` as `"$@"`, from `cwd`, with `env` added to the environment. With
 * `runs`, a command already run with the same arguments, directory, and evidence (by content, not by file
 * path) reuses that run's output.
 */
const shell = (
  command: string,
  paths: ReadonlyArray<string>,
  cwd: string | undefined,
  env: Readonly<Record<string, string>>,
  runs: StepRuns | undefined
) =>
  Effect.promise(() => {
    const start = () => {
      const started = Bun.$`sh -c ${command} sh ${paths}`.env({ ...process.env, ...env }).quiet().nothrow()
      return Promise.resolve(cwd === undefined ? started : started.cwd(cwd))
    }
    if (runs === undefined) return start()
    const evidence = Object.entries(env).map(([name, file]) => [name, readFileSync(file, "utf8")])
    const key = JSON.stringify([command, paths, cwd ?? process.cwd(), evidence])
    let run = runs.get(key)
    if (run === undefined) {
      run = start()
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
  use: (policy: Policy, env: Readonly<Record<string, string>>) => Effect.Effect<A, E, R>,
  runs?: StepRuns
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
            const result = yield* shell(step.command, paths, cwd, env, runs)
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
 * Runs `policy.select` with `sh -c`, passing `paths` as its arguments (`"$@"`), from `cwd`, with `env`
 * (from `withEvidence`) set. Its stdout must be JSONL: one item per non-empty line. A non-zero exit or an
 * invalid line fails the run.
 */
export const runSelector = Effect.fn("runSelector")(function*(
  policy: Policy & { readonly select: string },
  paths: ReadonlyArray<string>,
  cwd?: string,
  env: Readonly<Record<string, string>> = {},
  runs?: StepRuns
) {
  const result = yield* shell(policy.select, paths, cwd, env, runs)
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
