// What a routing step drops, and what it costs. Run evals/compare.ts with the routed selector sets first:
// this reads which items each set kept, labels the dropped ones, and prices the `ask` requests the routing
// step sent (re-planned here through the eval client, which caches them).
//   bun evals/routing.ts [--split dev|test]
import { planAskRequests } from "../src/clef.ts"
import { makeClient } from "./client.ts"
import { corpusDirectory, loadCorpus } from "./corpus.ts"
import { loadSelectorSet, selectItems } from "./selected.ts"
import { inputTokenPrice } from "./strategy.ts"

const splitIndex = Bun.argv.indexOf("--split")
const split = splitIndex === -1 ? "dev" : Bun.argv[splitIndex + 1]!
const policy = "semantic/readability/comments-explain-why"
const question = "Is this comment a license header, a doc comment describing a public API, or a tool directive (such as eslint-disable, noqa, or //go:)?"
const kept = async (set: string) =>
  new Set((await Bun.file(`${import.meta.dir}/results/items.${split}.${set}/production.jsonl`).text()).trim().split("\n")
    .map((line) => JSON.parse(line) as { case: string }).map((row) => row.case).filter((id) => id.includes(`:${policy}:`)))

const corpus = await loadCorpus({ requireSplits: true })
const base = await selectItems(corpus, split, await loadSelectorSet(corpus, `${corpusDirectory}/selectors`))
const items = base.items.filter((item) => item.policy.name === policy)
const ask = makeClient(8)
console.log(`\n${split}: ${items.length} comment items, ${items.filter((item) => item.gold.label === "violates").length} violating`)
console.log("| Routing model | Dropped (of which violating) | Violating items dropped | Routing $ / 1k items |\n|---|---|---|---|")
for (const [set, model] of [["selectors-routed", "clef"], ["selectors-routed-flash", "clef-flash"]] as const) {
  const keep = await kept(set)
  const dropped = items.filter((item) => !keep.has(item.id))
  const violating = dropped.filter((item) => item.gold.label === "violates")
  // The routing step asks about each file's items in selector order, as the CLI's `ask` packs them.
  const byFile = new Map<string, typeof items>()
  for (const item of items) byFile.set(item.file.id, [...(byFile.get(item.file.id) ?? []), item])
  let tokens = 0
  for (const group of byFile.values()) {
    for (const request of planAskRequests(model, question, group.map((item) => item.entry)).requests) {
      tokens += (await ask(model, request.body)).inputTokens
    }
  }
  console.log(`| ${model} | ${dropped.length} (${violating.length}) | ${violating.length} of ${items.filter((item) => item.gold.label === "violates").length} | ` +
    `$${((tokens * inputTokenPrice[model] * 1000) / items.length).toFixed(3)} |`)
}
