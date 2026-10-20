// Measures how packing items into requests affects answers. (1) Repeatability: two fresh lint runs on the
// same 24 dev corpus files, through the CLI's own Clef path (real requests), must agree, which is why a
// selector's items are sorted before packing. (2) Batch independence: the same dev items judged in full
// batches and in two half-size batches, through the eval client, to show how far answers move when the
// other questions in a request change, and whether quality does.
//   bun evals/packing.ts
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect, Layer } from "effect"
import { Clef } from "../src/clef.ts"
import { type Finding, lint } from "../src/lint.ts"
import type { Policy } from "../src/policy.ts"
import { readSources } from "../src/source.ts"
import { makeClient } from "./client.ts"
import { corpusDirectory, loadCorpus } from "./corpus.ts"
import { auroc, brier, pairedInterval } from "./metrics.ts"
import { loadSelectorSet, productionPlan, scoreItems, selectItems } from "./selected.ts"

const corpus = await loadCorpus({ requireSplits: true })
const selectors = await loadSelectorSet(corpus, `${corpusDirectory}/selectors`)

// --- (1) Repeatability -------------------------------------------------------------------------------
const workspace = mkdtempSync(join(tmpdir(), "lint-anything-packing-"))
const files = corpus.files.filter((file) => file.split === "dev" && file.origin === "real").slice(0, 24)
for (const file of files) await Bun.write(join(workspace, file.id, file.path), file.source)
const policies: Array<Policy> = [
  ...["semantic/readability/comments-explain-why", "semantic/design/single-responsibility"].map((name) => corpus.policies.find((policy) => policy.name === name)!),
  ...selectors.policies.filter(({ policy }) => ["control/hygiene/todo-has-issue", "semantic/readability/comments-explain-why"].includes(policy.name))
    .map(({ policy }) => ({ ...policy, name: `${policy.name} (selector)` }))
]
const cwd = process.cwd()
process.chdir(workspace)
const run = () => Effect.runPromise(readSources(["**/*.{ts,tsx,js,jsx,py,go}"]).pipe(
  Effect.flatMap((sources) => lint(sources, policies, { threshold: 0.45, itemThreshold: 0.65 })),
  Effect.provide(Layer.mergeAll(Clef.layer("clef"), BunServices.layer))
))
try {
  const [first, second] = [await run(), await run()]
  const key = (finding: Finding) => `${finding.policy}\0${finding.path ?? ""}\0${finding.item ?? ""}`
  const other = new Map(second.map((finding) => [key(finding), finding]))
  const differ = first.filter((finding) => other.get(key(finding))?.verdict !== finding.verdict).length
  const identical = first.filter((finding) => other.get(key(finding))?.violates === finding.violates).length
  console.log(`\nRepeatability: two fresh runs over ${files.length} files (${first.length} checks): ${differ} verdicts differ, ${identical} of ${first.length} scores identical.`)
} finally {
  process.chdir(cwd)
  rmSync(workspace, { recursive: true, force: true })
}

// --- (2) Batch independence -------------------------------------------------------------------------
const ask = makeClient(8)
const { items } = await selectItems(corpus, "dev", selectors)
const full = await scoreItems(ask, items, productionPlan)
const halves = await scoreItems(ask, items, (policy, entries) => {
  const parts = [0, 1].map((parity) => entries.flatMap((entry, index) => (index % 2 === parity ? [{ entry, index }] : [])))
  const planned = parts.map((part) => ({ part, plan: productionPlan(policy, part.map(({ entry }) => entry)) }))
  return {
    requests: planned.flatMap(({ part, plan }) =>
      plan.requests.map((request) => ({ body: request.body, questions: request.questions.map(({ id, index }) => ({ id, index: part[index]!.index })) }))),
    oversized: planned.flatMap(({ part, plan }) => plan.oversized.map((index) => part[index]!.index))
  }
})
const deltas = full.scored.map((scored, index) => Math.abs((scored.score ?? 0) - (halves.scored[index]!.score ?? 0)))
const verdictOfScore = (score: number) => (score <= 0.5 ? "pass" : score >= 0.65 ? "violation" : "review")
const changed = full.scored.filter((scored, index) => verdictOfScore(scored.score ?? 0) !== verdictOfScore(halves.scored[index]!.score ?? 0)).length
const interval = (metric: typeof auroc) => {
  const [low, high] = pairedInterval(full.scored, halves.scored, metric)
  return `[${low >= 0 ? "+" : ""}${low.toFixed(3)}, ${high >= 0 ? "+" : ""}${high.toFixed(3)}]`
}
console.log(`\nBatch independence, ${items.length} dev items: full batches (${full.requests} requests) vs. half batches (${halves.requests} requests): ` +
  `${((100 * deltas.filter((delta) => delta === 0).length) / deltas.length).toFixed(1)}% identical answers, max Δ ${Math.max(...deltas).toFixed(4)}, ` +
  `mean Δ ${(deltas.reduce((sum, delta) => sum + delta, 0) / deltas.length).toFixed(5)}, ${changed} item verdicts differ.`)
console.log(`Quality: AUROC ${auroc(full.scored).toFixed(3)} → ${auroc(halves.scored).toFixed(3)} ${interval(auroc)}; ` +
  `Brier ${brier(full.scored).toFixed(3)} → ${brier(halves.scored).toFixed(3)} ${interval(brier)}.`)
