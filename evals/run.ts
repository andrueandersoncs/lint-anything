// The corpus eval: scores every corpus policy through its own `select` (evals/corpus/policies), as the CLI
// judges a file: a policy's score on a file is its highest item score (0 when the selector found nothing).
//   bun evals/run.ts [--split dev|test|all] [--origin all|synthetic|real|planted[,…]]
//                    [--category all|semantic|control] [--wording <set>] [--thresholds floor,threshold]
//                    [--selectors <dir>]… [--concurrency 8] [shape ...]
// Variants: each shape judges the corpus selectors' items with that request shape: `production` (what the
// CLI sends: the policy body as the state, one question per item) or `single` (the same state and
// question, one request per item). Each `--selectors <dir>` adds the corpus policies with those in <dir>
// replacing their namesakes (same rule text, other framing, criteria, or selector), judged with the
// production shape. Without shapes the shape is `production`. The first variant is the baseline for the
// paired intervals.
// --wording judges the policies of corpus/wordings/<set> (same selectors) against that set's gold, on the
// files labeled for it. --thresholds sets the item cut-offs (default: the CLI's).
import { resolve } from "node:path"
import { makeClient } from "./client.ts"
import { type Case, categoryOf, loadCorpus } from "./corpus.ts"
import {
  auroc,
  bootstrapInterval,
  brier,
  concordance,
  cliThresholds,
  type Label,
  pairedInterval,
  quality,
  reachedRanges,
  type Scored,
  type Thresholds,
  tuneThresholds,
  verdictF1
} from "../src/score.ts"
import { pairAccuracy } from "./metrics.ts"
import {
  corpusSelectorSet,
  costPerThousand,
  fileScores,
  type ItemCase,
  loadSelectorSet,
  type Plan,
  productionPlan,
  scoreItems,
  selectItems,
  type SelectorSet,
  writeScores
} from "./selected.ts"

const shapes = ["production", "single"] as const
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
const flags = (name: string) => {
  const values: Array<string> = []
  for (let value = flag(name, ""); value !== ""; value = flag(name, "")) values.push(value)
  return values
}
const split = flag("--split", "dev")
const origin = flag("--origin", "all")
const category = flag("--category", "all")
const concurrency = Number(flag("--concurrency", "8"))
const wording = flag("--wording", "")
const selectorDirectories = flags("--selectors")
const [floor, threshold] = flag("--thresholds", `${cliThresholds.floor},${cliThresholds.threshold}`)
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
const chosenShapes = (args.length > 0 ? args : ["production"]).map((shape) => {
  if (!(shapes as ReadonlyArray<string>).includes(shape)) throw new Error(`shape must be one of ${shapes.join(", ")}`)
  return shape as Shape
})
const scope = [split, origin === "all" ? undefined : origins.join("+"), category === "all" ? undefined : category,
  wording === "" ? undefined : `wording-${wording}`]
  .filter((part) => part !== undefined)
  .join(".")

const loaded = await loadCorpus({ requireSplits: split !== "all", ...(wording === "" ? {} : { wording }) })
// Ambiguous cases are scored at file level: the ideal verdict for them is `review`.
const cases = loaded.cases.filter((item) =>
  (split === "all" || item.file.split === split) && origins.includes(item.file.origin) &&
  (category === "all" || categoryOf(item.policy.name) === category)
)
if (cases.length === 0) throw new Error(`no cases in split ${split}, origin ${origin}, category ${category}`)
const corpus = { ...loaded, cases }

// --- Request shapes ---------------------------------------------------------------------------------

// The CLI's state and question, one item per request.
const single: Plan = (policy, entries) => {
  const plans = entries.map((entry) => productionPlan(policy, [entry]))
  return {
    requests: plans.flatMap((plan, index) => plan.requests.map(({ body, questions }) => ({ body, questions: questions.map(({ id }) => ({ id, index })) }))),
    oversized: plans.flatMap((plan, index) => (plan.oversized.length > 0 ? [index] : []))
  }
}

const plans: Record<Shape, Plan> = { production: productionPlan, single }

// --- Variants ---------------------------------------------------------------------------------------

const corpusSet = corpusSelectorSet(corpus)
const variants: Array<{ readonly name: string; readonly set: SelectorSet; readonly plan: Plan }> = [
  ...chosenShapes.map((shape) => ({ name: shape, set: corpusSet, plan: plans[shape] })),
  ...await Promise.all(selectorDirectories.map(async (directory) => {
    const replacing = await loadSelectorSet(corpus, resolve(directory))
    const set: SelectorSet = {
      name: replacing.name,
      policies: corpusSet.policies.map((entry) => replacing.policies.find(({ original }) => original === entry.original) ?? entry)
    }
    return { name: replacing.name, set, plan: productionPlan }
  }))
]
if (new Set(variants.map((variant) => variant.name)).size !== variants.length) throw new Error("variant names must differ")

// Variants sharing a selector set share its items.
const selections = new Map<SelectorSet, ReturnType<typeof selectItems>>()
const select = (set: SelectorSet) => {
  if (!selections.has(set)) selections.set(set, selectItems(corpus, split, set, { ambiguous: true }))
  return selections.get(set)!
}

const ask = makeClient(concurrency)
const fileCount = new Set(cases.map((item) => item.file.id)).size

interface Run {
  readonly name: string
  readonly items: ReadonlyArray<ItemCase>
  /** Item scores, items of ambiguous file cases included. */
  readonly scored: ReadonlyArray<Scored<ItemCase>>
  /** File case scores: each case's highest item score. */
  readonly files: ReadonlyArray<Scored<Case>>
  readonly requests: number
  readonly inputTokens: number
}

const runs: Array<Run> = await Promise.all(variants.map(async ({ name, set, plan }) => {
  const { fileCases, items } = await select(set)
  const run = await scoreItems(ask, items, plan)
  const files = fileScores(fileCases, run.scored)
  await writeScores(`${import.meta.dir}/results/${scope}/${name}.jsonl`, files)
  await writeScores(`${import.meta.dir}/results/${scope}/${name}.items.jsonl`, run.scored)
  const inputTokens = [...run.inputTokens.values()].reduce((sum, value) => sum + value, 0)
  return { name, items, scored: run.scored, files, requests: run.requests, inputTokens }
}))
const baseline = runs[0]!

// --- Report -----------------------------------------------------------------------------------------

const fixed = (value: number) => (Number.isNaN(value) ? "–" : value.toFixed(3))
const percent = (value: number) => (Number.isNaN(value) ? "–" : `${(value * 100).toFixed(0)}%`)
const signed = (value: number) => (Number.isNaN(value) ? "–" : `${value >= 0 ? "+" : ""}${value.toFixed(3)}`)
const delta = (base: ReadonlyArray<Scored<unknown>>, other: ReadonlyArray<Scored<unknown>>, metric: (cases: ReadonlyArray<Scored<unknown>>) => number) => {
  const [low, high] = pairedInterval(base, other, metric)
  return ` [${signed(low)}, ${signed(high)}]`
}
const clearItems = (scored: ReadonlyArray<Scored<ItemCase>>) => scored.filter((entry) => entry.label !== "ambiguous")
const caseKey = (item: Case) => `${item.file.id}\0${item.policy.name}`
const sameItems = (run: Run) =>
  run.items.length === baseline.items.length && run.items.every((item, index) => item.id === baseline.items[index]!.id)
/** Gold violation ranges of `fileCases` that some item of the same case overlaps, and all of them. */
const reached = (run: Run, fileCases: ReadonlyArray<Case>) => {
  const byCase = new Map<string, Array<ItemCase>>()
  for (const item of run.items) byCase.set(caseKey(item), [...(byCase.get(caseKey(item)) ?? []), item])
  const violating = fileCases.filter((item) => item.gold.label === "violates")
  const hit = violating.reduce((sum, item) =>
    sum + reachedRanges(item.gold.lines ?? [], (byCase.get(caseKey(item)) ?? []).map(({ entry }) => entry)), 0)
  return `${hit}/${violating.reduce((sum, item) => sum + (item.gold.lines ?? []).length, 0)}`
}
const count = (scored: ReadonlyArray<Scored<Case>>, label: Label) => scored.filter((entry) => entry.label === label).length

const baseItems = clearItems(baseline.scored)
console.log(`\n${scope}: ${cases.length} cases in ${fileCount} files: ${count(baseline.files, "violates")} violating, ` +
  `${count(baseline.files, "ambiguous")} ambiguous; ${baseline.name} judges ${baseline.items.length} items ` +
  `(${count(baseItems, "violates")} violating, ${baseline.scored.length - baseItems.length} in ambiguous cases, ` +
  `left out of item metrics). A case scores its highest item score (0 without items); verdicts at item cut-offs ` +
  `${floor} / ${threshold}; "tuned" re-picks both on these same cases (in-sample: tune on dev, then pass them to test ` +
  `with --thresholds). Intervals: 95% paired bootstrap vs ${baseline.name}, resampling files. Cost covers the ` +
  `policies in scope.\n`)
console.log("| Variant | File AUROC (clear) | Concordance | Brier | Verdict F1 | Caught | Surfaced | Ambiguous→review | " +
  "False alarms | Tuned (floor/threshold → F1) | Pairs | Item AUROC | Item Brier | Gold ranges reached | Items (oversized) | " +
  "Requests | $ / 1k files |")
console.log("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|")
for (const run of runs) {
  const q = quality(run.files, thresholds)
  const tuned = tuneThresholds(run.files)
  const files = (metric: (cases: ReadonlyArray<Scored<unknown>>) => number) => run === baseline ? "" : delta(baseline.files, run.files, metric)
  const items = (metric: (cases: ReadonlyArray<Scored<unknown>>) => number) =>
    run === baseline || !sameItems(run) ? "" : delta(baseItems, clearItems(run.scored), metric)
  console.log(`| ${run.name} | ${fixed(q.auroc)}${files(auroc)} | ${fixed(q.concordance)}${files(concordance)} | ` +
    `${fixed(q.brier)}${files(brier)} | ${fixed(q.f1)} | ${percent(q.caught)} | ${percent(q.surfaced)} | ` +
    `${percent(q.ambiguousToReview)} | ${percent(q.falseAlarms)} | ${tuned.floor}/${tuned.threshold} → ` +
    `${fixed(verdictF1(run.files, tuned))} | ${percent(pairAccuracy(run.files))} | ${fixed(auroc(clearItems(run.scored)))}${items(auroc)} | ` +
    `${fixed(brier(clearItems(run.scored)))}${items(brier)} | ${reached(run, cases)} | ${run.items.length} ` +
    `(${run.scored.filter((entry) => entry.score === null).length}) | ${run.requests} | ` +
    `$${costPerThousand(run.inputTokens, fileCount).toFixed(3)} |`)
}

// Breakdowns of the baseline, with n: per origin (synthetic and planted files run easier than real ones, so
// headline numbers should be read on real), and on real files per size bin and per policy. Other variants
// add their file AUROC with an interval vs the baseline.
const others = runs.slice(1)
const breakdown = (title: string, groups: ReadonlyArray<readonly [string, (item: Case) => boolean]>) => {
  console.log(`\n| ${title} | Clear violations | Clean | Ambiguous | File AUROC (clear) [95% bootstrap] | Caught | False alarms | ` +
    `Items (violating) | Item AUROC | Gold ranges reached |${others.map((run) => ` ${run.name} file AUROC |`).join("")}`)
  console.log(`|---|---|---|---|---|---|---|---|---|---|${others.map(() => "---|").join("")}`)
  for (const [name, member] of groups) {
    const of = <A extends Case>(scored: ReadonlyArray<Scored<A>>) => scored.filter((entry) => member(entry.subject))
    const files = of(baseline.files)
    if (files.length === 0) continue
    const items = clearItems(of(baseline.scored))
    const q = quality(files, thresholds)
    const [low, high] = bootstrapInterval(files, auroc)
    console.log(`| ${name} | ${count(files, "violates")} | ${count(files, "complies")} | ` +
      `${count(files, "ambiguous")} | ${fixed(q.auroc)} [${fixed(low)}, ${fixed(high)}] | ${percent(q.caught)} | ` +
      `${percent(q.falseAlarms)} | ${items.length} (${count(items, "violates")}) | ${fixed(auroc(items))} | ` +
      `${reached(baseline, files.map((entry) => entry.subject))} |` +
      others.map((run) => ` ${fixed(auroc(of(run.files)))}${delta(files, of(run.files), auroc)} |`).join(""))
  }
}
const sizeBin = (item: Case) => {
  const bytes = Buffer.byteLength(item.file.source)
  return bytes < 4_000 ? "< 4 KB" : bytes < 9_000 ? "4–9 KB" : "> 9 KB"
}
const real = (item: Case) => item.file.origin === "real"
console.log(`\nBreakdowns of ${baseline.name}:`)
breakdown("Origin", ["real", "planted", "synthetic"].map((value) => [value, (item: Case) => item.file.origin === value] as const))
breakdown("Size (real)", ["< 4 KB", "4–9 KB", "> 9 KB"].map((bin) => [bin, (item: Case) => real(item) && sizeBin(item) === bin] as const))
breakdown("Policy (real)", [...new Set(cases.map((item) => item.policy.name))].sort().map((name) =>
  [name, (item: Case) => real(item) && item.policy.name === name] as const))
