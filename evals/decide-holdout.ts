// One-time locked decision runner on the fresh H26 holdout (evals/corpus/holdout/holdout.jsonl).
// Enforces the H25/H26 rule: a holdout decides ONCE (locking `.spent` afterward so a second candidate
// cannot reuse it; pass `--force` only to re-print from cache).
//   bun evals/decide-holdout.ts [--selectors evals/corpus/policies-v2] [--concurrency 6] [--force]
import { existsSync } from "node:fs"
import { join, resolve } from "node:path"
import { Effect } from "effect"
import { parsePolicy, type Policy } from "../src/policy.ts"
import type { Item } from "../src/item.ts"
import { runSelector } from "../src/select.ts"
import {
  auprc,
  auroc,
  brier,
  cliThresholds,
  labelFileItems,
  pairedInterval,
  quality,
  reachedRanges,
  type Scored,
  targetScore,
  tprAtFpr,
  verdictF1,
  violationPrecision
} from "../src/score.ts"
import { makeClient, model } from "./client.ts"
import { type Case, type CorpusFile, type Gold, loadCorpus, ruleText, scoreLabel } from "./corpus.ts"
import { clef } from "../src/decision-model.ts"
import { costPerThousand, type ItemCase, productionPlan, scoreItems, writeScores } from "./selected.ts"

const holdoutDir = join(import.meta.dir, "corpus/holdout")
const labeledPath = join(holdoutDir, "holdout.jsonl")
const filesDir = join(holdoutDir, "files")
const spentLock = join(holdoutDir, ".spent")

const args = Bun.argv.slice(2)
const flag = (name: string, fallback: string) => {
  const idx = args.indexOf(name)
  return idx === -1 ? fallback : (args[idx + 1] ?? fallback)
}
const candidateArg = flag("--selectors", "")
if (candidateArg === "") throw new Error("usage: bun evals/decide-holdout.ts --selectors <candidate-policies-dir> [--concurrency 6] [--force]")
const candidateDir = resolve(candidateArg)
const concurrency = Number(flag("--concurrency", "6"))
const force = args.includes("--force")

if (!existsSync(labeledPath)) {
  throw new Error(`Missing fresh holdout at ${labeledPath}. Run \`bun evals/holdout.ts --sample\` and \`--label\` first.`)
}
if (existsSync(spentLock) && !force) {
  throw new Error(`Holdout already spent (${await Bun.file(spentLock).text()}). Per H25/H26, fold it into dev and label a fresh holdout for the next decision, or pass --force to replay cached scores.`)
}

interface RawHoldout {
  readonly id: string
  readonly path: string
  readonly split: "test"
  readonly origin: "real"
  readonly upstream: CorpusFile["upstream"]
  readonly provenance: CorpusFile["provenance"]
  readonly labels: Record<string, Gold>
}

const rawRows = (await Bun.file(labeledPath).text()).trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as RawHoldout)
const corpus = await loadCorpus({ requireSplits: false })
const basePolicies = new Map(corpus.policies.filter((p) => p.name.startsWith("semantic/")).map((p) => [p.name, p]))

// Load candidate policies and verify exact Rule: parity
const candPolicies = new Map<string, Policy>(basePolicies)
for await (const rel of new Bun.Glob("**/*.md").scan(candidateDir)) {
  const name = rel.slice(0, -".md".length)
  const parsed = Effect.runSync(parsePolicy(name, await Bun.file(join(candidateDir, rel)).text()))
  const orig = basePolicies.get(name)
  if (!orig) throw new Error(`candidate policy ${name} has no corpus namesake`)
  if (ruleText(parsed) !== ruleText(orig)) throw new Error(`candidate policy ${name} differs in Rule: text`)
  candPolicies.set(name, parsed)
}

const files: Array<CorpusFile> = await Promise.all(
  rawRows.map(async (r) => ({
    id: r.id,
    path: r.path,
    slice: "holdout",
    source: await Bun.file(join(filesDir, r.id, r.path)).text(),
    origin: r.origin,
    split: r.split,
    upstream: r.upstream,
    provenance: r.provenance,
    labels: r.labels
  }))
)
const fileById = new Map(files.map((f) => [f.id, f]))

const cases: Array<Case> = []
for (const r of rawRows) {
  const file = fileById.get(r.id)!
  for (const [polName, gold] of Object.entries(r.labels)) {
    const policy = basePolicies.get(polName)
    if (policy) cases.push({ id: `${r.id}:${polName}`, file, policy, gold })
  }
}

const selectAll = async (polMap: ReadonlyMap<string, Policy>) => {
  const items: Array<ItemCase> = []
  let totalRanges = 0
  let hitRanges = 0
  const limit = 8
  let next = 0
  const out: Array<{ c: Case; pol: Policy; selected: ReadonlyArray<Item> }> = []
  await Promise.all(
    Array.from({ length: limit }, async () => {
      while (next < cases.length) {
        const i = next++
        const c = cases[i]!
        const pol = polMap.get(c.policy.name)!
        const selected = await Effect.runPromise(runSelector(pol, join(filesDir, c.file.id)))
        out[i] = { c, pol, selected }
      }
    })
  )
  for (const { c, pol, selected } of out) {
    const target = { label: scoreLabel(c.gold.label), ...(c.gold.lines ? { lines: c.gold.lines } : {}) }
    const labels = labelFileItems(target, selected)
    selected.forEach((entry, idx) => {
      items.push({ id: `${c.id}:${entry.id}`, file: c.file, policy: pol, gold: { label: labels[idx]!, note: "" }, entry })
    })
    if (c.gold.label === "violates" && c.gold.lines) {
      totalRanges += c.gold.lines.length
      hitRanges += reachedRanges(c.gold.lines, selected)
    }
  }
  return { items, totalRanges, hitRanges }
}

const ask = makeClient(concurrency)
const runVariant = async (name: string, polMap: ReadonlyMap<string, Policy>) => {
  const { items, totalRanges, hitRanges } = await selectAll(polMap)
  const scored = await scoreItems(ask, items, productionPlan)
  const byCase = new Map<string, Array<Scored<ItemCase>>>()
  for (const s of scored.scored) {
    const k = `${s.subject.file.id}\0${s.subject.policy.name}`
    const arr = byCase.get(k)
    if (arr) arr.push(s)
    else byCase.set(k, [s])
  }
  const fileScored: Array<Scored<Case>> = cases.map((c) => {
    const list = byCase.get(`${c.file.id}\0${c.policy.name}`) ?? []
    return { subject: c, label: scoreLabel(c.gold.label), group: c.file.id, score: targetScore(list.map((x) => x.score)) }
  })
  const violFiles = fileScored.filter((f) => f.label === "violates")
  const localized = violFiles.filter((f) =>
    (byCase.get(`${f.subject.file.id}\0${f.subject.policy.name}`) ?? []).some(
      (it) => it.label === "violates" && (it.score ?? 0) >= cliThresholds.threshold
    )
  ).length / (violFiles.length || 1)
  const tokens = [...scored.inputTokens.values()].reduce((a, b) => a + b, 0)
  return { name, fileScored, itemScored: scored.scored, localized, totalRanges, hitRanges, requests: scored.requests, tokens }
}

const base = await runVariant("production", basePolicies)
const cand = await runVariant(candidateDir.split("/").pop()!, candPolicies)

const scope = model.cacheKey === clef.cacheKey
  ? "holdout.real.semantic"
  : `holdout.real.semantic.model-${model.model.replace(/[^\w.-]+/g, "-")}`
const outDir = join(import.meta.dir, "results", scope)
await Bun.write(join(outDir, ".keep"), "")
await writeScores(join(outDir, `${base.name}.jsonl`), base.fileScored)
await writeScores(join(outDir, `${base.name}.items.jsonl`), base.itemScored)
await writeScores(join(outDir, `${cand.name}.jsonl`), cand.fileScored)
await writeScores(join(outDir, `${cand.name}.items.jsonl`), cand.itemScored)

const app = (arr: ReadonlyArray<Scored<Case>>) => arr.filter((x) => x.subject.gold.label !== "not-applicable")
const clear = <A>(arr: ReadonlyArray<Scored<A>>) => arr.filter((x) => x.label !== "ambiguous")
const signed = (v: number) => `${v >= 0 ? "+" : ""}${v.toFixed(3)}`
const pct = (v: number) => `${(v * 100).toFixed(1)}%`

console.log(`\nFRESH H26 HOLDOUT DECISION (${files.length} unseen real files, ${cases.length} cases, ${base.fileScored.filter((f) => f.label === "violates").length} clear violations, ${model.name}):\n`)
console.log("| Variant | File AUROC [Δ 95%] | Appl. AUROC [Δ 95%] | TPR@5% | Brier [Δ 95%] | Verdict F1 | Caught (Loc.) | FA | Item AUROC | Item PR-AUC | Item Prec(V) | Reach | $/1k files |")
console.log("|---|---|---|---|---|---|---|---|---|---|---|---|---|")
for (const r of [base, cand]) {
  const q = quality(r.fileScored, cliThresholds)
  const rApp = app(r.fileScored)
  const rIt = clear(r.itemScored)
  const isBase = r === base
  const fCi = isBase ? "" : ` [${pairedInterval(base.fileScored, r.fileScored, auroc).map(signed).join(", ")}]`
  const aCi = isBase ? "" : ` [${pairedInterval(app(base.fileScored), rApp, auroc).map(signed).join(", ")}]`
  const bCi = isBase ? "" : ` [${pairedInterval(base.fileScored, r.fileScored, brier).map(signed).join(", ")}]`
  console.log(
    `| ${r.name} | ${q.auroc.toFixed(3)}${fCi} | ${auroc(rApp).toFixed(3)}${aCi} | ${pct(tprAtFpr(r.fileScored, 0.05))} | ` +
    `${q.brier.toFixed(3)}${bCi} | ${verdictF1(r.fileScored, cliThresholds).toFixed(3)} | ${pct(q.caught)} (${pct(r.localized)}) | ` +
    `${pct(q.falseAlarms)} | ${auroc(rIt).toFixed(3)} | ${auprc(rIt).toFixed(3)} | ${pct(violationPrecision(rIt, cliThresholds))} | ` +
    `${r.hitRanges}/${r.totalRanges} | ${costPerThousand(r.tokens, files.length)} |`
  )
}

if (!existsSync(spentLock)) {
  await Bun.write(spentLock, `Decided ${new Date().toISOString()} (${base.name} vs ${cand.name} on ${model.name}, ${files.length} files)\n`)
  console.log(`\nMarked holdout as spent at ${spentLock}. Fold holdout.jsonl into dev before any further tuning (H25/H26).`)
}
