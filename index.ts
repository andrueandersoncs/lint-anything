import { BunRuntime, BunServices } from "@effect/platform-bun"
import { Console, Effect, Runtime, Schema } from "effect"
import { Argument, Command, Flag } from "effect/cli"
import { blame, currentDate } from "./src/blame.ts"
import { check, type ExampleResult } from "./src/check.ts"
import { Clef } from "./src/clef.ts"
import { enclosing } from "./src/enclosing.ts"
import { defaultItemThreshold, defaultThreshold, type Finding, lint, type Verdict } from "./src/lint.ts"
import { loadPolicies } from "./src/policy.ts"
import { readSources } from "./src/source.ts"

class ViolationsFound extends Schema.TaggedError<ViolationsFound>()("ViolationsFound", {
  count: Schema.Number
}) {
  override readonly [Runtime.errorExitCode] = 1
  override readonly [Runtime.errorReported] = false
}

class ExamplesDisagree extends Schema.TaggedError<ExamplesDisagree>()("ExamplesDisagree", {
  count: Schema.Number
}) {
  override readonly [Runtime.errorExitCode] = 1
  override readonly [Runtime.errorReported] = false
}

const verdicts: ReadonlyArray<Verdict> = ["violation", "review", "inconclusive", "pass"]

/** Where a finding is: a file's path, an item's `path:start-end`, or else the item's id. */
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

const formatCheck = (results: ReadonlyArray<ExampleResult>): string => {
  const lines = results.map((result) =>
    [
      result.outcome.padEnd(9),
      (result.score?.toFixed(2) ?? "-").padEnd(5),
      result.policy,
      `${result.example} (${result.violates ? "violates" : "complies"}): ${result.verdict}`
    ].join("  ")
  )
  const count = (outcome: ExampleResult["outcome"]) => results.filter((result) => result.outcome === outcome).length
  return [...lines, `${results.length} examples: ${count("agree")} agree, ${count("unsure")} unsure, ${count("disagree")} disagree`].join("\n")
}

const sharedFlags = {
  rulesDir: Flag.String("rules-dir").pipe(
    Flag.withDescription("Directory of Markdown policies"),
    Flag.withDefault(".lint-anything/rules")
  ),
  threshold: Flag.Finite("threshold").pipe(
    Flag.withDescription("Violation probability that fails the run, for policies judged per file"),
    Flag.withSchema(Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 }))),
    Flag.withDefault(defaultThreshold)
  ),
  itemThreshold: Flag.Finite("item-threshold").pipe(
    Flag.withDescription("Violation probability that fails the run, for items from a policy's selector"),
    Flag.withSchema(Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 }))),
    Flag.withDefault(defaultItemThreshold)
  ),
  model: Flag.Literals("model", ["clef", "clef-flash"]).pipe(
    Flag.withDescription("Clef model"),
    Flag.withDefault("clef")
  ),
  json: Flag.Boolean("json").pipe(
    Flag.withDescription("Print machine-readable results"),
    Flag.withDefault(false)
  )
}

const command = Command.make(
  "lint-anything",
  {
    files: Argument.String("files").pipe(
      Argument.withDescription("Globs of files to lint, relative to the current directory"),
      Argument.variadic({ min: 1 })
    ),
    ...sharedFlags
  },
  Effect.fn(function*({ files, rulesDir, threshold, itemThreshold, model, json }) {
    const policies = yield* loadPolicies(rulesDir)
    const sources = yield* readSources(files)
    const findings = yield* lint(sources, policies, { threshold, itemThreshold }).pipe(Effect.provide(Clef.layer(model)))
    yield* Console.log(json ? JSON.stringify({ findings }, null, 2) : formatText(findings))
    const count = findings.filter((finding) => finding.verdict === "violation").length
    if (count > 0) {
      return yield* new ViolationsFound({ count })
    }
  })
).pipe(
  Command.withDescription("Lint files against natural-language policies with Cloudflare Clef"),
  Command.withSubcommands([
    Command.make("check", sharedFlags, Effect.fn(function*({ rulesDir, threshold, itemThreshold, model, json }) {
      const policies = yield* loadPolicies(rulesDir)
      const results = yield* check(policies, { threshold, itemThreshold }).pipe(Effect.provide(Clef.layer(model)))
      yield* Console.log(json ? JSON.stringify({ examples: results }, null, 2) : formatCheck(results))
      const count = results.filter((result) => result.outcome === "disagree").length
      if (count > 0) return yield* new ExamplesDisagree({ count })
    })).pipe(
      Command.withDescription("Judge each policy's examples against its rule (without the examples); fails when one disagrees")
    ),
    Command.make("enclosing", {}, enclosing).pipe(
      Command.withDescription("Selector step: add each item's enclosing block as `enclosing` evidence (JSONL in, JSONL out)")
    ),
    Command.make("blame", {
      today: Flag.String("today").pipe(
        Flag.withDescription("Date ages are counted to, YYYY-MM-DD (default: today, UTC)"),
        Flag.withDefault(currentDate())
      )
    }, ({ today }) => blame(today)).pipe(
      Command.withDescription("Selector step: add when each item's lines last changed in git as `changed` evidence (JSONL in, JSONL out)")
    )
  ])
)

command.pipe(
  Command.run({ version: "0.1.0" }),
  Effect.provide(BunServices.layer),
  BunRuntime.runMain
)
