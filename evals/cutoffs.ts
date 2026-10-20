// Do per-policy cut-offs, tuned on dev, beat the global ones on test? Uses the scores evals/items.ts and
// evals/run.ts stored for dev and test (run those first); sends no requests.
//   bun evals/cutoffs.ts items|files
import { defaultThreshold, defaultItemThreshold, itemReviewFloor, reviewFloor } from "../src/lint.ts"
import type { Case } from "./corpus.ts"
import { type Scored, type Thresholds, tuneThresholds, verdict } from "./metrics.ts"

const kind = Bun.argv[2] ?? "items"
if (kind !== "items" && kind !== "files") throw new Error("pass items or files")
const global: Thresholds = kind === "items"
  ? { floor: itemReviewFloor, threshold: defaultItemThreshold }
  : { floor: reviewFloor, threshold: defaultThreshold }

/** Stored scores; a case id is `<file>:<policy>` for files and `<file>:<policy>:<item>` for items. */
const load = async (scopes: ReadonlyArray<string>): Promise<Array<Scored>> =>
  (await Promise.all(scopes.map(async (scope) =>
    (await Bun.file(`${import.meta.dir}/results/${scope}/production.jsonl`).text()).trim().split("\n").map((line) => {
      const row = JSON.parse(line) as { case: string; label: Case["gold"]["label"]; score: number | null }
      const [file, ...rest] = row.case.split(":")
      const policy = kind === "items" ? rest[0]! : rest.join(":")
      return { item: { id: row.case, file: { id: file }, policy: { name: policy }, gold: { label: row.label } } as unknown as Case, score: row.score }
    })
  ))).flat()
const dev = await load(kind === "items" ? ["items.dev"] : ["dev.semantic", "dev.control"])
const test = await load(kind === "items" ? ["items.test"] : ["test.semantic", "test.control"])

// Tune each policy on its dev cases; a policy with no violating dev case keeps the global cut-offs.
const tuned = new Map<string, Thresholds>()
for (const policy of new Set(dev.map((scored) => scored.item.policy.name))) {
  const own = dev.filter((scored) => scored.item.policy.name === policy)
  tuned.set(policy, own.some((scored) => scored.item.gold.label === "violates") ? tuneThresholds(own) : global)
}

type Gold = "pass" | "review" | "violation"
const goldOf = (scored: Scored): Gold =>
  scored.item.gold.label === "violates" ? "violation" : scored.item.gold.label === "ambiguous" ? "review" : "pass"
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
  const ambiguous = of("review")
  console.log(`| ${name} | ${percent(violations.filter((entry) => entry.got === "violation").length, violations.length)} | ` +
    `${percent(violations.filter((entry) => entry.got !== "pass").length, violations.length)} | ` +
    `${percent(clean.filter((entry) => entry.got === "violation").length, clean.length)} | ` +
    `${percent(clean.filter((entry) => entry.got !== "pass").length, clean.length)} | ` +
    `${percent(ambiguous.filter((entry) => entry.got === "review").length, ambiguous.length)} | ` +
    `${(f1s.reduce((sum, value) => sum + value, 0) / f1s.length).toFixed(3)} |`)
}

console.log(`\n${kind}: ${tuned.size} policies; ${test.length} test cases`)
console.log("| Cut-offs (test) | Violations → violation | Violations surfaced | Clean → violation | Clean not passed | Ambiguous → review | Verdict F1 |")
console.log("|---|---|---|---|---|---|---|")
summarize(`global ${global.floor} / ${global.threshold}`, () => global)
summarize("per policy, tuned on dev", (policy) => tuned.get(policy) ?? global)
