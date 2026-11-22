// Evaluates cross-family cascading and ensembling of Gemini Decision 1 (primary, $7.27/1k files) and
// Clef (secondary, $16.31/1k files) on stored dev real semantic item scores (0 API requests).
// Reports the full cost-vs-quality Pareto frontier with 95% paired file-level bootstrap intervals.
//   bun evals/cascade.ts [--variant production|policies-v2] [--gemini-variant production|policies-v2]
import {
  auprc,
  auroc,
  brier,
  cliThresholds,
  type Label,
  pairedInterval,
  quality,
  type Scored,
  tprAtFpr,
  violationPrecision
} from "../src/score.ts"

interface Row {
  readonly case: string
  readonly label: string
  readonly score: number | null
}

const args = Bun.argv.slice(2)
const flag = (name: string, fallback: string) => {
  const idx = args.indexOf(name)
  return idx === -1 ? fallback : (args[idx + 1] ?? fallback)
}
const scopeBase = flag("--scope", "dev.real.semantic")
const clefVariant = flag("--variant", "production")
const gemVariant = flag("--gemini-variant", clefVariant)

const load = async (path: string): Promise<Array<Row>> =>
  (await Bun.file(path).text()).trim().split("\n").map((line) => JSON.parse(line) as Row)

const dir = `${import.meta.dir}/results`
const clefFiles = await load(`${dir}/${scopeBase}/${clefVariant}.jsonl`)
const clefItems = await load(`${dir}/${scopeBase}/${clefVariant}.items.jsonl`)
const gemItems = await load(`${dir}/${scopeBase}.model-gemini-decision-1/${gemVariant}.items.jsonl`)
const gemItemMap = new Map(gemItems.map((row) => [row.case, row]))

const norm = (label: string): Label => (label === "violates" ? "violates" : label === "ambiguous" ? "ambiguous" : "complies")
const fileOf = (id: string) => id.split(":")[0]!
const filePolicyOf = (id: string) => {
  const parts = id.split(":")
  return `${parts[0]}:${parts[1]}`
}

const clip = (p: number) => Math.min(0.995, Math.max(0.005, p))
const logit = (p: number) => Math.log(clip(p) / (1 - clip(p)))
const sigmoid = (x: number) => 1 / (1 + Math.exp(-x))

// Empirical costs per 1k files from H27 (dev real semantic): Gemini $7.27, Clef $16.31.
const geminiCost = 7.27
const clefCost = 16.31

interface Strategy {
  readonly name: string
  readonly primaryCost: number
  readonly secondaryCost: number
  readonly run: (clef: number, gem: number) => { readonly score: number; readonly calledSecond: boolean }
}

const strategies: ReadonlyArray<Strategy> = [
  { name: "Clef only (baseline)", primaryCost: clefCost, secondaryCost: 0, run: (c) => ({ score: c, calledSecond: false }) },
  { name: "Gemini only", primaryCost: geminiCost, secondaryCost: 0, run: (_, g) => ({ score: g, calledSecond: false }) },
  { name: "Cascade G→C (g ≥ 0.25)", primaryCost: geminiCost, secondaryCost: clefCost, run: (c, g) => (g >= 0.25 ? { score: (c + g) / 2, calledSecond: true } : { score: g, calledSecond: false }) },
  { name: "Cascade G→C [0.20, 0.80]", primaryCost: geminiCost, secondaryCost: clefCost, run: (c, g) => (g >= 0.20 && g <= 0.80 ? { score: (c + g) / 2, calledSecond: true } : { score: g, calledSecond: false }) },
  { name: "Cascade G→C [0.15, 0.85]", primaryCost: geminiCost, secondaryCost: clefCost, run: (c, g) => (g >= 0.15 && g <= 0.85 ? { score: (c + g) / 2, calledSecond: true } : { score: g, calledSecond: false }) },
  { name: "Cascade G→C [0.10, 0.90]", primaryCost: geminiCost, secondaryCost: clefCost, run: (c, g) => (g >= 0.10 && g <= 0.90 ? { score: (c + g) / 2, calledSecond: true } : { score: g, calledSecond: false }) },
  { name: "Ensemble Mean(C, G)", primaryCost: geminiCost, secondaryCost: clefCost, run: (c, g) => ({ score: (c + g) / 2, calledSecond: true }) },
  { name: "Ensemble LogitMean(C, G)", primaryCost: geminiCost, secondaryCost: clefCost, run: (c, g) => ({ score: sigmoid((logit(c) + logit(g)) / 2), calledSecond: true }) }
]

const evaluate = (strategy: Strategy) => {
  const byFP = new Map<string, Array<{ readonly score: number; readonly label: Label }>>()
  const items: Array<Scored<Row>> = []
  let escalated = 0
  for (const row of clefItems) {
    const gem = gemItemMap.get(row.case)!
    const { score, calledSecond } = strategy.run(row.score ?? 0, gem.score ?? 0)
    if (calledSecond) escalated++
    const label = norm(row.label)
    const fp = filePolicyOf(row.case)
    const list = byFP.get(fp)
    if (list === undefined) byFP.set(fp, [{ score, label }])
    else list.push({ score, label })
    if (row.label !== "ambiguous") items.push({ subject: row, label, group: fileOf(row.case), score })
  }
  const files: Array<Scored<Row>> = clefFiles.map((row) => {
    const list = byFP.get(row.case) ?? []
    return { subject: row, label: norm(row.label), group: fileOf(row.case), score: list.length === 0 ? 0 : Math.max(...list.map((x) => x.score)) }
  })
  const applicableFiles = files.filter((entry) => entry.subject.label !== "not-applicable")
  const violatingFiles = files.filter((entry) => entry.label === "violates")
  const localized = violatingFiles.filter((entry) =>
    (byFP.get(entry.subject.case) ?? []).some((item) => item.label === "violates" && item.score >= cliThresholds.threshold)
  ).length / violatingFiles.length
  const secondFrac = escalated / clefItems.length
  const estCost = strategy.primaryCost + strategy.secondaryCost * secondFrac
  return { strategy, files, applicableFiles, items, localized, secondFrac, estCost }
}

const results = strategies.map(evaluate)
const base = results[0]!
const signed = (v: number) => `${v >= 0 ? "+" : ""}${v.toFixed(3)}`
const pct = (v: number) => `${(v * 100).toFixed(1)}%`

console.log(`\n${scopeBase} (${clefVariant} Clef + ${gemVariant} Gemini): Cross-family cascading vs. single models (95% paired bootstrap vs. Clef):\n`)
console.log("| Strategy | File AUROC [vs Clef] | Appl. AUROC | TPR@5% | Brier | Caught (Loc.) | FA | Item AUROC | Item PR-AUC [vs Clef] | Item Prec(V) | 2nd % | Est $/1k |")
console.log("|---|---|---|---|---|---|---|---|---|---|---|---|")
for (const r of results) {
  const q = quality(r.files, cliThresholds)
  const fCi = r === base ? "" : ` [${pairedInterval(base.files, r.files, auroc).map(signed).join(", ")}]`
  const prCi = r === base ? "" : ` [${pairedInterval(base.items, r.items, auprc).map(signed).join(", ")}]`
  console.log(
    `| ${r.strategy.name} | ${q.auroc.toFixed(3)}${fCi} | ${auroc(r.applicableFiles).toFixed(3)} | ` +
    `${pct(tprAtFpr(r.files, 0.05))} | ${q.brier.toFixed(3)} | ${pct(q.caught)} (${pct(r.localized)}) | ` +
    `${pct(q.falseAlarms)} | ${auroc(r.items).toFixed(3)} | ${auprc(r.items).toFixed(3)}${prCi} | ` +
    `${pct(violationPrecision(r.items, cliThresholds))} | ${pct(r.secondFrac)} | $${r.estCost.toFixed(2)} |`
  )
}
