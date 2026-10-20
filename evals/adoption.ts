// Measures the adoption features on a generated git repository, against a stub Clef that judges by rule
// (so the bookkeeping is measured exactly, at no cost) and counts the questions it is asked.
//   --baseline: accepted findings stay accepted when code moves; new violations still fail; fixed ones are
//     reported as stale entries.
//   --changed-since: only changed files and items are judged, and no violation in a changed line is missed.
//   bun evals/adoption.ts
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect, Layer, Result } from "effect"
import { applyBaseline, writeBaseline } from "../src/baseline.ts"
import { changedSince } from "../src/changes.ts"
import { Clef } from "../src/clef.ts"
import { type Finding, lint } from "../src/lint.ts"
import { parsePolicy } from "../src/policy.ts"
import { readSources } from "../src/source.ts"

const repository = mkdtempSync(join(tmpdir(), "lint-anything-adoption-"))
process.chdir(repository)
const git = (...command: Array<string>) =>
  Bun.$`git ${command}`.env({ ...process.env, GIT_AUTHOR_NAME: "eval", GIT_AUTHOR_EMAIL: "e@x", GIT_COMMITTER_NAME: "eval", GIT_COMMITTER_EMAIL: "e@x" }).quiet()

// 20 files; every third has an issue-less TODO, every fourth a TODO with an issue, every fifth a debugger.
const write = (path: string, lines: ReadonlyArray<string>) => Bun.write(path, `${lines.join("\n")}\n`)
const base = (index: number) => [
  `export const value${index} = ${index}`,
  ...(index % 3 === 0 ? [`// TODO: tidy module ${index}`] : []),
  ...(index % 4 === 0 ? [`// TODO(#${100 + index}): split module ${index}`] : []),
  `export function run${index}() {`,
  ...(index % 5 === 0 ? ["  debugger"] : []),
  `  return value${index} * 2`,
  "}"
]
const contents = new Map(Array.from({ length: 20 }, (_, index) => [`src/module_${index}.ts`, base(index)]))
for (const [path, lines] of contents) await write(path, lines)
await git("init", "-q")
await git("add", "-A")
await git("commit", "-qm", "init")

const policies = [
  Effect.runSync(parsePolicy("todo", `---
globs: ["src/**/*.ts"]
select: |
  rg --json -w 'TODO|FIXME' "$@" | jq -c 'select(.type == "match") | {id: "\\(.data.path.text):\\(.data.line_number)", path: .data.path.text, lines: [.data.line_number, .data.line_number], text: (.data.lines.text | rtrimstr("\\n"))}'
---
# TODOs reference an issue

Every TODO must reference a tracking issue.
`)),
  Effect.runSync(parsePolicy("no-debugger", `---\nglobs: ["src/**/*.ts"]\n---\n# No debugger\n\nRemove debugger statements.\n`))
]

// The stub decides by rule and counts every question it is asked.
let questions = 0
const issueless = (text: string) => /\b(TODO|FIXME)\b/.test(text) && !/#\d+|[A-Z]+-\d+|https?:\/\//.test(text)
const stub = Layer.succeed(Clef, Clef.of({
  judge: (file, applicable) => {
    questions += applicable.length
    return Effect.succeed(applicable.map(() => Result.succeed({ violates: /\bdebugger\b/.test(file.source) ? 0.95 : 0.05 })))
  },
  judgeItems: (_, items) => {
    questions += items.length
    return Effect.succeed(items.map((item) => Result.succeed({ violates: issueless(item.text) ? 0.95 : 0.05 })))
  },
  stats: Effect.succeed({ requests: 0, cached: 0 })
}))
const run = async (changes?: Awaited<ReturnType<typeof changes0>>) => {
  questions = 0
  const findings = await Effect.runPromise(readSources(["src/**/*.ts"]).pipe(
    Effect.flatMap((files) => lint(files, policies, { threshold: 0.45, itemThreshold: 0.65 }, changes)),
    Effect.provide(Layer.mergeAll(stub, BunServices.layer))
  ))
  return { findings, questions }
}
const changes0 = () => Effect.runPromise(changedSince("HEAD"))
const violations = (findings: ReadonlyArray<Finding>) => findings.filter((finding) => finding.verdict === "violation")
const unaccepted = (findings: ReadonlyArray<Finding>) => violations(findings).filter((finding) => finding.accepted !== true)
const describe = (finding: Finding) => `${finding.policy} ${finding.path}${finding.lines ? `:${finding.lines[0]}` : ""}`
const baseline = join(repository, "baseline.json")
const rows: Array<string> = []
const row = (step: string, expected: string, measured: string) =>
  rows.push(`| ${step} | ${expected} | ${measured} | ${expected === measured ? "yes" : "**no**"} |`)

try {
  // --- Baseline ----------------------------------------------------------------------------------
  const first = await run()
  await Effect.runPromise(writeBaseline(baseline, first.findings))
  const recorded = violations(first.findings).length
  const accepted = async () => Effect.runPromise(applyBaseline(baseline, (await run()).findings))

  let applied = await accepted()
  row("1. re-run with the baseline", `0 new, ${recorded} accepted, 0 stale`,
    `${unaccepted(applied.findings).length} new, ${violations(applied.findings).length - unaccepted(applied.findings).length} accepted, ${applied.stale} stale`)

  // Code moves: five lines at the top of every file shift every finding's lines.
  for (const [path, lines] of contents) {
    contents.set(path, ["// Copyright (c) Acme", "// SPDX-License-Identifier: MIT", "", "import { log } from './log'", "", ...lines])
    await write(path, contents.get(path)!)
  }
  applied = await accepted()
  const lineKeyed = violations(applied.findings).filter((finding) =>
    finding.lines !== undefined && !violations(first.findings).some((old) => old.path === finding.path && old.lines?.[0] === finding.lines![0])).length
  row("2. after shifting every file 5 lines", "0 new, 0 stale",
    `${unaccepted(applied.findings).length} new, ${applied.stale} stale`)
  rows.push(`| | a baseline keyed by line instead would call ${lineKeyed} of ${recorded} accepted findings new | | |`)

  // New violations: an issue-less TODO in a clean file, a second copy of an accepted TODO in its file, a
  // debugger in a clean file, and a debugger in a file whose debugger is already accepted.
  const add = async (path: string, ...lines: Array<string>) => {
    contents.set(path, [...contents.get(path)!, ...lines])
    await write(path, contents.get(path)!)
  }
  await add("src/module_1.ts", "// TODO: new work")
  await add("src/module_3.ts", "// TODO: tidy module 3")
  await add("src/module_2.ts", "export function stop() {", "  debugger", "}")
  await add("src/module_5.ts", "export function halt() {", "  debugger", "}")
  applied = await accepted()
  row("3. after adding 4 violations (one in a file already accepted for no-debugger)", "3 new",
    `${unaccepted(applied.findings).length} new`)
  rows.push(`| | new: ${unaccepted(applied.findings).map(describe).join("; ")} | | |`)

  // Fixes: two accepted TODOs resolved.
  for (const path of ["src/module_6.ts", "src/module_9.ts"]) {
    contents.set(path, contents.get(path)!.map((line) => line.replace(/\/\/ TODO: (.*)/, "// TODO(#77): $1")))
    await write(path, contents.get(path)!)
  }
  applied = await accepted()
  row("4. after fixing 2 accepted TODOs", "3 new, 2 stale", `${unaccepted(applied.findings).length} new, ${applied.stale} stale`)

  // --- Changed scope -----------------------------------------------------------------------------
  await git("add", "-A")
  await git("commit", "-qm", "work")
  await add("src/module_7.ts", "// TODO: follow up")
  await add("src/module_8.ts", "export function pause() {", "  debugger", "}")
  await write("src/module_20.ts", ["// FIXME: brand new file", "export const fresh = 1"])
  const full = await run()
  const changes = await changes0()
  const scoped = await run(changes)
  const changedViolations = violations(full.findings).filter((finding) =>
    finding.lines === undefined ? changes.has(finding.path!) : (() => {
      const ranges = changes.get(finding.path!)
      return ranges === "all" || (ranges ?? []).some(([start, end]) => finding.lines![0] <= end && start <= finding.lines![1])
    })())
  const found = changedViolations.filter((finding) => scoped.findings.some((other) => describe(other) === describe(finding) && other.verdict === "violation"))
  row("5. --changed-since HEAD after touching 3 files (one new)", `${changedViolations.length} of ${changedViolations.length} changed-line violations found`,
    `${found.length} of ${changedViolations.length} changed-line violations found`)
  rows.push(`| | questions asked: ${scoped.questions} with the scope vs. ${full.questions} without; findings: ${scoped.findings.length} vs. ${full.findings.length} | | |`)
} finally {
  process.chdir(import.meta.dir)
  rmSync(repository, { recursive: true, force: true })
}
console.log("\n| Step | Expected | Measured | Holds |\n|---|---|---|---|")
console.log(rows.join("\n"))
