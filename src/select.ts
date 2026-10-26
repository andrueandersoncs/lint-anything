import { Effect, Runtime, Schema } from "effect"
import { parseItem } from "./item.ts"
import type { Policy } from "./policy.ts"

export class SelectorError extends Schema.TaggedError<SelectorError>()("SelectorError", {
  message: Schema.String
}) {
  override readonly [Runtime.errorExitCode] = 2
}

/** A selector still running after this long is killed, with everything it started, and fails the run. */
export const selectorTimeoutMinutes = 10

interface SelectorOutput {
  readonly exitCode: number
  readonly timedOut: boolean
  readonly stdout: string
  readonly stderr: string
}

/**
 * The selectors one lint run has started, so policies with the same selector run it once. Create one per
 * run: what selectors read may change between runs.
 */
export type SelectorRuns = Map<string, Promise<SelectorOutput>>

const killGroup = (pid: number) => {
  try {
    process.kill(-pid, "SIGKILL")
  } catch (error) {
    // ESRCH: everything in the group has already exited. EPERM: on macOS, everything in it has exited but
    // hasn't been reaped yet. Either way there is nothing left to kill, and this runs on `exit`, where a
    // throw would turn a run's exit code into 1 and print a stack trace.
    const { code } = error as NodeJS.ErrnoException
    if (code !== "ESRCH" && code !== "EPERM") throw error
  }
}

// Each selector runs in its own process group, so a timeout can kill a whole pipeline rather than just
// `sh`. That also keeps a terminal's Ctrl-C, or its hangup, from reaching it, so the groups still running
// when the process exits (a failed run, an interrupt) are killed here. SIGINT and SIGTERM interrupt the run
// and end in `exit`. SIGHUP kills the process without `exit`; signal handling is the host's, so the CLI
// installs its SIGHUP handler itself (`killRunningSelectors`).
const running = new Set<number>()
/** Kills every selector process group still running. */
export const killRunningSelectors = () => {
  for (const pid of running) killGroup(pid)
}
process.on("exit", killRunningSelectors)

const start = async (select: string, cwd: string | undefined): Promise<SelectorOutput> => {
  const child = Bun.spawn(["sh", "-c", select], {
    cwd,
    // The environment as it is now (Bun.spawn's default is the one the process started with), without the
    // `CLOUDFLARE_` variables: a selector is a policy's shell, and the API token must not reach it.
    env: Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("CLOUDFLARE_"))),
    // An empty stdin (/dev/null): without one, tools such as rg search stdin when it is a pipe, so the
    // CLI's own stdin would silently become the selector's input.
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    detached: true
  })
  running.add(child.pid)
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    killGroup(child.pid)
  }, selectorTimeoutMinutes * 60 * 1000)
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited
    ])
    return { exitCode, timedOut, stdout, stderr }
  } finally {
    clearTimeout(timer)
    running.delete(child.pid)
  }
}

/**
 * Runs `policy.select` with `sh -c` from `cwd`, with no arguments and an empty stdin: the selector finds
 * what it judges itself. Its stdout must be JSONL: one item per non-empty line. A non-zero exit, an invalid
 * line, or running longer than `selectorTimeoutMinutes` fails the run. With `runs`, a selector already run
 * with the same command and directory reuses that run's output.
 */
export const runSelector = Effect.fn("runSelector")(function*(
  policy: Policy,
  cwd?: string,
  runs?: SelectorRuns
) {
  const result = yield* Effect.promise(() => {
    if (runs === undefined) return start(policy.select, cwd)
    const key = JSON.stringify([policy.select, cwd ?? process.cwd()])
    let run = runs.get(key)
    if (run === undefined) {
      run = start(policy.select, cwd)
      runs.set(key, run)
    }
    return run
  })
  if (result.timedOut) {
    return yield* new SelectorError({
      message: `${policy.name}: selector did not finish within ${selectorTimeoutMinutes} minutes and was killed`
    })
  }
  if (result.exitCode !== 0) {
    return yield* new SelectorError({
      message: `${policy.name}: selector exited ${result.exitCode}: ${result.stderr.trim().slice(0, 500)}`
    })
  }
  const lines = result.stdout.split("\n")
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
