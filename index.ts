#!/usr/bin/env bun
import { BunRuntime, BunServices } from "@effect/platform-bun"
import { Console, Effect, Runtime, Schema } from "effect"
import { CliError, Command, Flag } from "effect/cli"
import { Clef, inputTokenPrice, noUsage, sumUsage, type Usage } from "./src/clef.ts"
import { defaultThreshold, type Finding, lint, type Verdict } from "./src/lint.ts"
import { loadPolicies, type Policy } from "./src/policy.ts"
import { killRunningSelectors } from "./src/select.ts"
import { version } from "./package.json" with { type: "json" }

// SIGHUP (the terminal closed) kills the CLI without `exit`, so it kills running selectors first and then
// dies of SIGHUP as it would have.
process.once("SIGHUP", () => {
  killRunningSelectors()
  process.kill(process.pid, "SIGHUP")
})

class ViolationsFound extends Schema.TaggedError<ViolationsFound>()("ViolationsFound", {
  count: Schema.Number
}) {
  override readonly [Runtime.errorExitCode] = 1
  override readonly [Runtime.errorReported] = false
}

/** The command line was invalid; the CLI has already printed the error with its help. */
class UsageError extends Schema.TaggedError<UsageError>()("UsageError", {}) {
  override readonly [Runtime.errorExitCode] = 2
  override readonly [Runtime.errorReported] = false
}

/** A run-stopping error, already printed to stderr as `error: <message>`. */
class RunFailed extends Schema.TaggedError<RunFailed>()("RunFailed", {}) {
  override readonly [Runtime.errorExitCode] = 2
  override readonly [Runtime.errorReported] = false
}

const runStopping = ["PolicyError", "SelectorError", "ClefError"]

const rulesDirectory = ".lint-anything/rules"
const cacheDirectory = ".lint-anything/cache"
const verdicts: ReadonlyArray<Verdict> = ["violation", "review", "inconclusive", "pass"]

/** Where a finding is: an item's `path:start-end`, else the item's id, else (a `limit` group) its path. */
const location = ({ path, item, lines }: Finding) =>
  path !== undefined && lines !== undefined ? `${path}:${lines[0]}-${lines[1]}` : item ?? path ?? ""

const formatText = (findings: ReadonlyArray<Finding>): string => {
  const lines = findings
    .filter((finding) => finding.verdict !== "pass")
    .map((finding) =>
      [
        finding.verdict.padEnd(12),
        (finding.violates?.toFixed(2) ?? "-").padEnd(5),
        location(finding),
        finding.policy,
        finding.reason ?? ""
      ].join("  ").trimEnd()
    )
  const counts = verdicts.map((verdict) =>
    `${findings.filter((finding) => finding.verdict === verdict).length} ${verdict}`
  )
  return [...lines, `${findings.length} checks: ${counts.join(", ")}`].join("\n")
}

/** A table of what each policy, and the run, cost: requests sent, answers from the cache, input tokens, USD. */
const formatUsage = (policies: ReadonlyArray<Policy>, usage: ReadonlyMap<string, Usage>): string => {
  const total = sumUsage(usage.values())
  const rows = [
    ["policy", "requests", "cached", "input tokens", "cost (USD)"],
    ...[...policies.map((policy) => [policy.name, usage.get(policy.name) ?? noUsage] as const), ["total", total] as const].map(
      ([name, { requests, cached, inputTokens }]) =>
        [name, String(requests), String(cached), String(inputTokens), `$${(inputTokens * inputTokenPrice).toFixed(4)}`]
    )
  ]
  const widths = rows[0]!.map((_, column) => Math.max(...rows.map((row) => row[column]!.length)))
  const lines = rows.map((row) =>
    row.map((cell, column) => (column === 0 ? cell.padEnd(widths[column]!) : cell.padStart(widths[column]!))).join("  ")
  )
  if (total.unmetered > 0) {
    lines.push(`${total.unmetered} requests reported no token count; their cost is not included`)
  }
  return lines.join("\n")
}

const command = Command.make(
  "lint-anything",
  {
    debug: Flag.Boolean("debug").pipe(
      Flag.withDefault(false),
      Flag.withDescription("Also print debugging details to stderr: each policy's requests, cached answers, input tokens, and cost")
    )
  },
  Effect.fn(function*({ debug }) {
    const policies = yield* loadPolicies(rulesDirectory)
    const findings = yield* Effect.gen(function*() {
      const clef = yield* Clef
      // A failed run is reported too: its requests cost the same.
      const printUsage = debug ? Effect.flatMap(clef.stats, (usage) => Console.error(formatUsage(policies, usage))) : Effect.void
      const findings = yield* lint(policies, defaultThreshold).pipe(Effect.onError(() => printUsage))
      yield* Console.log(formatText(findings))
      yield* printUsage
      return findings
    }).pipe(Effect.provide(Clef.layer(cacheDirectory)))
    const count = findings.filter((finding) => finding.verdict === "violation").length
    if (count > 0) {
      return yield* new ViolationsFound({ count })
    }
  })
).pipe(Command.withDescription(`Check every policy in ${rulesDirectory} with Cloudflare Clef`))

command.pipe(
  Command.run({ version }),
  // Exit 1 means violations, so an invalid command line (help with errors, which the CLI has printed)
  // exits 2 like every other error that stops a run. `--help` alone still exits 0.
  Effect.catchIf(
    (error) => CliError.isCliError(error) && !(error._tag === "ShowHelp" && error.errors.length === 0),
    () => Effect.fail(new UsageError())
  ),
  // Stopping errors go to stderr as their message alone: stdout holds only findings, and Effect's default
  // report (timestamp, stack through node_modules) is noise to whoever acts on it.
  Effect.catchIf(
    (error): error is Extract<typeof error, { readonly message: string }> => runStopping.includes(error._tag),
    (error) => Console.error(`error: ${error.message}`).pipe(Effect.andThen(Effect.fail(new RunFailed())))
  ),
  Effect.provide(BunServices.layer),
  BunRuntime.runMain
)
