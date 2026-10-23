import { BunRuntime, BunServices } from "@effect/platform-bun"
import { Console, Effect, Runtime, Schema } from "effect"
import { Command } from "effect/cli"
import { Clef } from "./src/clef.ts"
import { defaultThreshold, type Finding, lint, type Verdict } from "./src/lint.ts"
import { loadPolicies } from "./src/policy.ts"

class ViolationsFound extends Schema.TaggedError<ViolationsFound>()("ViolationsFound", {
  count: Schema.Number
}) {
  override readonly [Runtime.errorExitCode] = 1
  override readonly [Runtime.errorReported] = false
}

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

const command = Command.make(
  "lint-anything",
  {},
  Effect.fn(function*() {
    const policies = yield* loadPolicies(rulesDirectory)
    const findings = yield* lint(policies, defaultThreshold).pipe(
      Effect.provide(Clef.layer("clef", cacheDirectory))
    )
    yield* Console.log(formatText(findings))
    const count = findings.filter((finding) => finding.verdict === "violation").length
    if (count > 0) {
      return yield* new ViolationsFound({ count })
    }
  })
).pipe(Command.withDescription(`Check every policy in ${rulesDirectory} with Cloudflare Clef`))

command.pipe(
  Command.run({ version: "0.1.0" }),
  Effect.provide(BunServices.layer),
  BunRuntime.runMain
)
