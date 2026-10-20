// Measures --sarif: the log must validate against the SARIF 2.1.0 schema, and every non-passing finding must
// map to exactly one result with the right rule, level, file, and lines (findings without a path to a result
// without a location; baseline-accepted ones to suppressed results). Lints a generated repository against a
// stub Clef, so the run is free and exact; validates with ajv against the published schema (fetched), and
// checks the validator rejects a deliberately broken log.
//   bun evals/sarif.ts
import Ajv from "ajv"
import addFormats from "ajv-formats"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect, Layer, Result } from "effect"
import { applyBaseline, writeBaseline } from "../src/baseline.ts"
import { Clef } from "../src/clef.ts"
import { type Finding, lint } from "../src/lint.ts"
import { parsePolicy } from "../src/policy.ts"
import { toSarif } from "../src/sarif.ts"
import { readSources } from "../src/source.ts"

const directory = mkdtempSync(join(tmpdir(), "lint-anything-sarif-"))
process.chdir(directory)
const git = (...command: Array<string>) =>
  Bun.$`git ${command}`.env({ ...process.env, GIT_AUTHOR_NAME: "eval", GIT_AUTHOR_EMAIL: "e@x", GIT_COMMITTER_NAME: "eval", GIT_COMMITTER_EMAIL: "e@x" }).quiet()
await Bun.write("src/a.ts", "// TODO: tidy\nexport const a = 1\n")
await Bun.write("src/b.ts", "export function b() {\n  debugger\n  return 2\n}\n// TODO(#4): split\n")
await Bun.write("src/c.ts", "// FIXME: retry\nexport const c = 3\n")
await git("init", "-q")
await git("add", "-A")
await git("commit", "-qm", "fixed stuff")

const policies = [
  Effect.runSync(parsePolicy("todo", `---
globs: ["src/**/*.ts"]
select: |
  rg --json -w 'TODO|FIXME' "$@" | jq -c 'select(.type == "match") | {id: "\\(.data.path.text):\\(.data.line_number)", path: .data.path.text, lines: [.data.line_number, .data.line_number], text: (.data.lines.text | rtrimstr("\\n"))}'
---
# TODOs reference an issue

Every TODO must reference a tracking issue.
`)),
  Effect.runSync(parsePolicy("no-debugger", `---\nglobs: ["src/**/*.ts"]\n---\n# No debugger\n\nRemove debugger statements.\n`)),
  Effect.runSync(parsePolicy("commits", `---
select: |
  git log -3 --format=%H%x09%s | jq -cR 'split("\\t") | {id: .[0][0:8], text: .[1]}'
---
# Commit subjects are imperative

Each commit subject starts with an imperative verb.
`))
]
const stub = Layer.succeed(Clef, Clef.of({
  judge: (file, applicable) => Effect.succeed(applicable.map(() => Result.succeed({ violates: /debugger/.test(file.source) ? 0.95 : 0.05 }))),
  judgeItems: (_, items) => Effect.succeed(items.map((item) => Result.succeed({
    violates: /fixed/.test(item.text) ? 0.55 : /\b(TODO|FIXME)\b/.test(item.text) && !/#\d+/.test(item.text) ? 0.9 : 0.1
  }))),
  stats: Effect.succeed({ requests: 0, cached: 0 })
}))
const run = () => Effect.runPromise(readSources(["src/**/*.ts"]).pipe(
  Effect.flatMap((files) => lint(files, policies, { threshold: 0.45, itemThreshold: 0.65 })),
  Effect.provide(Layer.mergeAll(stub, BunServices.layer))
))

const rows: Array<string> = []
const check = (what: string, holds: boolean, detail = "") => rows.push(`| ${what} | ${holds ? "yes" : "**no**"} | ${detail} |`)
try {
  // Accept a.ts's TODO through a baseline so one result is suppressed.
  const first = await run()
  await Effect.runPromise(writeBaseline("baseline.json", first.filter((finding) => finding.path === "src/a.ts")))
  const { findings } = await Effect.runPromise(applyBaseline("baseline.json", first))
  const log = toSarif(findings, policies, "0.1.0")
  const schema = (await (await fetch("https://json.schemastore.org/sarif-2.1.0.json")).json()) as object
  const ajv = new Ajv({ strict: false, allErrors: true })
  addFormats(ajv)
  const validate = ajv.compile(schema)
  const valid = validate(JSON.parse(JSON.stringify(log)))
  check("validates against the SARIF 2.1.0 schema", valid, valid ? "" : ajv.errorsText(validate.errors))
  const broken = structuredClone(log) as any
  broken.runs[0].results[0].level = "fatal"
  check("the validator rejects a log with an invalid level", !validate(broken))

  const reportable = findings.filter((finding) => finding.verdict !== "pass")
  const results = log.runs[0]!.results
  check("one result per non-passing finding", results.length === reportable.length, `${results.length} results, ${reportable.length} findings`)
  const levels: Record<string, string> = { violation: "error", review: "warning", inconclusive: "note" }
  const mismatches = reportable.filter((finding: Finding, index) => {
    const result = results[index]! as any
    const location = result.locations?.[0]?.physicalLocation
    return result.ruleId !== finding.policy || result.level !== levels[finding.verdict] ||
      (finding.path === undefined ? location !== undefined : location?.artifactLocation?.uri !== finding.path) ||
      (finding.lines !== undefined && (location?.region?.startLine !== finding.lines[0] || location?.region?.endLine !== finding.lines[1])) ||
      ((finding.accepted === true) !== (result.suppressions !== undefined))
  })
  check("rule, level, file, lines, and suppression match each finding", mismatches.length === 0,
    `${reportable.filter((finding) => finding.path === undefined).length} without a path, ${reportable.filter((finding) => finding.accepted).length} accepted, ` +
      `${reportable.filter((finding) => finding.lines !== undefined).length} with lines`)
} finally {
  process.chdir(import.meta.dir)
  rmSync(directory, { recursive: true, force: true })
}
console.log("\n| Check | Holds | Detail |\n|---|---|---|")
console.log(rows.join("\n"))
