import type { Scored } from "../src/score.ts"
import type { Case } from "./corpus.ts"

const idealScore = (scored: Scored<Case>): number => ({ complies: 0, ambiguous: 0.5, violates: 1 })[scored.label]

/**
 * Share of contrast pairs ordered correctly: for each policy whose target differs between a file and
 * its twin, the twin with the higher target must score higher. Ties count half; unsent requests score 0.
 */
export const pairAccuracy = (cases: ReadonlyArray<Scored<Case>>): number => {
  const byCase = new Map(cases.map((scored) => [`${scored.subject.file.id}:${scored.subject.policy.name}`, scored]))
  let total = 0
  let count = 0
  for (const scored of cases) {
    const pair = scored.subject.file.pair
    if (pair === undefined) continue
    const twin = byCase.get(`${pair}:${scored.subject.policy.name}`)
    if (twin === undefined || idealScore(scored) <= idealScore(twin)) continue
    count++
    const difference = (scored.score ?? 0) - (twin.score ?? 0)
    total += difference > 0 ? 1 : difference === 0 ? 0.5 : 0
  }
  return count === 0 ? Number.NaN : total / count
}
