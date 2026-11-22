// Audits dual-model (Clef + Gemini Decision 1) high-confidence discrepancies against gold on stored dev
// item scores, classifying them into likely gold line-range omissions, selector/call-site artifacts,
// nested-range artifacts, and genuine exemption traps. Zero API requests.
//   bun evals/audit.ts
import { loadCorpus } from "./corpus.ts"

interface Row {
  readonly case: string
  readonly label: string
  readonly score: number | null
}

const load = async (path: string): Promise<Array<Row>> =>
  (await Bun.file(path).text()).trim().split("\n").map((line) => JSON.parse(line) as Row)

const clefItems = await load(`${import.meta.dir}/results/dev.real.semantic/production.items.jsonl`)
const gemItems = await load(`${import.meta.dir}/results/dev.real.semantic.model-gemini-decision-1/production.items.jsonl`)
const gemMap = new Map(gemItems.map((row) => [row.case, row.score]))

const corpus = await loadCorpus({ requireSplits: true })
const caseMap = new Map(corpus.cases.map((item) => [item.id, item]))

const filePolicyOf = (id: string) => {
  const parts = id.split(":")
  return `${parts[0]}:${parts[1]}`
}
const policyOf = (id: string) => id.split(":")[1]!.replace("semantic/", "")

// 1. High-confidence dual-model FPs: Clef >= 0.85 AND Gemini >= 0.80 yet labeled complies.
const dualFPs = clefItems
  .filter((row) => row.label === "complies" && (row.score ?? 0) >= 0.85 && (gemMap.get(row.case) ?? 0) >= 0.80)
  .map((row) => {
    const fileCase = caseMap.get(filePolicyOf(row.case))!
    const policy = policyOf(row.case)
    const isCallSite = row.case.includes(" call of ")
    const category =
      isCallSite
        ? "selector-call-site-item"
        : fileCase.gold.label === "violates"
        ? "secondary-violation-in-violating-file"
        : "clean-file-exemption-or-miss"
    return { row, gem: gemMap.get(row.case)!, policy, fileCase, category }
  })

const countBy = <T>(items: ReadonlyArray<T>, key: (item: T) => string) => {
  const map = new Map<string, number>()
  for (const item of items) map.set(key(item), (map.get(key(item)) ?? 0) + 1)
  return [...map.entries()].sort((a, b) => b[1] - a[1])
}

console.log(`=== Dual-model high-confidence FPs (Clef >= 0.85 & Gemini >= 0.80, labeled complies): ${dualFPs.length} ===`)
console.log("\nBy failure class:")
for (const [cls, n] of countBy(dualFPs, (x) => x.category)) console.log(`  ${cls.padEnd(40)} ${n}`)
console.log("\nBy policy:")
for (const [pol, n] of countBy(dualFPs, (x) => x.policy)) console.log(`  ${pol.padEnd(40)} ${n}`)

// 2. High-confidence dual-model FNs: Clef <= 0.15 AND Gemini <= 0.15 yet labeled violates.
const dualFNs = clefItems
  .filter((row) => row.label === "violates" && (row.score ?? 1) <= 0.15 && (gemMap.get(row.case) ?? 1) <= 0.15)
  .map((row) => {
    const fileCase = caseMap.get(filePolicyOf(row.case))!
    const policy = policyOf(row.case)
    return { row, gem: gemMap.get(row.case)!, policy, fileCase }
  })

console.log(`\n=== Dual-model high-confidence FNs (Clef <= 0.15 & Gemini <= 0.15, labeled violates): ${dualFNs.length} ===`)
console.log("\nBy policy:")
for (const [pol, n] of countBy(dualFNs, (x) => x.policy)) console.log(`  ${pol.padEnd(40)} ${n}`)
console.log("\nDetails:")
for (const { row, gem, policy, fileCase } of dualFNs) {
  console.log(`  C=${row.score?.toFixed(2)} G=${gem.toFixed(2)} | ${policy.padEnd(36)} | ${row.case.split(":").slice(2).join(":")} | goldLines=${JSON.stringify(fileCase.gold.lines)}`)
}
