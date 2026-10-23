// Selector items for the evals: selector sets, item cases labelled from the corpus, scoring planned item
// requests through the cached client, and the file-level view of item scores.
import { availableParallelism } from "node:os"
import { Effect } from "effect"
import { inputTokenPrice, planItemRequests } from "../src/clef.ts"
import type { Item } from "../src/item.ts"
import { parsePolicy, type Policy } from "../src/policy.ts"
import { runSelector } from "../src/select.ts"
import type { makeClient } from "./client.ts"
import { type Case, type Corpus, corpusDirectory, ruleText } from "./corpus.ts"
import type { Scored } from "./metrics.ts"

/** Policies whose selectors pick the items to judge, each standing in for the corpus policy `original`. */
export interface SelectorSet {
  readonly name: string
  readonly policies: ReadonlyArray<{ readonly policy: Policy; readonly original: Policy }>
}

/** The corpus policies through their own selectors. */
export const corpusSelectorSet = (corpus: Corpus): SelectorSet => ({
  name: "policies",
  policies: corpus.policies.map((policy) => ({ policy, original: policy }))
})

/**
 * Loads an alternative selector set: the policies in `directory`, each replacing the corpus policy of the
 * same name. Their rule text (after the `Rule:` line) must equal the corpus policy's, so the corpus labels
 * still apply; the framing, criteria, and selector may differ, and the selector's file filter must accept
 * the same files.
 */
export const loadSelectorSet = async (corpus: Corpus, directory: string): Promise<SelectorSet> => ({
  name: directory.split("/").filter((part) => part !== "").pop()!,
  policies: await Promise.all(
    (await Array.fromAsync(new Bun.Glob("**/*.md").scan(directory))).sort().map(async (file) => {
      const name = file.slice(0, -".md".length)
      const policy = Effect.runSync(parsePolicy(name, await Bun.file(`${directory}/${file}`).text()))
      const original = corpus.policies.find((candidate) => candidate.name === name)
      if (original === undefined) throw new Error(`selector policy ${name} has no corpus policy`)
      if (ruleText(policy) !== ruleText(original)) throw new Error(`selector policy ${name}: rule text differs from the corpus policy`)
      return { policy, original }
    })
  )
})

/**
 * One scored unit: an item, labelled `violates` when its lines overlap the file's gold violation lines,
 * `ambiguous` when the file's gold for the policy is ambiguous, and `complies` otherwise.
 */
export interface ItemCase extends Case {
  readonly entry: Item
}

const overlaps = (lines: readonly [number, number], [start, end]: readonly [number, number]) => lines[0] <= end && start <= lines[1]

/** Calls `use` on every value with at most `limit` calls in flight; results follow `values` order. */
const pooled = async <A, B>(values: ReadonlyArray<A>, limit: number, use: (value: A) => Promise<B>): Promise<Array<B>> => {
  const results: Array<B> = []
  let next = 0
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, async () => {
    while (next < values.length) {
      const index = next++
      results[index] = await use(values[index]!)
    }
  }))
  return results
}

/**
 * Runs each selector on every corpus file case of `split` its set covers (from the file's directory, which
 * holds only that file) and labels the items. Also counts how many gold violation ranges some item
 * overlaps. File cases labelled ambiguous are left out unless `options.ambiguous`; their items are labelled
 * `ambiguous`.
 */
export const selectItems = async (
  corpus: Corpus,
  split: string,
  set: SelectorSet,
  options: { readonly ambiguous?: boolean } = {}
) => {
  const fileCases = corpus.cases.filter((item) =>
    (split === "all" || item.file.split === split) && (options.ambiguous === true || item.gold.label !== "ambiguous") &&
    set.policies.some(({ original }) => original === item.policy)
  )
  const selections = await pooled(fileCases, availableParallelism(), async (fileCase) => {
    const { policy } = set.policies.find(({ original }) => original === fileCase.policy)!
    const selected = await Effect.runPromise(runSelector(policy, `${corpusDirectory}/files/${fileCase.file.id}`))
    return { fileCase, selected, policy }
  })
  const items: Array<ItemCase> = []
  let goldRanges = 0
  let coveredRanges = 0
  for (const { fileCase, selected, policy } of selections) {
    const gold = fileCase.gold.label === "violates" ? fileCase.gold.lines ?? [] : []
    for (const entry of selected) {
      if (entry.lines === undefined) throw new Error(`${policy.name}: eval selectors must emit lines (${entry.id})`)
      const label = fileCase.gold.label === "ambiguous" ? "ambiguous" : gold.some((range) => overlaps(entry.lines!, range)) ? "violates" : "complies"
      items.push({ id: `${fileCase.id}:${entry.id}`, file: fileCase.file, policy, gold: { label, note: "" }, entry })
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
 * policy's items when linting that file. Oversized items score `null`.
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

/**
 * The file-level view of item scores, as the CLI reports a file: each file case scores its highest item
 * score, 0 when the selector found nothing in the file, and `null` when every item was too large to send.
 */
export const fileScores = (fileCases: ReadonlyArray<Case>, scored: ReadonlyArray<Scored>): Array<Scored> => {
  const byCase = new Map<string, Array<number | null>>()
  for (const { item, score } of scored) {
    const key = `${item.file.id}\0${item.policy.name}`
    byCase.set(key, [...(byCase.get(key) ?? []), score])
  }
  return fileCases.map((item) => {
    const scores = byCase.get(`${item.file.id}\0${item.policy.name}`) ?? []
    const answered = scores.filter((score) => score !== null)
    return { item, score: scores.length > 0 && answered.length === 0 ? null : Math.max(0, ...answered) }
  })
}

/** USD per 1,000 units (items or files) for `tokens` input tokens spent on `count` of them. */
export const costPerThousand = (tokens: number, count: number) => (tokens * inputTokenPrice.clef * 1000) / count

export const writeScores = (path: string, scored: ReadonlyArray<Scored>) =>
  Bun.write(path, `${scored.map(({ item, score }) => JSON.stringify({ case: item.id, label: item.gold.label, score })).join("\n")}\n`)
