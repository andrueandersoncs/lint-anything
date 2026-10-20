// Scores how selector items are sent to Clef, against item labels derived from the gold corpus.
//   bun evals/items.ts [--split dev|test|all] [--thresholds floor,threshold] [--selectors dir] [--concurrency 8] [shape ...]
// --selectors scores another set of selector policies (default evals/corpus/selectors) against the same labels.
// Shapes: `production` (what the CLI sends: the rule in the state, one question per item), `single` (one
// request per item), `list` (the rule and all items in the state, one short question per item). The
// first shape is the baseline.
import { resolve } from "node:path"
import { itemCriteria as criteria, maxRequestBytes, renderItem as render } from "../src/clef.ts"
import { defaultItemThreshold, itemReviewFloor } from "../src/lint.ts"
import { makeClient } from "./client.ts"
import { categoryOf, corpusDirectory, loadCorpus } from "./corpus.ts"
import { auroc, brier, pairedInterval, quality, type Scored, type Thresholds, tuneThresholds, verdictF1 } from "./metrics.ts"
import {
  costPerThousand,
  type ItemRun,
  loadSelectorSet,
  type Plan,
  type Planned,
  productionPlan,
  scoreItems,
  selectItems,
  writeScores
} from "./selected.ts"

const shapes = ["production", "single", "list"] as const
type Shape = (typeof shapes)[number]

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
const selectorFlag = flag("--selectors", "")
if (!["dev", "test", "all"].includes(split)) throw new Error("--split must be dev, test, or all")
// Verdicts default to the CLI's item cut-offs (src/lint.ts).
const [floor, threshold] = flag("--thresholds", `${itemReviewFloor},${defaultItemThreshold}`)
  .split(",")
  .map(Number)
if (floor === undefined || threshold === undefined || !(0 <= floor && floor < threshold && threshold <= 1)) {
  throw new Error("--thresholds must be floor,threshold with 0 <= floor < threshold <= 1")
}
const thresholds: Thresholds = { floor, threshold }
const chosen = (args.length > 0 ? args : [...shapes]).map((shape) => {
  if (!(shapes as ReadonlyArray<string>).includes(shape)) throw new Error(`shape must be one of ${shapes.join(", ")}`)
  return shape as Shape
})

const corpus = await loadCorpus({ requireSplits: split !== "all" })
const set = await loadSelectorSet(corpus, selectorFlag === "" ? `${corpusDirectory}/selectors` : resolve(selectorFlag))
// Results of a non-default selector set go to their own directory, named after it.
const resultScope = `items.${split}${selectorFlag === "" ? "" : `.${set.name}`}`
const { fileCases, items, goldRanges, coveredRanges } = await selectItems(corpus, split, set)

// --- Alternative request shapes -------------------------------------------------------------------

const calibrated = "Return a calibrated probability that the answer is yes."
const limit = maxRequestBytes.clef
const maxQuestions = 64

const single: Plan = (policy, entries) => {
  const requests: Array<Planned> = []
  const oversized: Array<number> = []
  entries.forEach((entry, index) => {
    const state = "Decide whether `item`, read in light of its location and any context, contains at least one " +
      `violation of the rule in the question.\n${calibrated}\n\n${render(entry)}`
    const body = JSON.stringify({ model: "clef", state, questions: { q: { type: "noul", instructions: `Rule:\n${policy.source}`, criteria } } })
    if (Buffer.byteLength(body) > limit) oversized.push(index)
    else requests.push({ body, questions: [{ id: "q", index }] })
  })
  return { requests, oversized }
}

// Items go in the state in groups that fit beside the rule; each question only names its item.
const list: Plan = (policy, entries) => {
  const requests: Array<Planned> = []
  const oversized: Array<number> = []
  const intro = "Below are a rule and numbered items, each with its location and any context. Each question " +
    `names one item: decide whether that item contains at least one violation of the rule.\n${calibrated}\n\nRule:\n${policy.source}\n\nitems:`
  const bodyOf = (group: ReadonlyArray<number>) =>
    JSON.stringify({
      model: "clef",
      state: `${intro}\n\n${group.map((index, slot) => `[i${slot}]\n${render(entries[index]!)}`).join("\n\n")}`,
      questions: Object.fromEntries(group.map((_, slot) => [`i${slot}`, { type: "noul", instructions: `Item i${slot}`, criteria }]))
    })
  let group: Array<number> = []
  const flush = () => {
    if (group.length > 0) requests.push({ body: bodyOf(group), questions: group.map((index, slot) => ({ id: `i${slot}`, index })) })
    group = []
  }
  entries.forEach((_, index) => {
    if (Buffer.byteLength(bodyOf([index])) > limit) {
      oversized.push(index)
      return
    }
    if (group.length === maxQuestions || Buffer.byteLength(bodyOf([...group, index])) > limit) flush()
    group.push(index)
  })
  flush()
  return { requests, oversized }
}

const plans: Record<Shape, Plan> = { production: productionPlan, single, list }

// --- Run ------------------------------------------------------------------------------------------

const ask = makeClient(concurrency)
type Run = ItemRun & { readonly shape: Shape }
const runs: Array<Run> = await Promise.all(chosen.map(async (shape) => {
  const run = await scoreItems(ask, items, plans[shape])
  await writeScores(`${import.meta.dir}/results/${resultScope}/${shape}.jsonl`, run.scored)
  return { ...run, shape }
}))
const baseline = runs[0]!

// File-level view: a policy's score on a file is its highest item score (0 when the selector found
// nothing), compared with the CLI's whole-file judgment of the same cases.
const fileScored = (scored: ReadonlyArray<Scored>): Array<Scored> =>
  fileCases.map((fileCase) => {
    const own = scored.filter((entry) => entry.item.file === fileCase.file && entry.item.policy.name === fileCase.policy.name)
    return { item: fileCase, score: Math.max(0, ...own.map((entry) => entry.score ?? 0)) }
  })
const production = new Map<string, number | null>()
for (const scope of split === "all" ? [] : [`${split}.semantic`, `${split}.control`]) {
  const file = Bun.file(`${import.meta.dir}/results/${scope}/production.jsonl`)
  if (!(await file.exists())) continue
  for (const line of (await file.text()).trim().split("\n")) {
    const { case: id, score } = JSON.parse(line)
    production.set(id, score)
  }
}

const fixed = (value: number) => (Number.isNaN(value) ? "–" : value.toFixed(3))
const percent = (value: number) => (Number.isNaN(value) ? "–" : `${(value * 100).toFixed(0)}%`)
const interval = (run: Run, metric: (cases: ReadonlyArray<Scored>) => number, select = (s: ReadonlyArray<Scored>) => s) => {
  if (run === baseline) return ""
  const [low, high] = pairedInterval(select(baseline.scored), select(run.scored), metric)
  return ` [${low >= 0 ? "+" : ""}${low.toFixed(3)}, ${high >= 0 ? "+" : ""}${high.toFixed(3)}]`
}
const inViolatingFiles = (scored: ReadonlyArray<Scored>) =>
  scored.filter((entry) => fileCases.some((c) => c.file === entry.item.file && c.policy.name === entry.item.policy.name && c.gold.label === "violates"))
const totalTokens = (run: Run) => [...run.inputTokens.values()].reduce((sum, value) => sum + value, 0)

const count = (label: string) => items.filter((item) => item.gold.label === label).length
console.log(`\n${resultScope}: ${items.length} items (${count("violates")} violating) over ${fileCases.length} file cases. ` +
  `Selectors cover ${coveredRanges}/${goldRanges} gold violation ranges. Intervals: 95% paired bootstrap vs ${baseline.shape}, resampling files.\n`)
console.log(`| Shape | Item AUROC | Within violating files | Brier | Verdict F1 / caught / false alarms at ${floor}/${threshold} | Tuned (floor/threshold → F1) | Requests | Median ms | $ / 1k items |`)
console.log("|---|---|---|---|---|---|---|---|---|")
for (const run of runs) {
  const median = [...run.ms].sort((a, b) => a - b)[Math.floor(run.ms.length / 2)] ?? Number.NaN
  const q = quality(run.scored, thresholds)
  const tuned = tuneThresholds(run.scored)
  console.log(`| ${run.shape} | ${fixed(auroc(run.scored))}${interval(run, auroc)} | ` +
    `${fixed(auroc(inViolatingFiles(run.scored)))}${interval(run, auroc, inViolatingFiles)} | ` +
    `${fixed(brier(run.scored))}${interval(run, brier)} | ${fixed(q.f1)} / ${percent(q.caught)} / ${percent(q.falseAlarms)} | ` +
    `${tuned.floor}/${tuned.threshold} → ${fixed(verdictF1(run.scored, tuned))} | ${run.requests} | ` +
    `${Math.round(median)} | $${costPerThousand(totalTokens(run), items.length).toFixed(3)} |`)
}
if (production.size > 0) {
  const whole = fileCases.map((item) => ({ item, score: production.get(item.id) ?? null }))
  console.log(`\nSame ${fileCases.length} file cases judged per file, a policy's score being its highest item score; ` +
    `interval vs the CLI's whole-file judgment (AUROC ${fixed(auroc(whole))}):`)
  for (const run of runs) {
    const [low, high] = pairedInterval(whole, fileScored(run.scored), auroc)
    console.log(`- ${run.shape}: AUROC ${fixed(auroc(fileScored(run.scored)))} [${low >= 0 ? "+" : ""}${low.toFixed(3)}, ${high >= 0 ? "+" : ""}${high.toFixed(3)}]`)
  }
}
console.log("\n| Policy | Items (violating) | " + runs.map((run) => `${run.shape} item AUROC`).join(" | ") + " |")
console.log("|---|---|" + runs.map(() => "---|").join(""))
for (const { policy } of set.policies) {
  const own = (scored: ReadonlyArray<Scored>) => scored.filter((entry) => entry.item.policy.name === policy.name)
  const mine = items.filter((item) => item.policy.name === policy.name)
  console.log(`| ${policy.name} (${categoryOf(policy.name)}) | ${mine.length} (${mine.filter((item) => item.gold.label === "violates").length}) | ` +
    runs.map((run) => fixed(auroc(own(run.scored)))).join(" | ") + " |")
}
