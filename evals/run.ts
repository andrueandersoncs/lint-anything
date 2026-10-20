// Scores request strategies against the gold corpus.
//   bun evals/run.ts [--split dev|test|all] [--origin all|synthetic|real|planted[,…]] [--concurrency 8] [strategy ...]
// Each strategy is `production` and/or `key=value` overrides of it (see strategy.ts). Without strategies
// it runs the one-factor sweep below. The first strategy is the baseline for the paired intervals.
import { makeClient } from "./client.ts"
import { type Case, loadCorpus } from "./corpus.ts"
import { brier, auroc, pairedInterval, quality, type Scored } from "./metrics.ts"
import {
  assertProductionParity,
  inputTokenPrice,
  parseStrategy,
  planRequests,
  type Strategy,
  strategyName
} from "./strategy.ts"

// One factor at a time away from production.
const sweep = [
  "production",
  "model=clef-flash",
  "batch=1",
  "ids=positional",
  "guidance=question",
  "state=object",
  "question=noul",
  "question=choice"
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
const concurrency = Number(flag("--concurrency", "8"))
if (!["dev", "test", "all"].includes(split)) throw new Error("--split must be dev, test, or all")
const origins = origin === "all" ? ["synthetic", "real", "planted"] : origin.split(",")
if (origins.some((value) => !["synthetic", "real", "planted"].includes(value))) {
  throw new Error("--origin must be all or a comma list of synthetic, real, planted")
}
const scope = origin === "all" ? split : `${split}.${origins.join("+")}`
const strategies = (args.length > 0 ? args : sweep).map(parseStrategy)

const corpus = await loadCorpus({ requireSplits: split !== "all" })
const cases = corpus.cases.filter((item) =>
  (split === "all" || item.file.split === split) && origins.includes(item.file.origin)
)
if (cases.length === 0) throw new Error(`no cases in split ${split} with origin ${origin}`)
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

const score = (strategy: Strategy, answer: { noul?: number; probabilities?: Record<string, number> } | undefined) => {
  const value = strategy.question === "choice" ? answer?.probabilities?.violates : answer?.noul
  if (typeof value !== "number") throw new Error(`no score in answer ${JSON.stringify(answer)}`)
  return value
}

const run = async (strategy: Strategy): Promise<Run> => {
  const name = strategyName(strategy)
  const byFile = new Map<string, Array<Case>>()
  for (const item of cases) byFile.set(item.file.id, [...(byFile.get(item.file.id) ?? []), item])
  let requests = 0
  let inputTokens = 0
  const requestMs: Array<number> = []
  let filesDone = 0
  const perFile = await Promise.all([...byFile.values()].map(async (items) => {
    const file = items[0]!.file
    const asked = strategy.pad === "all" ? corpus.policies : items.map((item) => item.policy)
    const planned = planRequests(strategy, file, asked)
    const scores = new Map<string, number | null>(planned.oversized.map((policy) => [policy.name, null]))
    await Promise.all(planned.requests.map(async (request) => {
      const reply = await ask(strategy.model, request.body)
      requests++
      inputTokens += reply.inputTokens
      requestMs.push(reply.ms)
      for (const { id, policy } of request.questions) scores.set(policy.name, score(strategy, reply.answers[id]))
    }))
    if (++filesDone % 20 === 0) console.error(`${name}: ${filesDone}/${byFile.size} files`)
    return items.map((item): Scored => ({ item, score: scores.get(item.policy.name) ?? null }))
  }))
  const scored = perFile.flat()
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

console.log(`\n${scope}: ${cases.length} cases in ${new Set(cases.map((item) => item.file.id)).size} files, ` +
  `${cases.filter((item) => item.gold.label === "violates").length} violating. ` +
  `Intervals: 95% paired bootstrap vs ${baseline.name}, resampling files.\n`)
console.log("| Strategy | AUROC | Brier | Precision@0.7 | Recall@0.7 | Surfaced >0.55 | False alarms >0.55 | Pairs | Inconclusive | Requests | Input tokens | $ / 1k cases | p50 ms |")
console.log("|---|---|---|---|---|---|---|---|---|---|---|---|---|")
for (const run of runs) {
  const q = quality(run.scored)
  const cost = (run.inputTokens * inputTokenPrice[run.strategy.model] * 1000) / run.scored.length
  console.log(`| ${run.name} | ${fixed(q.auroc)}${interval(run, auroc)} | ${fixed(q.brier)}${interval(run, brier)} | ` +
    `${percent(q.precision)} | ${percent(q.recall)} | ${percent(q.surfaced)} | ${percent(q.falseAlarms)} | ` +
    `${percent(q.pairs)} | ${q.inconclusive} | ${run.requests} | ${run.inputTokens} | $${cost.toFixed(4)} | ` +
    `${Math.round(median(run.requestMs))} |`)
}
