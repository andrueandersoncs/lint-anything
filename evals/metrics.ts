import type { Case } from "./corpus.ts"

/** A case with the strategy's violation probability; `null` when the request was too large to send. */
export interface Scored {
  readonly item: Case
  readonly score: number | null
}

// Production verdict cut-offs (src/lint.ts and the CLI default).
export const reviewFloor = 0.55
export const violationThreshold = 0.7

const positive = (scored: Scored) => scored.item.gold.label === "violates"
// An unsent request reports nothing, so it counts as a 0 score: a miss on violations, harmless otherwise.
const probability = (scored: Scored) => scored.score ?? 0

/** Probability that a random violating case outscores a random non-violating one; ties count half. */
export const auroc = (cases: ReadonlyArray<Scored>): number => {
  const sorted = [...cases].sort((a, b) => probability(a) - probability(b))
  let rankSum = 0
  let positives = 0
  for (let start = 0; start < sorted.length;) {
    let end = start
    while (end < sorted.length && probability(sorted[end]!) === probability(sorted[start]!)) end++
    const meanRank = (start + 1 + end) / 2
    for (let index = start; index < end; index++) {
      if (positive(sorted[index]!)) {
        rankSum += meanRank
        positives++
      }
    }
    start = end
  }
  const negatives = sorted.length - positives
  return (rankSum - (positives * (positives + 1)) / 2) / (positives * negatives)
}

/** Mean squared error of the probability against the 0/1 label; lower is better. */
export const brier = (cases: ReadonlyArray<Scored>): number =>
  cases.reduce((sum, scored) => sum + ((positive(scored) ? 1 : 0) - probability(scored)) ** 2, 0) / cases.length

const share = (cases: ReadonlyArray<Scored>, include: (s: Scored) => boolean, hit: (s: Scored) => boolean) => {
  const included = cases.filter(include)
  return included.length === 0 ? Number.NaN : included.filter(hit).length / included.length
}

/**
 * Share of contrast pairs ordered correctly: for each policy whose label differs between a file and
 * its fixed twin, the violating twin must score higher. Ties count half.
 */
export const pairAccuracy = (cases: ReadonlyArray<Scored>): number => {
  const byCase = new Map(cases.map((scored) => [`${scored.item.file.id}:${scored.item.policy.name}`, scored]))
  let total = 0
  let count = 0
  for (const scored of cases) {
    const pair = scored.item.file.pair
    if (pair === undefined || !positive(scored)) continue
    const twin = byCase.get(`${pair}:${scored.item.policy.name}`)
    if (twin === undefined || positive(twin)) continue
    count++
    const difference = probability(scored) - probability(twin)
    total += difference > 0 ? 1 : difference === 0 ? 0.5 : 0
  }
  return count === 0 ? Number.NaN : total / count
}

export interface Quality {
  readonly auroc: number
  readonly brier: number
  /** Of cases scored at or above the violation threshold, the share that truly violate. */
  readonly precision: number
  /** Share of violating cases scored at or above the violation threshold. */
  readonly recall: number
  /** Share of violating cases surfaced as violation or review (above the review floor). */
  readonly surfaced: number
  /** Share of non-violating cases surfaced as violation or review. */
  readonly falseAlarms: number
  readonly pairs: number
  readonly inconclusive: number
}

export const quality = (cases: ReadonlyArray<Scored>): Quality => ({
  auroc: auroc(cases),
  brier: brier(cases),
  precision: share(cases, (s) => probability(s) >= violationThreshold, positive),
  recall: share(cases, positive, (s) => probability(s) >= violationThreshold),
  surfaced: share(cases, positive, (s) => probability(s) > reviewFloor),
  falseAlarms: share(cases, (s) => !positive(s), (s) => probability(s) > reviewFloor),
  pairs: pairAccuracy(cases),
  inconclusive: cases.filter((scored) => scored.score === null).length
})

// Deterministic PRNG so bootstrap intervals are reproducible.
const mulberry32 = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

/**
 * 95% paired-bootstrap interval of `metric(candidate) − metric(baseline)`, resampling files (cases in
 * one file share a request and are not independent). Both runs must cover the same cases.
 */
export const pairedInterval = (
  baseline: ReadonlyArray<Scored>,
  candidate: ReadonlyArray<Scored>,
  metric: (cases: ReadonlyArray<Scored>) => number,
  samples = 2000
): readonly [number, number] => {
  const group = (cases: ReadonlyArray<Scored>) => {
    const groups = new Map<string, Array<Scored>>()
    for (const scored of cases) {
      const list = groups.get(scored.item.file.id) ?? []
      list.push(scored)
      groups.set(scored.item.file.id, list)
    }
    return groups
  }
  const before = group(baseline)
  const after = group(candidate)
  const files = [...before.keys()].sort()
  const random = mulberry32(0x5eed)
  const deltas: Array<number> = []
  for (let sample = 0; sample < samples; sample++) {
    const left: Array<Scored> = []
    const right: Array<Scored> = []
    for (let draw = 0; draw < files.length; draw++) {
      const file = files[Math.floor(random() * files.length)]!
      left.push(...before.get(file)!)
      right.push(...(after.get(file) ?? []))
    }
    const delta = metric(right) - metric(left)
    if (!Number.isNaN(delta)) deltas.push(delta)
  }
  deltas.sort((a, b) => a - b)
  return [deltas[Math.floor(deltas.length * 0.025)]!, deltas[Math.floor(deltas.length * 0.975)]!]
}
