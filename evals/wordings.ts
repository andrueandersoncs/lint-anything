// Compares Clef's quality under each rule-wording set in corpus/wordings against the polished corpus
// policies, on the same cases: the files labeled for that set, the policies it rewords. Each side is
// scored against its own gold (polished gold for polished text, the set's gold for its text).
//   bun evals/wordings.ts [--split dev|test|all] [--concurrency 8] [set ...]
import { makeClient } from "./client.ts"
import { type Case, loadCorpus, loadWordings } from "./corpus.ts"
import { auroc, pairedInterval, productionThresholds, quality, type Scored } from "./metrics.ts"
import { scoreCases } from "./scoring.ts"
import { production } from "./strategy.ts"

const args = Bun.argv.slice(2)
const flag = (name: string, fallback: string) => {
  const index = args.indexOf(name)
  if (index === -1) return fallback
  const value = args[index + 1]
  if (value === undefined) throw new Error(`${name} needs a value`)
  args.splice(index, 2)
  return value
}
const split = flag("--split", "all")
const concurrency = Number(flag("--concurrency", "8"))
if (!["dev", "test", "all"].includes(split)) throw new Error("--split must be dev, test, or all")
const wordings = await loadWordings()
const sets = args.length > 0 ? args : [...wordings.keys()]
for (const set of sets) if (!wordings.has(set)) throw new Error(`no wording set ${set}`)

const ask = makeClient(concurrency)
const polished = await loadCorpus()
const fixed = (value: number) => (Number.isNaN(value) ? "–" : value.toFixed(3))
const percent = (value: number) => (Number.isNaN(value) ? "–" : `${(value * 100).toFixed(1)}%`)
const signed = (value: number) => `${value >= 0 ? "+" : ""}${value.toFixed(3)}`
const clear = (cases: ReadonlyArray<Scored>, label: string) => cases.filter((scored) => scored.item.gold.label === label).length

const rows: Array<string> = []
const perPolicy: Array<string> = []
for (const set of sets) {
  const reworded = new Set(wordings.get(set)!.map((policy) => policy.name))
  const corpus = await loadCorpus({ wording: set })
  const keep = (item: Case) => reworded.has(item.policy.name) && (split === "all" || item.file.split === split)
  const theirs = corpus.cases.filter(keep)
  const ids = new Set(theirs.map((item) => item.id))
  const ours = polished.cases.filter((item) => ids.has(item.id))
  const [base, candidate] = await Promise.all([
    scoreCases(production, polished, ours, ask),
    scoreCases(production, corpus, theirs, ask)
  ])
  const q0 = quality(base.scored, productionThresholds)
  const q1 = quality(candidate.scored, productionThresholds)
  const [low, high] = pairedInterval(base.scored, candidate.scored, auroc)
  const files = new Set(theirs.map((item) => item.file.id)).size
  rows.push(`| ${set} | ${reworded.size} | ${files} | ${clear(base.scored, "violates")} → ${clear(candidate.scored, "violates")} | ` +
    `${clear(base.scored, "ambiguous")} → ${clear(candidate.scored, "ambiguous")} | ${fixed(q0.auroc)} → ${fixed(q1.auroc)} ` +
    `[${signed(low)}, ${signed(high)}] | ${percent(q0.falseAlarms)} → ${percent(q1.falseAlarms)} | ` +
    `${percent(q0.caught)} → ${percent(q1.caught)} | ${base.requests + candidate.requests} |`)
  for (const name of [...reworded].sort()) {
    const of = (run: ReadonlyArray<Scored>) => run.filter((scored) => scored.item.policy.name === name)
    const a = of(base.scored)
    const b = of(candidate.scored)
    perPolicy.push(`| ${set} | ${name} | ${clear(a, "violates")} → ${clear(b, "violates")} | ${fixed(auroc(a))} → ${fixed(auroc(b))} | ` +
      `${percent(quality(a, productionThresholds).falseAlarms)} → ${percent(quality(b, productionThresholds).falseAlarms)} |`)
  }
}

console.log(`\nWording sets vs polished policies, split ${split}, production. Each side is scored against gold ` +
  `labeled for its own text. Interval: 95% paired bootstrap of the AUROC difference, resampling files.\n`)
console.log("| Set | Policies | Files | Clear violations (polished → set) | Ambiguous | AUROC (clear) | False alarms | Caught | Requests |")
console.log("|---|---|---|---|---|---|---|---|---|")
console.log(rows.join("\n"))
console.log("\n| Set | Policy | Clear violations (n) | AUROC | False alarms |")
console.log("|---|---|---|---|---|")
console.log(perPolicy.join("\n"))
