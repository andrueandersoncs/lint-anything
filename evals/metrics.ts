import { defaultThreshold, reviewFloor } from "../src/lint.ts"
import type { Case } from "./corpus.ts"

/** A case with the strategy's violation probability; `null` when the request was too large to send. */
export interface Scored {
  readonly item: Case
  readonly score: number | null
}

/** Verdict cut-offs: `pass` at or below `floor`, `violation` at or above `threshold`, `review` between. */
export interface Thresholds {
  readonly floor: number
  readonly threshold: number
}

// Production verdict cut-offs (src/lint.ts and the CLI default).
export const productionThresholds: Thresholds = { floor: reviewFloor, threshold: defaultThreshold }

export type Verdict = "pass" | "review" | "violation"
type GoldClass = "clean" | "ambiguous" | "violates"

const goldClass = (scored: Scored): GoldClass =>
  scored.item.gold.label === "violates" ? "violates" : scored.item.gold.label === "ambiguous" ? "ambiguous" : "clean"

/** The ideal probability for a case: 1 for a clear violation, 0.5 when reviewers split, 0 otherwise. */
export const target = (scored: Scored): number => ({ clean: 0, ambiguous: 0.5, violates: 1 })[goldClass(scored)]

// An unsent request reports nothing, so it counts as a 0 score: a miss on violations, harmless otherwise.
const probability = (scored: Scored) => scored.score ?? 0

export const verdict = (score: number, { floor, threshold }: Thresholds): Verdict =>
  score <= floor ? "pass" : score >= threshold ? "violation" : "review"

/** Probability that a random score from `high` exceeds one from `low`; ties count half. */
const separation = (low: ReadonlyArray<number>, high: ReadonlyArray<number>): number => {
  if (low.length === 0 || high.length === 0) return Number.NaN
  const all = [...low.map((value) => ({ value, high: false })), ...high.map((value) => ({ value, high: true }))]
    .sort((a, b) => a.value - b.value)
  let rankSum = 0
  for (let start = 0; start < all.length;) {
    let end = start
    while (end < all.length && all[end]!.value === all[start]!.value) end++
    const meanRank = (start + 1 + end) / 2
    for (let index = start; index < end; index++) if (all[index]!.high) rankSum += meanRank
    start = end
  }
  return (rankSum - (high.length * (high.length + 1)) / 2) / (high.length * low.length)
}

const scoresOf = (cases: ReadonlyArray<Scored>, gold: GoldClass) =>
  cases.filter((scored) => goldClass(scored) === gold).map(probability)

/** Separation of clear violations from clean cases (ambiguous cases excluded). */
export const auroc = (cases: ReadonlyArray<Scored>): number =>
  separation(scoresOf(cases, "clean"), scoresOf(cases, "violates"))

/**
 * Ordinal concordance: over every pair of cases with different targets (clean < ambiguous < violates),
 * the share where the higher target gets the higher score. Rewards placing ambiguous cases between.
 */
export const concordance = (cases: ReadonlyArray<Scored>): number => {
  const clean = scoresOf(cases, "clean")
  const ambiguous = scoresOf(cases, "ambiguous")
  const violates = scoresOf(cases, "violates")
  const parts = [[clean, ambiguous], [clean, violates], [ambiguous, violates]] as const
  let weighted = 0
  let pairs = 0
  for (const [low, high] of parts) {
    const count = low.length * high.length
    if (count === 0) continue
    weighted += separation(low, high) * count
    pairs += count
  }
  return pairs === 0 ? Number.NaN : weighted / pairs
}

/** Mean squared error of the probability against the 0 / 0.5 / 1 target; lower is better. */
export const brier = (cases: ReadonlyArray<Scored>): number =>
  cases.reduce((sum, scored) => sum + (target(scored) - probability(scored)) ** 2, 0) / cases.length

const share = (cases: ReadonlyArray<Scored>, include: (s: Scored) => boolean, hit: (s: Scored) => boolean) => {
  const included = cases.filter(include)
  return included.length === 0 ? Number.NaN : included.filter(hit).length / included.length
}

/**
 * Macro-averaged F1 of the three verdicts against the three gold classes (pass↔clean,
 * review↔ambiguous, violation↔violates). Classes absent from both gold and predictions are skipped.
 */
export const verdictF1 = (cases: ReadonlyArray<Scored>, thresholds: Thresholds): number => {
  const pairs: ReadonlyArray<readonly [GoldClass, Verdict]> = [["clean", "pass"], ["ambiguous", "review"], ["violates", "violation"]]
  const f1s = pairs.flatMap(([gold, predicted]) => {
    const actual = cases.filter((scored) => goldClass(scored) === gold).length
    const flagged = cases.filter((scored) => verdict(probability(scored), thresholds) === predicted)
    if (actual === 0 && flagged.length === 0) return []
    const hits = flagged.filter((scored) => goldClass(scored) === gold).length
    return [(2 * hits) / (actual + flagged.length)]
  })
  return f1s.reduce((sum, value) => sum + value, 0) / f1s.length
}

/** The cut-offs on a 0.025 grid that maximize `verdictF1`; meant for the dev split only. */
export const tuneThresholds = (cases: ReadonlyArray<Scored>): Thresholds => {
  let best: Thresholds = productionThresholds
  let bestF1 = -1
  for (let floor = 0.025; floor < 1; floor += 0.025) {
    for (let threshold = floor + 0.025; threshold <= 1; threshold += 0.025) {
      const candidate = { floor: Number(floor.toFixed(3)), threshold: Number(threshold.toFixed(3)) }
      const f1 = verdictF1(cases, candidate)
      if (f1 > bestF1) {
        bestF1 = f1
        best = candidate
      }
    }
  }
  return best
}

/**
 * Share of contrast pairs ordered correctly: for each policy whose target differs between a file and
 * its twin, the twin with the higher target must score higher. Ties count half.
 */
export const pairAccuracy = (cases: ReadonlyArray<Scored>): number => {
  const byCase = new Map(cases.map((scored) => [`${scored.item.file.id}:${scored.item.policy.name}`, scored]))
  let total = 0
  let count = 0
  for (const scored of cases) {
    const pair = scored.item.file.pair
    if (pair === undefined) continue
    const twin = byCase.get(`${pair}:${scored.item.policy.name}`)
    if (twin === undefined || target(scored) <= target(twin)) continue
    count++
    const difference = probability(scored) - probability(twin)
    total += difference > 0 ? 1 : difference === 0 ? 0.5 : 0
  }
  return count === 0 ? Number.NaN : total / count
}

export interface Quality {
  readonly auroc: number
  readonly concordance: number
  readonly brier: number
  readonly f1: number
  /** Share of clear violations given the `violation` verdict. */
  readonly caught: number
  /** Share of clear violations given `violation` or `review`. */
  readonly surfaced: number
  /** Share of ambiguous cases given `review`. */
  readonly ambiguousToReview: number
  /** Share of clean cases given `violation` or `review`. */
  readonly falseAlarms: number
  readonly pairs: number
  readonly inconclusive: number
}

export const quality = (cases: ReadonlyArray<Scored>, thresholds: Thresholds): Quality => {
  const of = (scored: Scored) => verdict(probability(scored), thresholds)
  return {
    auroc: auroc(cases),
    concordance: concordance(cases),
    brier: brier(cases),
    f1: verdictF1(cases, thresholds),
    caught: share(cases, (s) => goldClass(s) === "violates", (s) => of(s) === "violation"),
    surfaced: share(cases, (s) => goldClass(s) === "violates", (s) => of(s) !== "pass"),
    ambiguousToReview: share(cases, (s) => goldClass(s) === "ambiguous", (s) => of(s) === "review"),
    falseAlarms: share(cases, (s) => goldClass(s) === "clean", (s) => of(s) !== "pass"),
    pairs: pairAccuracy(cases),
    inconclusive: cases.filter((scored) => scored.score === null).length
  }
}

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

/** 95% bootstrap interval of `metric(cases)`, resampling files; NaN resamples (e.g. no violation drawn) are dropped. */
export const bootstrapInterval = (
  cases: ReadonlyArray<Scored>,
  metric: (cases: ReadonlyArray<Scored>) => number,
  samples = 2000
): readonly [number, number] => {
  const groups = new Map<string, Array<Scored>>()
  for (const scored of cases) groups.set(scored.item.file.id, [...(groups.get(scored.item.file.id) ?? []), scored])
  const files = [...groups.keys()].sort()
  const random = mulberry32(0x5eed)
  const values: Array<number> = []
  for (let sample = 0; sample < samples; sample++) {
    const drawn: Array<Scored> = []
    for (let draw = 0; draw < files.length; draw++) drawn.push(...groups.get(files[Math.floor(random() * files.length)]!)!)
    const value = metric(drawn)
    if (!Number.isNaN(value)) values.push(value)
  }
  values.sort((a, b) => a - b)
  return values.length === 0 ? [Number.NaN, Number.NaN] : [values[Math.floor(values.length * 0.025)]!, values[Math.floor(values.length * 0.975)]!]
}
