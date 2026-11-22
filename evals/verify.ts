// H31: Selective antithetic (inverted-polarity) verification on the uncertain/flagged tail (p >= 0.35).
// Takes Pass 1 production scores (from cache — 0 requests for Pass 1!), selects ONLY items scoring >= 0.35
// (~12-15% of items across ALL 17 semantic policies), and asks the exact inverted question ("Does this item
// comply with the rule or qualify for an explicit exemption?"), combining P_viol and (1 - P_comply).
//   bun evals/verify.ts [--cutoff 0.35] [--concurrency 8]
import { planRequests, type Question } from "../src/decision-model.ts"
import {
  auprc,
  auroc,
  brier,
  cliThresholds,
  pairedInterval,
  quality,
  type Scored,
  tprAtFpr,
  violationPrecision
} from "../src/score.ts"
import { makeClient, model } from "./client.ts"
import { type Case, loadCorpus, scoreLabel } from "./corpus.ts"
import { corpusSelectorSet, costPerThousand, fileScores, type ItemCase, productionPlan, scoreItems, selectItems } from "./selected.ts"

const args = Bun.argv.slice(2)
const flag = (name: string, fallback: string) => {
  const idx = args.indexOf(name)
  return idx === -1 ? fallback : (args[idx + 1] ?? fallback)
}
const cutoff = Number(flag("--cutoff", "0.35"))
const concurrency = Number(flag("--concurrency", "8"))

const loaded = await loadCorpus({ requireSplits: true })
const cases = loaded.cases.filter((c) => c.file.split === "dev" && c.file.origin === "real" && c.policy.name.startsWith("semantic/"))
const corpus = { ...loaded, cases }
const set = corpusSelectorSet(corpus)
const { fileCases, items } = await selectItems(corpus, "dev", set, { ambiguous: true })
const fileCount = new Set(cases.map((c) => c.file.id)).size

const ask = makeClient(concurrency)

// 1. Pass 1: production (all cached for Clef and Gemini!)
const baseRun = await scoreItems(ask, items, productionPlan)
const baseFiles = fileScores(fileCases, baseRun.scored)
const baseTokens = [...baseRun.inputTokens.values()].reduce((a, b) => a + b, 0)

// 2. Select only items with Pass 1 score >= cutoff
const flagged = baseRun.scored.filter((entry) => entry.score !== null && entry.score >= cutoff)
console.log(`Pass 1 (${model.name}): ${items.length} items, ${flagged.length} (${((flagged.length / items.length) * 100).toFixed(1)}%) >= ${cutoff} sent to antithetic Pass 2.`)

const invertedState = (body: string) =>
  `Each question shows one item with its location and any context. Decide whether that item COMPLIES with the rule below (including any listed exemptions, or where the rule does not govern it).\nReturn a calibrated probability that the item complies / is acceptable.\n\n${body.slice(body.indexOf("Rule:"))}`

const invertedCriteria = {
  true: "The item complies with the rule, falls under an explicit exemption, or the rule governs nothing in it.",
  false: "The item clearly breaks the rule and does not qualify for any exemption."
}

// Group flagged items by (file, policy) to preserve per-file packing
const groups = new Map<string, Array<Scored<ItemCase>>>()
for (const entry of flagged) {
  const key = `${entry.subject.file.id}\0${entry.subject.policy.name}`
  const list = groups.get(key)
  if (list === undefined) groups.set(key, [entry])
  else list.push(entry)
}

const complyScores = new Map<ItemCase, number>()
let p2Requests = 0
let p2Tokens = 0

await Promise.all([...groups.values()].map(async (group) => {
  const policy = group[0]!.subject.policy
  const state = invertedState(policy.body)
  const questions: Array<Question> = group.map((entry) => ({
    instructions: entry.subject.entry.text,
    criteria: invertedCriteria
  }))
  const planned = planRequests(state, questions, model)
  await Promise.all(planned.requests.map(async (req) => {
    const reply = await ask(req.body)
    p2Requests++
    p2Tokens += reply.inputTokens
    for (const { id, value } of req.questions) {
      const ans = reply.answers.get(id)
      if (ans === undefined) throw new Error(`missing answer ${id}`)
      if (ans !== "declined") complyScores.set(group[value]!.subject, ans)
    }
  }))
}))

const clip = (p: number) => Math.min(0.995, Math.max(0.005, p))
const logit = (p: number) => Math.log(clip(p) / (1 - clip(p)))
const sigmoid = (x: number) => 1 / (1 + Math.exp(-x))

const combine = (fn: (pViol: number, pComply: number) => number): Array<Scored<ItemCase>> =>
  baseRun.scored.map((entry) => {
    const pC = complyScores.get(entry.subject)
    if (entry.score === null || pC === undefined) return entry
    return { ...entry, score: fn(entry.score, pC) }
  })

const meanItems = combine((v, c) => (v + (1 - c)) / 2)
const logitItems = combine((v, c) => sigmoid((logit(v) + logit(1 - c)) / 2))
const minItems = combine((v, c) => Math.min(v, 1 - c))
const weightedItems = combine((v, c) => 0.65 * v + 0.35 * (1 - c))

const clear = <A>(arr: ReadonlyArray<Scored<A>>) => arr.filter((x) => x.label !== "ambiguous")
const signed = (v: number) => `${v >= 0 ? "+" : ""}${v.toFixed(3)}`
const pct = (v: number) => `${(v * 100).toFixed(1)}%`

const report = (name: string, scoredItems: ReadonlyArray<Scored<ItemCase>>, reqs: number, tokens: number, isBase: boolean) => {
  const files = fileScores(fileCases, scoredItems)
  const q = quality(files, cliThresholds)
  const ci = clear(scoredItems)
  const bci = clear(baseRun.scored)
  const fCi = isBase ? "" : ` [${pairedInterval(baseFiles, files, auroc).map(signed).join(", ")}]`
  const prCi = isBase ? "" : ` [${pairedInterval(bci, ci, auprc).map(signed).join(", ")}]`
  console.log(
    `| ${name} | ${q.auroc.toFixed(3)}${fCi} | ${pct(tprAtFpr(files, 0.05))} | ${q.brier.toFixed(3)} | ` +
    `${pct(q.caught)} | ${pct(q.falseAlarms)} | ${auroc(ci).toFixed(3)} | ${auprc(ci).toFixed(3)}${prCi} | ` +
    `${pct(violationPrecision(ci, cliThresholds))} | ${reqs} | ${costPerThousand(tokens, fileCount)} |`
  )
}

console.log(`\nH31 Selective antithetic verification (all 17 semantic policies, dev real, cutoff=${cutoff}, ${model.name}):\n`)
console.log("| Variant | File AUROC | TPR@5% | Brier | Caught | FA | Item AUROC | Item PR-AUC | Item Prec(V) | Reqs | $/1k files |")
console.log("|---|---|---|---|---|---|---|---|---|---|---|")
report("Pass 1 only (baseline)", baseRun.scored, baseRun.requests, baseTokens, true)
report("Mean(v, 1-c)", meanItems, baseRun.requests + p2Requests, baseTokens + p2Tokens, false)
report("LogitMean(v, 1-c)", logitItems, baseRun.requests + p2Requests, baseTokens + p2Tokens, false)
report("Weighted 0.65v+0.35(1-c)", weightedItems, baseRun.requests + p2Requests, baseTokens + p2Tokens, false)
report("Min(v, 1-c)", minItems, baseRun.requests + p2Requests, baseTokens + p2Tokens, false)
