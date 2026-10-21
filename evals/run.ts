// Scores request strategies against the gold corpus.
//   bun evals/run.ts [--split dev|test|all] [--origin all|synthetic|real|planted[,…]]
//                    [--category all|semantic|control] [--wording <set>] [--concurrency 8] [strategy ...]
// Each strategy is `production` and/or `key=value` overrides of it (see strategy.ts). Without strategies
// it runs the one-factor sweep below. The first strategy is the baseline for the paired intervals.
// --wording scores the policies of corpus/wordings/<set> against that set's gold, on the files labeled for it.
import { makeClient } from "./client.ts"
import { type Case, categoryOf, loadCorpus } from "./corpus.ts"
import {
  auroc,
  brier,
  concordance,
  pairedInterval,
  productionThresholds,
  quality,
  type Scored,
  type Thresholds,
  tuneThresholds,
  verdictF1
} from "./metrics.ts"
import { scoreCases } from "./scoring.ts"
import {
  assertProductionParity,
  inputTokenPrice,
  parseStrategy,
  type Strategy,
  strategyName
} from "./strategy.ts"

// One factor at a time away from production.
const sweep = [
  "production",
  "model=clef-flash",
  "batch=1",
  "batch=4",
  "batch=8",
  "ids=positional",
  "guidance=question",
  "wording=reviewer",
  "wording=calibrated",
  "state=object",
  "question=noul",
  "question=choice",
  "question=verdict",
  "question=scale"
]

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
const origin = flag("--origin", "all")
const category = flag("--category", "all")
const concurrency = Number(flag("--concurrency", "8"))
const wording = flag("--wording", "")
const [floor, threshold] = flag("--thresholds", `${productionThresholds.floor},${productionThresholds.threshold}`)
  .split(",")
  .map(Number)
if (floor === undefined || threshold === undefined || !(0 <= floor && floor < threshold && threshold <= 1)) {
  throw new Error("--thresholds must be floor,threshold with 0 <= floor < threshold <= 1")
}
const thresholds: Thresholds = { floor, threshold }
if (!["dev", "test", "all"].includes(split)) throw new Error("--split must be dev, test, or all")
const origins = origin === "all" ? ["synthetic", "real", "planted"] : origin.split(",")
if (origins.some((value) => !["synthetic", "real", "planted"].includes(value))) {
  throw new Error("--origin must be all or a comma list of synthetic, real, planted")
}
if (!["all", "semantic", "control"].includes(category)) throw new Error("--category must be all, semantic, or control")
const scope = [split, origin === "all" ? undefined : origins.join("+"), category === "all" ? undefined : category,
  wording === "" ? undefined : `wording-${wording}`]
  .filter((part) => part !== undefined)
  .join(".")
const strategies = (args.length > 0 ? args : sweep).map(parseStrategy)

const corpus = await loadCorpus({ requireSplits: split !== "all", ...(wording === "" ? {} : { wording }) })
// Requests always carry every policy matching the file, as production sends them; the filters only
// decide which answers are scored. Ambiguous cases are scored: the ideal answer for them is `review`.
const cases = corpus.cases.filter((item) =>
  (split === "all" || item.file.split === split) && origins.includes(item.file.origin) &&
  (category === "all" || categoryOf(item.policy.name) === category)
)
if (cases.length === 0) throw new Error(`no cases in split ${split}, origin ${origin}, category ${category}`)
for (const file of corpus.files) {
  assertProductionParity(file, corpus.cases.filter((item) => item.file === file).map((item) => item.policy))
  assertProductionParity(file, corpus.policies)
}

const ask = makeClient(concurrency)

interface Run {
  readonly strategy: Strategy
  readonly name: string
  readonly scored: ReadonlyArray<Scored>
  readonly requests: number
  readonly inputTokens: number
  readonly requestMs: ReadonlyArray<number>
}

const run = async (strategy: Strategy): Promise<Run> => {
  const name = strategyName(strategy)
  const { scored, requests, inputTokens, requestMs } = await scoreCases(strategy, corpus, cases, ask)
  const output = scored.map(({ item, score }) =>
    JSON.stringify({ case: item.id, label: item.gold.label, score })
  ).join("\n")
  await Bun.write(`${import.meta.dir}/results/${scope}/${name}.jsonl`, `${output}\n`)
  return { strategy, name, scored, requests, inputTokens, requestMs }
}

const runs = await Promise.all(strategies.map(run))
const baseline = runs[0]!

const fixed = (value: number, digits = 3) => (Number.isNaN(value) ? "–" : value.toFixed(digits))
const percent = (value: number) => (Number.isNaN(value) ? "–" : `${(value * 100).toFixed(0)}%`)
const interval = (run: Run, metric: (cases: ReadonlyArray<Scored>) => number) => {
  if (run === baseline) return ""
  const [low, high] = pairedInterval(baseline.scored, run.scored, metric)
  return ` [${low >= 0 ? "+" : ""}${low.toFixed(3)}, ${high >= 0 ? "+" : ""}${high.toFixed(3)}]`
}
const median = (values: ReadonlyArray<number>) => {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)] ?? Number.NaN
}

const fileCount = new Set(cases.map((item) => item.file.id)).size
const count = (label: string) => cases.filter((item) => item.gold.label === label).length
console.log(`\n${scope}: ${cases.length} cases in ${fileCount} files: ${count("violates")} violating, ` +
  `${count("ambiguous")} ambiguous. Verdicts at floor ${floor}, threshold ${threshold}; "tuned" re-picks both ` +
  `on these same cases (in-sample: tune on dev, then pass them to test with --thresholds). Intervals: 95% ` +
  `paired bootstrap vs ${baseline.name}, resampling files. Cost covers every policy matching each file.\n`)
console.log("| Strategy | AUROC (clear) | Concordance | Brier | Verdict F1 | Caught | Surfaced | Ambiguous→review | False alarms | Tuned (floor/threshold → F1) | Pairs | Inconclusive | Requests | $ / 1k files |")
console.log("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|")
for (const run of runs) {
  const q = quality(run.scored, thresholds)
  const tuned = tuneThresholds(run.scored)
  const cost = (run.inputTokens * inputTokenPrice[run.strategy.model] * 1000) / fileCount
  console.log(`| ${run.name} | ${fixed(q.auroc)}${interval(run, auroc)} | ${fixed(q.concordance)}${interval(run, concordance)} | ` +
    `${fixed(q.brier)}${interval(run, brier)} | ${fixed(q.f1)} | ${percent(q.caught)} | ${percent(q.surfaced)} | ` +
    `${percent(q.ambiguousToReview)} | ${percent(q.falseAlarms)} | ` +
    `${tuned.floor}/${tuned.threshold} → ${fixed(verdictF1(run.scored, tuned))} | ${percent(q.pairs)} | ` +
    `${q.inconclusive} | ${run.requests} | $${cost.toFixed(4)} |`)
}
