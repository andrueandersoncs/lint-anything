import { BunRuntime, BunServices } from "@effect/platform-bun"
import { Console, Effect, Runtime, Schema } from "effect"
import { Argument, Command, Flag } from "effect/cli"
import { Clef } from "./src/clef.ts"
import { type Finding, lint, type Verdict } from "./src/lint.ts"
import { loadPolicies } from "./src/policy.ts"
import { readSources } from "./src/source.ts"

class ViolationsFound extends Schema.TaggedError<ViolationsFound>()("ViolationsFound", {
  count: Schema.Number
}) {
  override readonly [Runtime.errorExitCode] = 1
  override readonly [Runtime.errorReported] = false
}

const verdicts: ReadonlyArray<Verdict> = ["violation", "review", "inconclusive", "pass"]

const formatText = (findings: ReadonlyArray<Finding>): string => {
  const lines = findings
    .filter((finding) => finding.verdict !== "pass")
    .map((finding) =>
      [
        finding.verdict.padEnd(12),
        (finding.violates?.toFixed(2) ?? "-").padEnd(5),
        finding.path,
        finding.policy,
        finding.reason ?? ""
      ].join("  ").trimEnd()
    )
  const counts = verdicts.map((verdict) =>
    `${findings.filter((finding) => finding.verdict === verdict).length} ${verdict}`
  )
  return [...lines, `${findings.length} checks: ${counts.join(", ")}`].join("\n")
}

const command = Command.make(
  "lint-anything",
  {
    files: Argument.String("files").pipe(
      Argument.withDescription("Globs of files to lint, relative to the current directory"),
      Argument.variadic({ min: 1 })
    ),
    rulesDir: Flag.String("rules-dir").pipe(
      Flag.withDescription("Directory of Markdown policies"),
      Flag.withDefault(".lint-anything/rules")
    ),
    threshold: Flag.Finite("threshold").pipe(
      Flag.withDescription("Violation probability that fails the run"),
      Flag.withSchema(Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 }))),
      Flag.withDefault(0.7)
    ),
    model: Flag.Literals("model", ["clef", "clef-flash"]).pipe(
      Flag.withDescription("Clef model"),
      Flag.withDefault("clef")
    ),
    json: Flag.Boolean("json").pipe(
      Flag.withDescription("Print machine-readable findings"),
      Flag.withDefault(false)
    )
  },
  Effect.fn(function*({ files, rulesDir, threshold, model, json }) {
    const policies = yield* loadPolicies(rulesDir)
    const sources = yield* readSources(files)
    const findings = yield* lint(sources, policies, threshold).pipe(Effect.provide(Clef.layer(model)))
    yield* Console.log(json ? JSON.stringify({ findings }, null, 2) : formatText(findings))
    const count = findings.filter((finding) => finding.verdict === "violation").length
    if (count > 0) {
      return yield* new ViolationsFound({ count })
    }
  })
).pipe(Command.withDescription("Lint files against natural-language policies with Cloudflare Clef"))

command.pipe(
  Command.run({ version: "0.1.0" }),
  Effect.provide(BunServices.layer),
  BunRuntime.runMain
)
