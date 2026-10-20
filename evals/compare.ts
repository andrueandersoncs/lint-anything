// Compares selector sets on the same item labels, policy by policy, with the CLI's request shape. The first
// set is the baseline; each policy is compared across the sets that define it.
//   bun evals/compare.ts [--split dev|test|all] [--thresholds floor,threshold] [--concurrency 8] <dir> <dir> ...
import { resolve } from "node:path"
import { defaultItemThreshold, itemReviewFloor } from "../src/lint.ts"
import { makeClient } from "./client.ts"
import { loadCorpus } from "./corpus.ts"
import { auroc, brier, pairedInterval, quality, type Scored, type Thresholds } from "./metrics.ts"
import { costPerThousand, loadSelectorSet, productionPlan, scoreItems, selectItems, writeScores } from "./selected.ts"

const args = Bun.argv.slice(2)
const flag = (name: string, fallback: string) => {
  const index = args.indexOf(name)
  if (index === -1) return fallback
  const value = args[index + 1]
  if (value === undefined) throw new Error(`${name} needs a value`)
  args.splice(index, 2)
  return value
}
const split = flag("--split", "dev")
const concurrency = Number(flag("--concurrency", "8"))
if (!["dev", "test", "all"].includes(split)) throw new Error("--split must be dev, test, or all")
const [floor, threshold] = flag("--thresholds", `${itemReviewFloor},${defaultItemThreshold}`).split(",").map(Number)
if (floor === undefined || threshold === undefined || !(0 <= floor && floor < threshold && threshold <= 1)) {
  throw new Error("--thresholds must be floor,threshold with 0 <= floor < threshold <= 1")
}
const thresholds: Thresholds = { floor, threshold }
if (args.length < 2) throw new Error("pass at least two selector directories; the first is the baseline")

const corpus = await loadCorpus({ requireSplits: split !== "all" })
const ask = makeClient(concurrency)
const runs = await Promise.all(args.map(async (directory) => {
  const set = await loadSelectorSet(corpus, resolve(directory))
  const { items } = await selectItems(corpus, split, set)
  const run = await scoreItems(ask, items, productionPlan)
  await writeScores(`${import.meta.dir}/results/items.${split}.${set.name}/production.jsonl`, run.scored)
  return { set, items, run }
}))
const [baseline, ...candidates] = runs

const fixed = (value: number) => (Number.isNaN(value) ? "–" : value.toFixed(3))
const percent = (value: number) => (Number.isNaN(value) ? "–" : `${(value * 100).toFixed(1)}%`)
const delta = (base: ReadonlyArray<Scored>, other: ReadonlyArray<Scored>, metric: (cases: ReadonlyArray<Scored>) => number) => {
  const [low, high] = pairedInterval(base, other, metric)
  return ` [${low >= 0 ? "+" : ""}${low.toFixed(3)}, ${high >= 0 ? "+" : ""}${high.toFixed(3)}]`
}

console.log(`\nitems.${split}, CLI request shape, verdicts at ${floor}/${threshold}. Intervals: 95% paired bootstrap vs ` +
  `${baseline!.set.name}, resampling files.`)
for (const { policy } of baseline!.set.policies) {
  const compared = candidates.filter(({ set }) => set.policies.some((entry) => entry.policy.name === policy.name))
  if (compared.length === 0) continue
  const own = ({ run }: (typeof runs)[number]) => run.scored.filter((entry) => entry.item.policy.name === policy.name)
  const base = own(baseline!)
  console.log(`\n${policy.name}\n| Selector set | Items (violating) | AUROC | Brier | Caught / surfaced / false alarms | $ / 1k items |`)
  console.log("|---|---|---|---|---|---|")
  for (const entry of [baseline!, ...compared]) {
    const scored = own(entry)
    const q = quality(scored, thresholds)
    const isBase = entry === baseline
    console.log(`| ${entry.set.name} | ${scored.length} (${scored.filter((s) => s.item.gold.label === "violates").length}) | ` +
      `${fixed(auroc(scored))}${isBase ? "" : delta(base, scored, auroc)} | ${fixed(brier(scored))}${isBase ? "" : delta(base, scored, brier)} | ` +
      `${percent(q.caught)} / ${percent(q.surfaced)} / ${percent(q.falseAlarms)} | ` +
      `$${costPerThousand(entry.run.inputTokens.get(policy.name) ?? 0, scored.length).toFixed(3)} |`)
  }
}
