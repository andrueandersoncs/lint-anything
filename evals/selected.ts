// Shared by evals/items.ts and evals/compare.ts: selector sets, item cases labelled from the corpus, and
// scoring planned item requests through the cached client.
import { Effect } from "effect"
import { planItemRequests } from "../src/clef.ts"
import { matches, parsePolicy, type Policy } from "../src/policy.ts"
import type { Item } from "../src/item.ts"
import { runSelector, withEvidence } from "../src/select.ts"
import type { makeClient } from "./client.ts"
import { type Case, type Corpus, corpusDirectory } from "./corpus.ts"
import type { Scored } from "./metrics.ts"
import { inputTokenPrice } from "./strategy.ts"

// Eval selectors call helper steps as `bun "$EVAL_STEPS/<step>.ts"` (see evals/steps/).
process.env.EVAL_STEPS = `${import.meta.dir}/steps`

export type SelectPolicy = Policy & { readonly select: string }

/** A directory of selector policies, each adding a `select` to the corpus policy of the same name. */
export interface SelectorSet {
  readonly name: string
  readonly policies: ReadonlyArray<{ readonly policy: SelectPolicy; readonly original: Policy }>
}

const frontmatter = /^---\r?\n(.*?)\r?\n---(?:\r?\n|$)/s
const body = (source: string) => source.replace(frontmatter, "")
const globsOf = (source: string) =>
  JSON.stringify((Bun.YAML.parse(frontmatter.exec(source)?.[1] ?? "") as { readonly globs?: unknown } | null)?.globs)

/**
 * Loads the selector policies in `directory`. Their globs and rule text must equal the corpus policy's, so
 * the corpus labels still apply; everything else in the frontmatter (select, evidence) may differ.
 */
export const loadSelectorSet = async (corpus: Corpus, directory: string): Promise<SelectorSet> => ({
  name: directory.split("/").filter((part) => part !== "").pop()!,
  policies: await Promise.all(
    (await Array.fromAsync(new Bun.Glob("**/*.md").scan(directory))).sort().map(async (file) => {
      const name = file.slice(0, -".md".length)
      const policy = Effect.runSync(parsePolicy(name, await Bun.file(`${directory}/${file}`).text()))
      const original = corpus.policies.find((candidate) => candidate.name === name)
      if (original === undefined) throw new Error(`selector policy ${name} has no corpus policy`)
      if (body(policy.source) !== body(original.source)) throw new Error(`selector policy ${name}: rule text differs from the corpus policy`)
      if (globsOf(policy.source) !== globsOf(original.source)) throw new Error(`selector policy ${name}: globs differ from the corpus policy`)
      if (policy.select === undefined) throw new Error(`selector policy ${name} has no select`)
      return { policy: policy as SelectPolicy, original }
    })
  )
})

/** One scored unit: an item, labelled `violates` when its lines overlap the file's gold violation lines. */
export interface ItemCase extends Case {
  readonly entry: Item
}

/**
 * Runs each selector, after its evidence steps, on every non-ambiguous corpus file case of `split` (from
 * the file's directory, with its path as the only argument) and labels the items. Each item carries the
 * policy with its `{{name}}` references filled in for that run. Also counts how many gold violation ranges
 * some item overlaps.
 */
export const selectItems = async (corpus: Corpus, split: string, set: SelectorSet) => {
  const fileCases = corpus.cases.filter((item) =>
    (split === "all" || item.file.split === split) && item.gold.label !== "ambiguous" &&
    set.policies.some(({ original }) => original === item.policy)
  )
  const items: Array<ItemCase> = []
  let goldRanges = 0
  let coveredRanges = 0
  const overlaps = (lines: readonly [number, number], [start, end]: readonly [number, number]) =>
    lines[0] <= end && start <= lines[1]
  for (const fileCase of fileCases) {
    const { policy } = set.policies.find(({ original }) => original === fileCase.policy)!
    if (!matches(policy, fileCase.file.path)) continue
    const cwd = `${corpusDirectory}/files/${fileCase.file.id}`
    const paths = [fileCase.file.path]
    const { selected, resolved } = await Effect.runPromise(withEvidence(policy, paths, cwd, (resolved, env) =>
      runSelector({ ...resolved, select: policy.select }, paths, cwd, env).pipe(Effect.map((selected) => ({ selected, resolved })))))
    const gold = fileCase.gold.label === "violates" ? fileCase.gold.lines ?? [] : []
    for (const entry of selected) {
      if (entry.lines === undefined) throw new Error(`${policy.name}: eval selectors must emit lines (${entry.id})`)
      const violates = gold.some((range) => overlaps(entry.lines!, range))
      items.push({
        id: `${fileCase.id}:${entry.id}`,
        file: fileCase.file,
        policy: resolved,
        gold: { label: violates ? "violates" : "complies", note: "" },
        entry
      })
    }
    goldRanges += gold.length
    coveredRanges += gold.filter((range) => selected.some((entry) => entry.lines !== undefined && overlaps(entry.lines, range))).length
  }
  return { fileCases, items, goldRanges, coveredRanges }
}

/** A request to send for a group of items; questions answer items by index into the group. */
export interface Planned {
  readonly body: string
  readonly questions: ReadonlyArray<{ readonly id: string; readonly index: number }>
}

export type Plan = (policy: Policy, entries: ReadonlyArray<Item>) => {
  readonly requests: ReadonlyArray<Planned>
  readonly oversized: ReadonlyArray<number>
}

/** What the CLI sends for a selector's items. */
export const productionPlan: Plan = (policy, entries) => {
  const planned = planItemRequests("clef", policy, entries)
  return {
    requests: planned.requests.map(({ body, questions }) => ({ body, questions: questions.map(({ id, value }) => ({ id, index: value })) })),
    oversized: planned.oversized.map(({ value }) => value)
  }
}

export interface ItemRun {
  readonly scored: ReadonlyArray<Scored>
  readonly requests: number
  /** Input tokens per policy name. */
  readonly inputTokens: ReadonlyMap<string, number>
  readonly ms: ReadonlyArray<number>
}

/**
 * Judges `items` with `plan`, one group per selector run (one policy on one file), as the CLI groups a
 * policy's items. Oversized items score `null`.
 */
export const scoreItems = async (ask: ReturnType<typeof makeClient>, items: ReadonlyArray<ItemCase>, plan: Plan): Promise<ItemRun> => {
  const groups = new Map<string, Array<ItemCase>>()
  for (const item of items) {
    const key = `${item.file.id}\0${item.policy.name}`
    groups.set(key, [...(groups.get(key) ?? []), item])
  }
  const scores = new Map<ItemCase, number | null>()
  const inputTokens = new Map<string, number>()
  let requests = 0
  const ms: Array<number> = []
  await Promise.all([...groups.values()].map(async (group) => {
    const policy = group[0]!.policy
    const planned = plan(policy, group.map((item) => item.entry))
    for (const index of planned.oversized) scores.set(group[index]!, null)
    await Promise.all(planned.requests.map(async (request) => {
      const reply = await ask("clef", request.body)
      requests++
      inputTokens.set(policy.name, (inputTokens.get(policy.name) ?? 0) + reply.inputTokens)
      ms.push(reply.ms)
      for (const { id, index } of request.questions) {
        const noul = reply.answers[id]?.noul
        if (typeof noul !== "number") throw new Error(`no answer for ${id}`)
        scores.set(group[index]!, noul)
      }
    }))
  }))
  return { scored: items.map((item) => ({ item, score: scores.get(item) ?? null })), requests, inputTokens, ms }
}

/** USD per 1,000 items for `tokens` input tokens spent on `count` items. */
export const costPerThousand = (tokens: number, count: number) => (tokens * inputTokenPrice.clef * 1000) / count

export const writeScores = (path: string, scored: ReadonlyArray<Scored>) =>
  Bun.write(path, `${scored.map(({ item, score }) => JSON.stringify({ case: item.id, label: item.gold.label, score })).join("\n")}\n`)
