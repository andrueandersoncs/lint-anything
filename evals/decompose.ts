// H29: Decomposed multi-predicate questions ("externalized CoT for decision models").
// Instead of one monolithic yes/no question per item, splits a policy into atomic orthogonal predicates
// (trigger condition vs. explicit exemption) asked as noul questions over the same policy body, and
// combines them probabilistically: P(violates) = P(trigger) * (1 - P(exempt)).
// Compares directly against the baseline production scores on dev real semantic.
//   bun evals/decompose.ts [--concurrency 8]
import { planRequests, type Question } from "../src/decision-model.ts"
import {
  auprc,
  auroc,
  brier,
  cliThresholds,
  pairedInterval,
  quality,
  type Scored,
  targetScore,
  tprAtFpr,
  violationPrecision
} from "../src/score.ts"
import { makeClient, model } from "./client.ts"
import { type Case, loadCorpus, scoreLabel } from "./corpus.ts"
import { corpusSelectorSet, costPerThousand, fileScores, type ItemCase, productionPlan, scoreItems, selectItems } from "./selected.ts"

const args = Bun.argv.slice(2)
const concurrency = Number(args.includes("--concurrency") ? args[args.indexOf("--concurrency") + 1] : "8")

interface PredicateSpec {
  readonly key: string
  readonly criteria: { readonly true: string; readonly false: string }
  readonly promptPrefix: string
}

interface DecomposedPolicy {
  readonly name: string
  readonly predicates: ReadonlyArray<PredicateSpec>
  readonly combine: (scores: Readonly<Record<string, number>>) => number
}

const specs: ReadonlyArray<DecomposedPolicy> = [
  {
    name: "semantic/design/no-flag-parameters",
    predicates: [
      {
        key: "switch",
        promptPrefix: "[Check 1 — mode-switching boolean]\n",
        criteria: {
          true: "The function takes a positional boolean parameter and branches on it inside its body to perform two different jobs or execution modes.",
          false: "The function does not branch on a positional boolean parameter to switch between different modes."
        }
      },
      {
        key: "exempt",
        promptPrefix: "[Check 2 — exemption: data or named option]\n",
        criteria: {
          true: "The boolean parameter is simply data being stored, forwarded, or set (like setEnabled), or lives inside an options object or keyword-only argument.",
          false: "The boolean parameter is a positional mode-switching flag, not plain data or a named option."
        }
      }
    ],
    combine: ({ switch: s = 0, exempt: e = 0 }) => s * (1 - e)
  },
  {
    name: "semantic/readability/comments-explain-why",
    predicates: [
      {
        key: "narrate",
        promptPrefix: "[Check 1 — narration or contradiction]\n",
        criteria: {
          true: "The comment only restates what the immediately following code obviously does, or directly contradicts what the following code actually does.",
          false: "The comment explains intent, constraints, or why — or adds non-obvious information consistent with the code."
        }
      },
      {
        key: "exempt",
        promptPrefix: "[Check 2 — exemption: doc/license/directive]\n",
        criteria: {
          true: "The comment is a public API doc comment, license/copyright header, or linter/compiler/tool directive.",
          false: "The comment is an ordinary inline implementation comment, not a doc comment, license header, or tool directive."
        }
      }
    ],
    combine: ({ narrate: n = 0, exempt: e = 0 }) => n * (1 - e)
  },
  {
    name: "semantic/encapsulation/minimal-public-surface",
    predicates: [
      {
        key: "internal",
        promptPrefix: "[Check 1 — internal implementation step]\n",
        criteria: {
          true: "This exported/public symbol is evidently an internal helper or intermediate step used only by other members of this file.",
          false: "This exported/public symbol appears to be a genuine public API meant for outside callers."
        }
      },
      {
        key: "exempt",
        promptPrefix: "[Check 2 — exemption: toolbox or interface/framework]\n",
        criteria: {
          true: "This file is a utility toolbox of independent helpers, OR this member is required by an interface, protocol, or framework.",
          false: "This file is not a utility toolbox and this member is not required by an interface or framework."
        }
      }
    ],
    combine: ({ internal: i = 0, exempt: e = 0 }) => i * (1 - e)
  },
  {
    name: "semantic/design/single-responsibility",
    predicates: [
      {
        key: "multi",
        promptPrefix: "[Check 1 — unrelated jobs in one unit]\n",
        criteria: {
          true: "This function or class combines multiple distinct responsibilities that would change for different reasons (e.g. parsing, domain rules, persistence, formatting).",
          false: "This unit performs a single coherent job."
        }
      },
      {
        key: "exempt",
        promptPrefix: "[Check 2 — exemption: thin coordinator]\n",
        criteria: {
          true: "This unit is primarily a coordinating function that delegates well-named helper steps in sequence.",
          false: "This unit implements the distinct responsibilities inline rather than coordinating well-named steps."
        }
      }
    ],
    combine: ({ multi: m = 0, exempt: e = 0 }) => m * (1 - e)
  },
  {
    name: "semantic/testing/test-behavior-not-implementation",
    predicates: [
      {
        key: "internals",
        promptPrefix: "[Check 1 — coupled to implementation internals]\n",
        criteria: {
          true: "The test asserts on private/internal fields, exact internal helper call order/counts, or mocks parts of the unit under test itself.",
          false: "The test only checks observable behavior through the public interface."
        }
      },
      {
        key: "exempt",
        promptPrefix: "[Check 2 — exemption: external boundary mock]\n",
        criteria: {
          true: "Any mocking or call assertion in this test targets only true external boundaries (network, database, clock, filesystem), not internal helpers.",
          false: "The test mocks or asserts on internal non-boundary helpers or private state."
        }
      }
    ],
    combine: ({ internals: i = 0, exempt: e = 0 }) => i * (1 - e)
  }
]

const targetNames = new Set(specs.map((s) => s.name))
const loaded = await loadCorpus({ requireSplits: true })
const cases = loaded.cases.filter((c) => c.file.split === "dev" && c.file.origin === "real" && targetNames.has(c.policy.name))
const corpus = { ...loaded, cases }
const set = corpusSelectorSet(corpus)
const { fileCases, items } = await selectItems(corpus, "dev", set, { ambiguous: true })
const fileCount = new Set(cases.map((c) => c.file.id)).size

const ask = makeClient(concurrency)

// 1. Baseline (cached)
const baseRun = await scoreItems(ask, items, productionPlan)
const baseFiles = fileScores(fileCases, baseRun.scored)
const baseTokens = [...baseRun.inputTokens.values()].reduce((a, b) => a + b, 0)

// 2. Decomposed multi-predicate run: per (file, policy, predicate) packed requests
const groups = new Map<string, Array<ItemCase>>()
for (const item of items) {
  const key = `${item.file.id}\0${item.policy.name}`
  const list = groups.get(key)
  if (list === undefined) groups.set(key, [item])
  else list.push(item)
}

const predScores = new Map<ItemCase, Record<string, number>>()
let decRequests = 0
let decTokens = 0

await Promise.all([...groups.values()].map(async (group) => {
  const policy = group[0]!.policy
  const spec = specs.find((s) => s.name === policy.name)!
  await Promise.all(spec.predicates.map(async (pred) => {
    const questions: Array<Question> = group.map((item) => ({
      instructions: `${pred.promptPrefix}${item.entry.text}`,
      criteria: pred.criteria
    }))
    const planned = planRequests(policy.body, questions, model)
    await Promise.all(planned.requests.map(async (req) => {
      const reply = await ask(req.body)
      decRequests++
      decTokens += reply.inputTokens
      for (const { id, value } of req.questions) {
        const ans = reply.answers.get(id)
        if (ans === undefined) throw new Error(`missing answer ${id}`)
        const item = group[value]!
        const rec = predScores.get(item) ?? {}
        rec[pred.key] = ans === "declined" ? 0 : ans
        predScores.set(item, rec)
      }
    }))
  }))
}))

const decScoredItems: Array<Scored<ItemCase>> = items.map((item) => {
  const spec = specs.find((s) => s.name === item.policy.name)!
  const rec = predScores.get(item)
  const score = rec === undefined ? null : spec.combine(rec)
  return { subject: item, label: scoreLabel(item.gold.label), group: item.file.id, score }
})
const decFiles = fileScores(fileCases, decScoredItems)

// Also test Trigger-only (without exemption multiplication) and Soft-combination (p_trigger * (1 - 0.5*p_exempt))
const softScoredItems: Array<Scored<ItemCase>> = items.map((item) => {
  const rec = predScores.get(item)
  if (rec === undefined) return { subject: item, label: scoreLabel(item.gold.label), group: item.file.id, score: null }
  const triggerKey = Object.keys(rec).find((k) => k !== "exempt")!
  const score = (rec[triggerKey] ?? 0) * (1 - 0.5 * (rec.exempt ?? 0))
  return { subject: item, label: scoreLabel(item.gold.label), group: item.file.id, score }
})
const softFiles = fileScores(fileCases, softScoredItems)

// Also test gated Check-2 on the 4 item-observable policies (skip Check 2 when Check 1 < 0.35, and keep
// minimal-public-surface on baseline since its exemption requires file-level context).
const gatedItems: Array<Scored<ItemCase>> = items.map((item, idx) => {
  if (item.policy.name === "semantic/encapsulation/minimal-public-surface") return baseRun.scored[idx]!
  const rec = predScores.get(item)
  if (rec === undefined) return { subject: item, label: scoreLabel(item.gold.label), group: item.file.id, score: null }
  const triggerKey = Object.keys(rec).find((k) => k !== "exempt")!
  const p = rec[triggerKey] ?? 0
  const score = p >= 0.35 ? p * (1 - (rec.exempt ?? 0)) : p
  return { subject: item, label: scoreLabel(item.gold.label), group: item.file.id, score }
})
const gatedFiles = fileScores(fileCases, gatedItems)
const gatedCheck2Share = items.filter((item) => {
  if (item.policy.name === "semantic/encapsulation/minimal-public-surface") return false
  const rec = predScores.get(item)
  if (rec === undefined) return false
  const triggerKey = Object.keys(rec).find((k) => k !== "exempt")!
  return (rec[triggerKey] ?? 0) >= 0.35
}).length / items.length
const estGatedTokens = Math.round(baseTokens + (decTokens - baseTokens) * gatedCheck2Share)

const clear = <A>(arr: ReadonlyArray<Scored<A>>) => arr.filter((x) => x.label !== "ambiguous")
const signed = (v: number) => `${v >= 0 ? "+" : ""}${v.toFixed(3)}`
const pct = (v: number) => `${(v * 100).toFixed(1)}%`

const row = (
  name: string,
  files: ReadonlyArray<Scored<Case>>,
  scoredItems: ReadonlyArray<Scored<ItemCase>>,
  reqs: number,
  tokens: number,
  isBase: boolean
) => {
  const q = quality(files, cliThresholds)
  const ci = clear(scoredItems)
  const bci = clear(baseRun.scored)
  const fCi = isBase ? "" : ` [${pairedInterval(baseFiles, files, auroc).map(signed).join(", ")}]`
  const iCi = isBase ? "" : ` [${pairedInterval(bci, ci, auroc).map(signed).join(", ")}]`
  const prCi = isBase ? "" : ` [${pairedInterval(bci, ci, auprc).map(signed).join(", ")}]`
  console.log(
    `| ${name} | ${q.auroc.toFixed(3)}${fCi} | ${pct(tprAtFpr(files, 0.05))} | ${q.brier.toFixed(3)} | ` +
    `${pct(q.caught)} | ${pct(q.falseAlarms)} | ${auroc(ci).toFixed(3)}${iCi} | ${auprc(ci).toFixed(3)}${prCi} | ` +
    `${pct(violationPrecision(ci, cliThresholds))} | ${reqs} | ${costPerThousand(tokens, fileCount)} |`
  )
}

console.log(`\nH29 Decomposed multi-predicate questions (5 policies, ${fileCases.length} dev real cases, ${items.length} items, ${model.name}):\n`)
console.log("| Variant | File AUROC | TPR@5% | Brier | Caught | FA | Item AUROC | Item PR-AUC | Item Prec(V) | Reqs | $/1k files |")
console.log("|---|---|---|---|---|---|---|---|---|---|---|")
row("Baseline (monolithic)", baseFiles, baseRun.scored, baseRun.requests, baseTokens, true)
row("Decomposed p*(1-e)", decFiles, decScoredItems, decRequests, decTokens, false)
row("Decomposed p*(1-0.5e)", softFiles, softScoredItems, decRequests, decTokens, false)
row(`Gated 4-pol (Check2 ${(gatedCheck2Share * 100).toFixed(0)}%)`, gatedFiles, gatedItems, Math.round(baseRun.requests * (1 + gatedCheck2Share)), estGatedTokens, false)

console.log("\nPer-policy breakdown (Baseline → Decomposed p*(1-e)):")
console.log("| Policy | File AUROC | FA | Caught | Item AUROC | Item PR-AUC | Item Prec(V) |")
console.log("|---|---|---|---|---|---|---|")
for (const spec of specs) {
  const bf = baseFiles.filter((x) => x.subject.policy.name === spec.name)
  const df = decFiles.filter((x) => x.subject.policy.name === spec.name)
  const bi = clear(baseRun.scored.filter((x) => x.subject.policy.name === spec.name))
  const di = clear(decScoredItems.filter((x) => x.subject.policy.name === spec.name))
  const bq = quality(bf, cliThresholds)
  const dq = quality(df, cliThresholds)
  console.log(
    `| ${spec.name.replace("semantic/", "")} | ${bq.auroc.toFixed(3)} → ${dq.auroc.toFixed(3)} | ` +
    `${pct(bq.falseAlarms)} → ${pct(dq.falseAlarms)} | ${pct(bq.caught)} → ${pct(dq.caught)} | ` +
    `${auroc(bi).toFixed(3)} → ${auroc(di).toFixed(3)} | ${auprc(bi).toFixed(3)} → ${auprc(di).toFixed(3)} | ` +
    `${pct(violationPrecision(bi, cliThresholds))} → ${pct(violationPrecision(di, cliThresholds))} |`
  )
}
