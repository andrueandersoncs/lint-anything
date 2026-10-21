// Measures the answer cache through the CLI's own Clef path (real requests, a temporary cache): a re-run
// should send nothing, an edit should send only the questions it changed, and verdicts of unedited files
// should hold still. Lints 24 dev corpus files with four whole-file policies and two selector policies.
// Repeatability without the cache and batch independence are in evals/packing.ts.
//   bun evals/cache.ts
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect, Layer } from "effect"
import { Clef } from "../src/clef.ts"
import { defaultItemThreshold, defaultThreshold, type Finding, lint } from "../src/lint.ts"
import type { Policy } from "../src/policy.ts"
import { readSources } from "../src/source.ts"
import { corpusDirectory, loadCorpus } from "./corpus.ts"
import { loadSelectorSet } from "./selected.ts"

const corpus = await loadCorpus({ requireSplits: true })
const workspace = mkdtempSync(join(tmpdir(), "lint-anything-cache-"))
const cacheDirectory = join(workspace, ".cache")
const files = corpus.files.filter((file) => file.split === "dev" && file.origin === "real").slice(0, 24)
for (const file of files) await Bun.write(join(workspace, file.id, file.path), file.source)

const filePolicyNames = [
  "semantic/readability/comments-explain-why",
  "semantic/design/single-responsibility",
  "semantic/readability/explain-magic-values",
  "semantic/naming/intent-revealing-names"
]
const selectors = await loadSelectorSet(corpus, `${corpusDirectory}/selectors`)
const policies: Array<Policy> = [
  ...filePolicyNames.map((name) => corpus.policies.find((policy) => policy.name === name)!),
  ...selectors.policies.filter(({ policy }) => ["control/hygiene/todo-has-issue", "semantic/readability/comments-explain-why"].includes(policy.name))
    .map(({ policy }) => ({ ...policy, name: `${policy.name} (selector)` }))
]

process.chdir(workspace)
const run = async (cache: boolean) => {
  const started = performance.now()
  const result = await Effect.runPromise(Effect.gen(function*() {
    const sources = yield* readSources(["**/*.{ts,tsx,js,jsx,py,go}"])
    const findings = yield* lint(sources, policies, { threshold: defaultThreshold, itemThreshold: defaultItemThreshold })
    return { findings, stats: yield* (yield* Clef).stats }
  }).pipe(Effect.provide(Layer.mergeAll(Clef.layer("clef", cache ? cacheDirectory : undefined), BunServices.layer))))
  return { ...result, ms: performance.now() - started }
}
const key = (finding: Finding) => `${finding.policy}\0${finding.path ?? ""}\0${finding.item ?? ""}`
const compare = (a: ReadonlyArray<Finding>, b: ReadonlyArray<Finding>) => {
  const other = new Map(b.map((finding) => [key(finding), finding]))
  const pairs = a.map((finding) => [finding, other.get(key(finding))!] as const)
  if (pairs.some(([, match]) => match === undefined) || a.length !== b.length) throw new Error("runs judged different checks")
  const deltas = pairs.map(([x, y]) => Math.abs((x.violates ?? 0) - (y.violates ?? 0)))
  return {
    sameVerdict: pairs.filter(([x, y]) => x.verdict === y.verdict).length / pairs.length,
    changedVerdicts: pairs.filter(([x, y]) => x.verdict !== y.verdict).length,
    identical: deltas.filter((delta) => delta === 0).length / pairs.length,
    maxDelta: Math.max(...deltas),
    meanDelta: deltas.reduce((sum, delta) => sum + delta, 0) / deltas.length
  }
}

try {
  const cold = await run(true)
  const rerun = await run(true)
  // Edit three files: append a function with a narrating comment, a magic number, and an issue-less TODO.
  const snippets: Record<string, string> = {
    go: "\n// increment the counter\n// TODO: make this configurable\nfunc bump(count int) int {\n\treturn count + 37\n}\n",
    py: "\n\n# increment the counter\n# TODO: make this configurable\ndef bump(count):\n    return count + 37\n",
    ts: "\n\n// increment the counter\n// TODO: make this configurable\nexport function bump(count: number) {\n  return count + 37\n}\n"
  }
  const snippetFor = (path: string) => snippets[path.split(".").pop()!] ?? snippets.ts!
  // The three files first in path order, so their new items shift every later item's batch.
  const edited = [...files].sort((a, b) => `${a.id}/${a.path}`.localeCompare(`${b.id}/${b.path}`)).slice(0, 3)
  for (const file of edited) await Bun.write(join(workspace, file.id, file.path), `${file.source}${snippetFor(file.path)}`)
  const warm = await run(true)
  const fresh = await run(false)
  const percent = (value: number) => `${(value * 100).toFixed(1)}%`
  console.log(`\n${files.length} files, ${policies.length} policies (${filePolicyNames.length} whole-file, 2 selector), ${cold.findings.length} checks before the edit.`)
  console.log("| Run | Requests | Cached answers | Time | Findings vs. a fresh run |")
  console.log("|---|---|---|---|---|")
  const row = (name: string, result: Awaited<ReturnType<typeof run>>, against?: ReadonlyArray<Finding>) => {
    const diff = against === undefined ? undefined : compare(result.findings, against)
    console.log(`| ${name} | ${result.stats.requests} | ${result.stats.cached} | ${(result.ms / 1000).toFixed(1)} s | ` +
      `${diff === undefined ? "–" : `${percent(diff.sameVerdict)} same verdict (${diff.changedVerdicts} differ); ${percent(diff.identical)} identical scores; ` +
        `max Δ ${diff.maxDelta.toFixed(3)}, mean Δ ${diff.meanDelta.toFixed(4)}`} |`)
  }
  row("1. cold cache", cold)
  row("2. re-run, nothing changed", rerun, cold.findings)
  row(`3. after editing ${edited.length} files, cache`, warm, fresh.findings)
  row(`4. after editing ${edited.length} files, no cache`, fresh)
  // Stability: checks of the files nobody edited, before the edit (run 1) vs. after it with and without the cache.
  const editedPaths = new Set(edited.map((file) => `${file.id}/${file.path}`))
  const untouched = (findings: ReadonlyArray<Finding>) => findings.filter((finding) => finding.path !== undefined && !editedPaths.has(finding.path))
  const churn = (after: ReadonlyArray<Finding>) => compare(untouched(cold.findings), untouched(after))
  const withCache = churn(warm.findings)
  const withoutCache = churn(fresh.findings)
  console.log(`\nChecks of the ${files.length - edited.length} unedited files (${untouched(cold.findings).length}), compared with run 1: ` +
    `with the cache ${withCache.changedVerdicts} verdicts changed (mean Δ ${withCache.meanDelta.toFixed(4)}); ` +
    `without it ${withoutCache.changedVerdicts} changed (mean Δ ${withoutCache.meanDelta.toFixed(4)}).`)
} finally {
  process.chdir(import.meta.dir)
  rmSync(workspace, { recursive: true, force: true })
}
