// Compares two stored eval runs of the same cases: one decision model behind two engines (Clef on Workers AI
// vs. Clef served by Flide), two models, or two request shapes of one model (production vs. single, which an
// engine that forks the state exactly should answer identically). Reads only the scores run.ts wrote; sends
// nothing.
//   bun evals/engines.ts <baseline.jsonl> <candidate.jsonl>
// Each argument is a run.ts results file: evals/results/<scope>/<variant>.jsonl (file cases) or
// <variant>.items.jsonl (items). Both must hold the same cases. Reports how often answers are identical,
// how far they move, how many verdicts change at the CLI's cut-offs, and the paired difference in quality
// (95% bootstrap, resampling files).
import { auroc, brier, cliThresholds, type Label, pairedInterval, type Scored, verdict } from "../src/score.ts"

interface Row {
  readonly case: string
  readonly label: string
  readonly score: number | null
}

const [baselinePath, candidatePath] = Bun.argv.slice(2)
if (baselinePath === undefined || candidatePath === undefined) {
  throw new Error("usage: bun evals/engines.ts <baseline.jsonl> <candidate.jsonl>")
}

const read = async (path: string): Promise<Map<string, Row>> => {
  const rows = (await Bun.file(path).text()).split("\n").filter((line) => line !== "").map((line) => JSON.parse(line) as Row)
  return new Map(rows.map((row) => [row.case, row]))
}
const baseline = await read(baselinePath)
const candidate = await read(candidatePath)
const missing = [...baseline.keys()].filter((key) => !candidate.has(key))
if (missing.length > 0 || baseline.size !== candidate.size) {
  throw new Error(`the runs hold different cases (${baseline.size} vs. ${candidate.size}; first missing: ${missing[0] ?? "–"})`)
}

// A case id starts with its file id (`<file>:<policy>[:<item>]`): the resampling unit, as in run.ts.
const scoredOf = (row: Row): Scored<string> => ({
  subject: row.case,
  label: (row.label === "not-applicable" ? "complies" : row.label) as Label,
  group: row.case.slice(0, row.case.indexOf(":")),
  score: row.score
})
const keys = [...baseline.keys()].sort()
const before = keys.map((key) => scoredOf(baseline.get(key)!))
const after = keys.map((key) => scoredOf(candidate.get(key)!))

// Answer agreement, over cases both runs answered.
const answered = keys.flatMap((key, index) => {
  const [x, y] = [before[index]!.score, after[index]!.score]
  return x === null || y === null ? [] : [{ key, x, y, delta: Math.abs(x - y) }]
})
const unanswered = keys.length - answered.length
const deltas = answered.map(({ delta }) => delta).sort((a, b) => a - b)
const quantile = (q: number) => deltas[Math.min(deltas.length - 1, Math.floor(q * deltas.length))] ?? Number.NaN
const mean = (values: ReadonlyArray<number>) => values.reduce((sum, value) => sum + value, 0) / values.length
const pearson = (() => {
  const mx = mean(answered.map(({ x }) => x))
  const my = mean(answered.map(({ y }) => y))
  let sxy = 0
  let sxx = 0
  let syy = 0
  for (const { x, y } of answered) {
    sxy += (x - mx) * (y - my)
    sxx += (x - mx) ** 2
    syy += (y - my) ** 2
  }
  return sxy / Math.sqrt(sxx * syy)
})()
const changed = answered.filter(({ x, y }) => verdict(x, cliThresholds) !== verdict(y, cliThresholds))
const flips = changed.filter(({ x, y }) =>
  [verdict(x, cliThresholds), verdict(y, cliThresholds)].includes("pass") &&
  [verdict(x, cliThresholds), verdict(y, cliThresholds)].includes("violation")
).length

const fixed = (value: number, digits = 3) => (Number.isNaN(value) ? "–" : value.toFixed(digits))
const signed = (value: number) => (Number.isNaN(value) ? "–" : `${value >= 0 ? "+" : ""}${value.toFixed(3)}`)
const percent = (part: number, whole: number) => `${((100 * part) / whole).toFixed(1)}%`
const interval = (metric: (cases: ReadonlyArray<Scored<string>>) => number) => {
  const [low, high] = pairedInterval(before, after, metric)
  return `${fixed(metric(before))} → ${fixed(metric(after))} [${signed(low)}, ${signed(high)}]`
}

console.log(`\n${baselinePath}\n  vs. ${candidatePath}\n`)
console.log(`Cases: ${keys.length} in ${new Set(before.map(({ group }) => group)).size} files; ` +
  `${unanswered} unanswered by either run (left out of agreement).`)
console.log(`Identical answers: ${percent(deltas.filter((delta) => delta === 0).length, deltas.length)}; ` +
  `within 0.001: ${percent(deltas.filter((delta) => delta <= 0.001).length, deltas.length)}; ` +
  `within 0.01: ${percent(deltas.filter((delta) => delta <= 0.01).length, deltas.length)}.`)
console.log(`|Δ| mean ${fixed(mean(deltas), 4)}, median ${fixed(quantile(0.5), 4)}, p95 ${fixed(quantile(0.95), 4)}, ` +
  `max ${fixed(deltas[deltas.length - 1] ?? Number.NaN, 4)}; Pearson r ${fixed(pearson, 4)}.`)
console.log(`Verdicts at the CLI's cut-offs (${cliThresholds.floor} / ${cliThresholds.threshold}): ` +
  `${changed.length} of ${answered.length} differ (${percent(changed.length, answered.length)}), ${flips} of them pass ↔ violation.`)
console.log(`AUROC (clear): ${interval(auroc)}`)
console.log(`Brier: ${interval(brier)}`)
