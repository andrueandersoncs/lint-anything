import type { Answer, makeClient } from "./client.ts"
import type { Case, Corpus } from "./corpus.ts"
import type { Scored } from "./metrics.ts"
import { contestedId, planRequests, type Strategy, strategyName, views } from "./strategy.ts"

export type Ask = ReturnType<typeof makeClient>
type Reply = Answer & { readonly score?: number }

/** The answer's violation probability; for three-way questions, P(violates) + ½·P(borderline). */
const score = (strategy: Strategy, answer: Reply | undefined) => {
  const p = answer?.probabilities
  const value = strategy.question === "choice"
    ? p?.violates
    : strategy.question === "verdict"
    ? p === undefined ? undefined : (p.violates ?? 0) + 0.5 * (p.borderline ?? 0)
    : strategy.question === "scale"
    ? answer?.score === undefined ? undefined : answer.score / 2
    : answer?.noul
  if (typeof value !== "number") throw new Error(`no score in answer ${JSON.stringify(answer)}`)
  return value
}

export interface ScoredRun {
  readonly scored: ReadonlyArray<Scored>
  readonly requests: number
  readonly inputTokens: number
  readonly requestMs: ReadonlyArray<number>
}

/**
 * Scores `cases` with `strategy`. Requests always carry every corpus policy matching each file, as
 * production sends them (or every policy, with `pad=all`); `cases` only decides which answers are kept.
 */
export const scoreCases = async (strategy: Strategy, corpus: Corpus, cases: ReadonlyArray<Case>, ask: Ask): Promise<ScoredRun> => {
  const name = strategyName(strategy)
  const byFile = new Map<string, Array<Case>>()
  for (const item of cases) byFile.set(item.file.id, [...(byFile.get(item.file.id) ?? []), item])
  let requests = 0
  let inputTokens = 0
  const requestMs: Array<number> = []
  let filesDone = 0
  const perFile = await Promise.all([...byFile.values()].map(async (items) => {
    const file = items[0]!.file
    const matching = corpus.cases.filter((item) => item.file === file).map((item) => item.policy)
    const asked = strategy.pad === "all" ? corpus.policies : matching
    // A policy's score is its highest across the strategy's views of the file; null only if no view
    // could be sent.
    const scores = new Map<string, number | null>()
    const keep = (policy: string, value: number | null) => {
      const current = scores.get(policy)
      scores.set(policy, current === undefined || current === null ? value : value === null ? current : Math.max(current, value))
    }
    await Promise.all(views(strategy, file).map(async (view) => {
      const planned = planRequests(strategy, view, asked)
      for (const policy of planned.oversized) keep(policy.name, null)
      await Promise.all(planned.requests.map(async (request) => {
        const reply = await ask(strategy.model, request.body)
        requests++
        inputTokens += reply.inputTokens
        requestMs.push(reply.ms)
        for (const { id, policy } of request.questions) {
          const violates = score(strategy, reply.answers[id])
          if (strategy.contest === "none") {
            keep(policy.name, violates)
            continue
          }
          const contested = reply.answers[contestedId(id)]?.noul
          if (typeof contested !== "number") throw new Error(`no contested answer for ${id}`)
          keep(policy.name, (1 - contested) * violates + 0.5 * contested)
        }
      }))
    }))
    if (++filesDone % 20 === 0) console.error(`${name}: ${filesDone}/${byFile.size} files`)
    return items.map((item): Scored => ({ item, score: scores.get(item.policy.name) ?? null }))
  }))
  return { scored: perFile.flat(), requests, inputTokens, requestMs }
}
