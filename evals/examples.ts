// Measures policy `examples` as few-shot: do labeled examples in a policy make Clef judge its items better?
// Each corpus selector policy gets examples from the other split, and the split's items are scored with and
// without them.
//   bun evals/examples.ts [--concurrency 8]
import { Effect } from "effect"
import { itemReviewFloor, defaultItemThreshold } from "../src/lint.ts"
import { parsePolicy, type Policy } from "../src/policy.ts"
import { makeClient } from "./client.ts"
import { corpusDirectory, loadCorpus } from "./corpus.ts"
import { auroc, brier, pairedInterval, quality, type Scored } from "./metrics.ts"
import { costPerThousand, type ItemCase, loadSelectorSet, productionPlan, scoreItems, selectItems } from "./selected.ts"

const args = Bun.argv.slice(2)
const concurrencyIndex = args.indexOf("--concurrency")
const ask = makeClient(concurrencyIndex === -1 ? 8 : Number(args[concurrencyIndex + 1]))
const corpus = await loadCorpus({ requireSplits: true })
const set = await loadSelectorSet(corpus, `${corpusDirectory}/selectors`)
const splits = { dev: await selectItems(corpus, "dev", set), test: await selectItems(corpus, "test", set) }
const baseline = {
  dev: await scoreItems(ask, splits.dev.items, productionPlan),
  test: await scoreItems(ask, splits.test.items, productionPlan)
}

// --- Examples ---------------------------------------------------------------------------------------

/** YAML for one example: a block scalar keeps the text readable, as a policy author would write it. */
const exampleYaml = (violates: boolean, text: string) => {
  const yaml = `  - violates: ${violates}\n    text: |2-\n${text.split("\n").map((line) => `      ${line}`).join("\n")}`
  const parsed = Bun.YAML.parse(`examples:\n${yaml}`) as { examples: Array<{ text: string }> }
  if (parsed.examples[0]?.text !== text) throw new Error(`example does not round-trip through YAML: ${JSON.stringify(text)}`)
  return yaml
}

/**
 * Examples from `split`, each at most 12 lines and with distinct text. `hard` (for few-shot): two violating
 * items and the two clean items the baseline scored highest. `typical` (for check, standing in for the
 * clear examples an author writes): three violating and three clean items in a fixed pseudo-random order.
 */
const pickExamples = (policy: string, split: "dev" | "test", kind: "hard" | "typical") => {
  const own = baseline[split].scored.filter((scored) => scored.item.policy.name === policy)
  const text = (scored: Scored) => (scored.item as ItemCase).entry.text.trim()
  const distinct = (scored: ReadonlyArray<Scored>) =>
    scored.filter((entry, index) => scored.findIndex((other) => text(other) === text(entry)) === index)
  const short = (scored: Scored) => text(scored).split("\n").length <= 12
  const shuffled = (scored: ReadonlyArray<Scored>) =>
    [...scored].sort((a, b) => Bun.hash(a.item.id).toString().localeCompare(Bun.hash(b.item.id).toString()))
  const violatingItems = own.filter((scored) => scored.item.gold.label === "violates" && short(scored))
  const cleanItems = own.filter((scored) => scored.item.gold.label !== "violates" && short(scored))
  const [violating, clean] = kind === "hard"
    ? [distinct([...violatingItems].sort((a, b) => a.item.id.localeCompare(b.item.id))).slice(0, 2),
      distinct([...cleanItems].sort((a, b) => (b.score ?? 0) - (a.score ?? 0))).slice(0, 2)]
    : [distinct(shuffled(violatingItems)).slice(0, 3), distinct(shuffled(cleanItems)).slice(0, 3)]
  return [...violating.map((scored) => ({ violates: true, text: text(scored) })), ...clean.map((scored) => ({ violates: false, text: text(scored) }))]
}

/** The policy with `examples` added to its frontmatter (and, for check's corruptions, a different body). */
const withExamples = (policy: Policy, examples: ReadonlyArray<{ violates: boolean; text: string }>, body?: string) => {
  const match = /^---\r?\n(.*?)\r?\n---(?:\r?\n|$)/s.exec(policy.source)!
  const frontmatter = examples.length === 0 ? match[1] : `${match[1]}\nexamples:\n${examples.map((example) => exampleYaml(example.violates, example.text)).join("\n")}`
  return Effect.runSync(parsePolicy(policy.name, `---\n${frontmatter}\n---\n${body ?? policy.source.slice(match[0].length)}`))
}

// --- (a) Few-shot -----------------------------------------------------------------------------------

const fixed = (value: number) => (Number.isNaN(value) ? "–" : value.toFixed(3))
const percent = (value: number) => (Number.isNaN(value) ? "–" : `${(value * 100).toFixed(1)}%`)
const delta = (base: ReadonlyArray<Scored>, other: ReadonlyArray<Scored>, metric: (cases: ReadonlyArray<Scored>) => number) => {
  const [low, high] = pairedInterval(base, other, metric)
  return ` [${low >= 0 ? "+" : ""}${low.toFixed(3)}, ${high >= 0 ? "+" : ""}${high.toFixed(3)}]`
}
const thresholds = { floor: itemReviewFloor, threshold: defaultItemThreshold }

console.log("\n(a) Few-shot: 2 violating + 2 hardest clean examples from the other split, in the policy's frontmatter.")
console.log("| Split | Policy | Items (violating) | AUROC | Brier | Caught / surfaced / false alarms | $ / 1k items |")
console.log("|---|---|---|---|---|---|---|")
for (const split of ["dev", "test"] as const) {
  const other = split === "dev" ? "test" : "dev"
  const items = splits[split].items.map((item): ItemCase => {
    const original = set.policies.find(({ policy }) => policy.name === item.policy.name)!.policy
    return { ...item, policy: withExamples(original, pickExamples(item.policy.name, other, "hard")) }
  })
  const shot = await scoreItems(ask, items, productionPlan)
  for (const name of [...set.policies.map(({ policy }) => policy.name), "all"]) {
    const own = (scored: ReadonlyArray<Scored>) => (name === "all" ? scored : scored.filter((entry) => entry.item.policy.name === name))
    const base = own(baseline[split].scored)
    const withShots = own(shot.scored)
    const tokens = (run: typeof shot) => name === "all" ? [...run.inputTokens.values()].reduce((sum, value) => sum + value, 0) : run.inputTokens.get(name) ?? 0
    for (const [label, scored, run] of [["without", base, baseline[split]], ["with examples", withShots, shot]] as const) {
      const q = quality(scored, thresholds)
      const isBase = scored === base
      console.log(`| ${split} | ${name.replace(/^(semantic|control)\//, "")} ${label} | ${scored.length} (${scored.filter((s) => s.item.gold.label === "violates").length}) | ` +
        `${fixed(auroc(scored))}${isBase ? "" : delta(base, scored, auroc)} | ${fixed(brier(scored))}${isBase ? "" : delta(base, scored, brier)} | ` +
        `${percent(q.caught)} / ${percent(q.surfaced)} / ${percent(q.falseAlarms)} | $${costPerThousand(tokens(run), scored.length).toFixed(3)} |`)
    }
  }
}
