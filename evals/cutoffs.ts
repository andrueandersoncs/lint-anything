// Do per-policy item cut-offs, tuned on dev, beat the global ones on test? Uses the item scores evals/run.ts
// stored for dev and test (run `bun evals/run.ts --split dev` and `--split test` with the same filters
// first); sends no requests. Items of ambiguous file cases are left out.
//   bun evals/cutoffs.ts [scope suffix, e.g. real.semantic]
import { defaultThreshold, reviewFloor } from "../src/lint.ts"
import type { Case } from "./corpus.ts"
import { type Scored, type Thresholds, tuneThresholds, verdict } from "./metrics.ts"

const suffix = Bun.argv[2] === undefined ? "" : `.${Bun.argv[2]}`
const global: Thresholds = { floor: reviewFloor, threshold: defaultThreshold }

/** Stored item scores; an item's case id is `<file>:<policy>:<item>`. */
const load = async (split: string): Promise<Array<Scored>> =>
  (await Bun.file(`${import.meta.dir}/results/${split}${suffix}/production.items.jsonl`).text()).trim().split("\n").flatMap((line) => {
    const row = JSON.parse(line) as { case: string; label: Case["gold"]["label"]; score: number | null }
    if (row.label === "ambiguous") return []
    const [file, policy] = row.case.split(":")
    return [{ item: { id: row.case, file: { id: file }, policy: { name: policy }, gold: { label: row.label } } as unknown as Case, score: row.score }]
  })
const dev = await load("dev")
const test = await load("test")

// Tune each policy on its dev items; a policy with no violating dev item keeps the global cut-offs.
const tuned = new Map<string, Thresholds>()
for (const policy of new Set(dev.map((scored) => scored.item.policy.name))) {
  const own = dev.filter((scored) => scored.item.policy.name === policy)
  tuned.set(policy, own.some((scored) => scored.item.gold.label === "violates") ? tuneThresholds(own) : global)
}

type Gold = "pass" | "violation"
const goldOf = (scored: Scored): Gold => (scored.item.gold.label === "violates" ? "violation" : "pass")
const percent = (count: number, total: number) => (total === 0 ? "–" : `${((100 * count) / total).toFixed(1)}%`)
const summarize = (name: string, cutoffs: (policy: string) => Thresholds) => {
  const judged = test.map((scored) => ({ gold: goldOf(scored), got: verdict(scored.score ?? 0, cutoffs(scored.item.policy.name)) }))
  const of = (gold: Gold) => judged.filter((entry) => entry.gold === gold)
  // Macro F1 over the verdict classes present in gold or predictions, as metrics.verdictF1 computes it.
  const f1s = (["pass", "review", "violation"] as const).flatMap((kind) => {
    const tp = judged.filter((entry) => entry.got === kind && entry.gold === kind).length
    const fp = judged.filter((entry) => entry.got === kind && entry.gold !== kind).length
    const fn = judged.filter((entry) => entry.got !== kind && entry.gold === kind).length
    return tp + fp + fn === 0 ? [] : [tp === 0 ? 0 : (2 * tp) / (2 * tp + fp + fn)]
  })
  const violations = of("violation")
  const clean = of("pass")
  console.log(`| ${name} | ${percent(violations.filter((entry) => entry.got === "violation").length, violations.length)} | ` +
    `${percent(violations.filter((entry) => entry.got !== "pass").length, violations.length)} | ` +
    `${percent(clean.filter((entry) => entry.got === "violation").length, clean.length)} | ` +
    `${percent(clean.filter((entry) => entry.got !== "pass").length, clean.length)} | ` +
    `${(f1s.reduce((sum, value) => sum + value, 0) / f1s.length).toFixed(3)} |`)
}

console.log(`\nitems${suffix === "" ? "" : ` (${suffix.slice(1)})`}: ${tuned.size} policies; ${test.length} test items`)
console.log("| Cut-offs (test) | Violations → violation | Violations surfaced | Clean → violation | Clean not passed | Verdict F1 |")
console.log("|---|---|---|---|---|---|")
summarize(`global ${global.floor} / ${global.threshold}`, () => global)
summarize("per policy, tuned on dev", (policy) => tuned.get(policy) ?? global)
