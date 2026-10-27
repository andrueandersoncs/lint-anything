// Measures few-shot examples: does an examples section in a policy body make Clef judge its items better?
// Each corpus policy (or each whose name contains one of the given substrings) gets the code of items of
// its own selector from the other split appended to its body as examples, and the split's items are
// scored with and without them.
//   bun evals/examples.ts [--concurrency 8] [policy name substring ...]
import type { Policy } from "../src/policy.ts"
import { makeClient } from "./client.ts"
import { loadCorpus } from "./corpus.ts"
import { auroc, brier, cliThresholds, pairedInterval, quality, type Scored } from "../src/score.ts"
import { corpusSelectorSet, costPerThousand, type ItemCase, productionPlan, scoreItems, selectItems } from "./selected.ts"

const args = Bun.argv.slice(2)
const concurrencyIndex = args.indexOf("--concurrency")
const ask = makeClient(concurrencyIndex === -1 ? 8 : Number(args.splice(concurrencyIndex, 2)[1]))
const corpus = await loadCorpus({ requireSplits: true })
const all = corpusSelectorSet(corpus)
const set = { ...all, policies: all.policies.filter(({ policy }) => args.length === 0 || args.some((wanted) => policy.name.includes(wanted))) }
if (set.policies.length === 0) throw new Error("no corpus policy matches")
const splits = { dev: await selectItems(corpus, "dev", set), test: await selectItems(corpus, "test", set) }
const baseline = {
  dev: await scoreItems(ask, splits.dev.items, productionPlan),
  test: await scoreItems(ask, splits.test.items, productionPlan)
}

// --- Examples ---------------------------------------------------------------------------------------

/** An item's own code: its text after the `item:` heading present.ts writes, without location or context. */
const codeOf = (scored: Scored<ItemCase>) => {
  const text = scored.subject.entry.text
  const heading = text.lastIndexOf("\n\nitem:\n")
  return (heading === -1 ? text : text.slice(heading + "\n\nitem:\n".length)).trim()
}

/**
 * Few-shot examples from `split`, each at most 12 lines and with distinct code: two violating items and
 * the two clean items the baseline scored highest.
 */
const pickExamples = (policy: string, split: "dev" | "test") => {
  const own = baseline[split].scored.filter((scored) => scored.subject.policy.name === policy && codeOf(scored).split("\n").length <= 12)
  const distinct = (scored: ReadonlyArray<Scored<ItemCase>>) =>
    scored.filter((entry, index) => scored.findIndex((other) => codeOf(other) === codeOf(entry)) === index)
  const violating = distinct(own.filter((scored) => scored.label === "violates").sort((a, b) => a.subject.id.localeCompare(b.subject.id))).slice(0, 2)
  const clean = distinct(own.filter((scored) => scored.label !== "violates").sort((a, b) => (b.score ?? 0) - (a.score ?? 0))).slice(0, 2)
  return [...violating.map((scored) => ({ violates: true, code: codeOf(scored) })), ...clean.map((scored) => ({ violates: false, code: codeOf(scored) }))]
}

/** A fenced code block whose fence is longer than any backtick run in `code`. */
const fenced = (code: string) => {
  const fence = "`".repeat(Math.max(3, ...[...code.matchAll(/`+/g)].map((run) => run[0].length + 1)))
  return `${fence}\n${code}\n${fence}`
}

/** The policy with an examples section appended to its body, as an author would write one. */
const withExamples = (policy: Policy, examples: ReadonlyArray<{ violates: boolean; code: string }>): Policy =>
  examples.length === 0 ? policy : {
    ...policy,
    body: `${policy.body.trimEnd()}\n\n## Examples\n\n${
      examples.map((example) => `${example.violates ? "Violates the rule:" : "Follows the rule:"}\n\n${fenced(example.code)}`).join("\n\n")
    }\n`
  }

// --- (a) Few-shot -----------------------------------------------------------------------------------

const fixed = (value: number) => (Number.isNaN(value) ? "–" : value.toFixed(3))
const percent = (value: number) => (Number.isNaN(value) ? "–" : `${(value * 100).toFixed(1)}%`)
const delta = (base: ReadonlyArray<Scored<unknown>>, other: ReadonlyArray<Scored<unknown>>, metric: (cases: ReadonlyArray<Scored<unknown>>) => number) => {
  const [low, high] = pairedInterval(base, other, metric)
  return ` [${low >= 0 ? "+" : ""}${low.toFixed(3)}, ${high >= 0 ? "+" : ""}${high.toFixed(3)}]`
}
const thresholds = cliThresholds

console.log("\n(a) Few-shot: 2 violating + 2 hardest clean examples from the other split, in an examples section of the policy body.")
console.log("| Split | Policy | Items (violating) | AUROC | Brier | Caught / surfaced / false alarms | $ / 1k items |")
console.log("|---|---|---|---|---|---|---|")
for (const split of ["dev", "test"] as const) {
  const other = split === "dev" ? "test" : "dev"
  const shots = new Map(set.policies.map(({ policy }) => [policy.name, withExamples(policy, pickExamples(policy.name, other))]))
  const items = splits[split].items.map((item): ItemCase => ({ ...item, policy: shots.get(item.policy.name)! }))
  const shot = await scoreItems(ask, items, productionPlan)
  for (const name of [...set.policies.map(({ policy }) => policy.name), "all"]) {
    const own = (scored: ReadonlyArray<Scored<ItemCase>>) => (name === "all" ? scored : scored.filter((entry) => entry.subject.policy.name === name))
    const base = own(baseline[split].scored)
    const withShots = own(shot.scored)
    const tokens = (run: typeof shot) => name === "all" ? [...run.inputTokens.values()].reduce((sum, value) => sum + value, 0) : run.inputTokens.get(name) ?? 0
    for (const [label, scored, run] of [["without", base, baseline[split]], ["with examples", withShots, shot]] as const) {
      const q = quality(scored, thresholds)
      const isBase = scored === base
      console.log(`| ${split} | ${name.replace(/^(semantic|control)\//, "")} ${label} | ${scored.length} (${scored.filter((s) => s.label === "violates").length}) | ` +
        `${fixed(auroc(scored))}${isBase ? "" : delta(base, scored, auroc)} | ${fixed(brier(scored))}${isBase ? "" : delta(base, scored, brier)} | ` +
        `${percent(q.caught)} / ${percent(q.surfaced)} / ${percent(q.falseAlarms)} | $${costPerThousand(tokens(run), scored.length).toFixed(3)} |`)
    }
  }
}
