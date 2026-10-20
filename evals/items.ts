// Scores how selector items are sent to Clef, against item labels derived from the gold corpus.
//   bun evals/items.ts [--split dev|test|all] [--thresholds floor,threshold] [--selectors dir] [--concurrency 8] [shape ...]
// --selectors scores another set of selector policies (default evals/corpus/selectors) against the same labels.
// Shapes: `production` (what the CLI sends: the rule in the state, one question per item), `single` (one
// request per item), `list` (the rule and all items in the state, one short question per item). The
// first shape is the baseline.
import { resolve } from "node:path"
import { Effect } from "effect"
import { itemCriteria as criteria, maxRequestBytes, planItemRequests, renderItem as render } from "../src/clef.ts"
import { defaultItemThreshold, itemReviewFloor } from "../src/lint.ts"
import { matches, parsePolicy, type Policy } from "../src/policy.ts"
import { type Item, runSelector } from "../src/select.ts"
import { makeClient } from "./client.ts"
import { type Case, categoryOf, corpusDirectory, loadCorpus } from "./corpus.ts"
import { auroc, brier, pairedInterval, quality, type Scored, type Thresholds, tuneThresholds, verdictF1 } from "./metrics.ts"
import { inputTokenPrice } from "./strategy.ts"

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

// Each selector policy in corpus/selectors adds a `select` to the corpus policy of the same name; its
// globs and rule text must stay identical, so the corpus labels still apply.
const frontmatter = /^---\r?\n(.*?)\r?\n---(?:\r?\n|$)/s
const body = (source: string) => source.replace(frontmatter, "")
const globsOf = (source: string) =>
  JSON.stringify((Bun.YAML.parse(frontmatter.exec(source)?.[1] ?? "") as { readonly globs?: unknown } | null)?.globs)
const selectorDirectory = selectorFlag === "" ? `${corpusDirectory}/selectors` : resolve(selectorFlag)
// Results of a non-default selector set go to their own directory, named after it.
const resultScope = `items.${split}${selectorFlag === "" ? "" : `.${selectorDirectory.split("/").pop()}`}`
const selectorPolicies = await Promise.all(
  (await Array.fromAsync(new Bun.Glob("**/*.md").scan(selectorDirectory))).sort().map(async (file) => {
    const name = file.slice(0, -".md".length)
    const policy = Effect.runSync(parsePolicy(name, await Bun.file(`${selectorDirectory}/${file}`).text()))
    const original = corpus.policies.find((candidate) => candidate.name === name)
    if (original === undefined) throw new Error(`selector policy ${name} has no corpus policy`)
    if (body(policy.source) !== body(original.source)) throw new Error(`selector policy ${name}: rule text differs from the corpus policy`)
    if (globsOf(policy.source) !== globsOf(original.source)) throw new Error(`selector policy ${name}: globs differ from the corpus policy`)
    if (policy.select === undefined) throw new Error(`selector policy ${name} has no select`)
    return { policy: policy as Policy & { readonly select: string }, original }
  })
)

/** One scored unit: an item, labelled `violates` when its lines overlap the file's gold violation lines. */
interface ItemCase extends Case {
  readonly entry: Item
}

const fileCases = corpus.cases.filter((item) =>
  (split === "all" || item.file.split === split) && item.gold.label !== "ambiguous" &&
  selectorPolicies.some(({ original }) => original === item.policy)
)
const items: Array<ItemCase> = []
let goldRanges = 0
let coveredRanges = 0
for (const fileCase of fileCases) {
  const { policy } = selectorPolicies.find(({ original }) => original === fileCase.policy)!
  if (!matches(policy, fileCase.file.path)) continue
  const selected = await Effect.runPromise(
    runSelector(policy, [fileCase.file.path], `${corpusDirectory}/files/${fileCase.file.id}`)
  )
  const gold = fileCase.gold.label === "violates" ? fileCase.gold.lines ?? [] : []
  const overlaps = (lines: readonly [number, number], [start, end]: readonly [number, number]) =>
    lines[0] <= end && start <= lines[1]
  for (const entry of selected) {
    if (entry.lines === undefined) throw new Error(`${policy.name}: eval selectors must emit lines (${entry.id})`)
    const violates = gold.some((range) => overlaps(entry.lines!, range))
    items.push({
      id: `${fileCase.id}:${entry.id}`,
      file: fileCase.file,
      policy,
      gold: { label: violates ? "violates" : "complies", note: "" },
      entry
    })
  }
  goldRanges += gold.length
  coveredRanges += gold.filter((range) => selected.some((entry) => entry.lines !== undefined && overlaps(entry.lines, range))).length
}

// --- Request shapes -------------------------------------------------------------------------------

const calibrated = "Return a calibrated probability that the answer is yes."

interface Planned {
  readonly body: string
  /** Question id → index into the planned items. */
  readonly questions: ReadonlyArray<{ readonly id: string; readonly index: number }>
}

const limit = maxRequestBytes.clef
const maxQuestions = 64

const plan = (shape: Shape, policy: Policy, entries: ReadonlyArray<Item>) => {
  const rule = `Rule:\n${policy.source}`
  switch (shape) {
    case "production": {
      const planned = planItemRequests("clef", policy, entries)
      return {
        requests: planned.requests.map(({ body, questions }): Planned => ({
          body,
          questions: questions.map(({ id, value }) => ({ id, index: value }))
        })),
        oversized: planned.oversized.map(({ value }) => value)
      }
    }
    case "single": {
      const requests: Array<Planned> = []
      const oversized: Array<number> = []
      entries.forEach((entry, index) => {
        const state = "Decide whether `item`, read in light of its location and any context, contains at least one " +
          `violation of the rule in the question.\n${calibrated}\n\n${render(entry)}`
        const body = JSON.stringify({ model: "clef", state, questions: { q: { type: "noul", instructions: rule, criteria } } })
        if (Buffer.byteLength(body) > limit) oversized.push(index)
        else requests.push({ body, questions: [{ id: "q", index }] })
      })
      return { requests, oversized }
    }
    case "list": {
      // Items go in the state in groups that fit beside the rule; each question only names its item.
      const requests: Array<Planned> = []
      const oversized: Array<number> = []
      const intro = "Below are a rule and numbered items, each with its location and any context. Each question " +
        `names one item: decide whether that item contains at least one violation of the rule.\n${calibrated}\n\n${rule}\n\nitems:`
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
  }
}

// --- Run ------------------------------------------------------------------------------------------

const ask = makeClient(concurrency)
// Requests group the items one selector run produces: one policy on one file.
const groups = new Map<string, Array<ItemCase>>()
for (const item of items) {
  const key = `${item.file.id}\0${item.policy.name}`
  groups.set(key, [...(groups.get(key) ?? []), item])
}

interface Run {
  readonly shape: Shape
  readonly scored: ReadonlyArray<Scored>
  readonly requests: number
  readonly inputTokens: number
  readonly ms: ReadonlyArray<number>
}

const run = async (shape: Shape): Promise<Run> => {
  const scores = new Map<ItemCase, number | null>()
  let requests = 0
  let inputTokens = 0
  const ms: Array<number> = []
  await Promise.all([...groups.values()].map(async (group) => {
    const planned = plan(shape, group[0]!.policy, group.map((item) => item.entry))
    for (const index of planned.oversized) scores.set(group[index]!, null)
    await Promise.all(planned.requests.map(async (request) => {
      const reply = await ask("clef", request.body)
      requests++
      inputTokens += reply.inputTokens
      ms.push(reply.ms)
      for (const { id, index } of request.questions) {
        const noul = reply.answers[id]?.noul
        if (typeof noul !== "number") throw new Error(`no answer for ${id}`)
        scores.set(group[index]!, noul)
      }
    }))
  }))
  const scored = items.map((item) => ({ item, score: scores.get(item) ?? null }))
  await Bun.write(
    `${import.meta.dir}/results/${resultScope}/${shape}.jsonl`,
    `${scored.map(({ item, score }) => JSON.stringify({ case: item.id, label: item.gold.label, score })).join("\n")}\n`
  )
  return { shape, scored, requests, inputTokens, ms }
}

const runs = await Promise.all(chosen.map(run))
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

const count = (label: string) => items.filter((item) => item.gold.label === label).length
console.log(`\nitems.${split}: ${items.length} items (${count("violates")} violating) from ${groups.size} selector runs over ` +
  `${fileCases.length} file cases. Selectors cover ${coveredRanges}/${goldRanges} gold violation ranges. Intervals: 95% ` +
  `paired bootstrap vs ${baseline.shape}, resampling files.\n`)
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
    `${Math.round(median)} | $${((run.inputTokens * inputTokenPrice.clef * 1000) / items.length).toFixed(3)} |`)
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
for (const { policy } of selectorPolicies) {
  const own = (scored: ReadonlyArray<Scored>) => scored.filter((entry) => entry.item.policy.name === policy.name)
  const mine = items.filter((item) => item.policy.name === policy.name)
  console.log(`| ${policy.name} (${categoryOf(policy.name)}) | ${mine.length} (${mine.filter((item) => item.gold.label === "violates").length}) | ` +
    runs.map((run) => fixed(auroc(own(run.scored)))).join(" | ") + " |")
}
