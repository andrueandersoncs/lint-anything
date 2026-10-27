import { Effect, FileSystem, Path, Result, Runtime, Schema, SchemaIssue } from "effect"
import type { Item } from "./item.ts"
import { defaultThreshold, judge, reviewFloor, select } from "./lint.ts"
import type { Policy } from "./policy.ts"

// Scoring a policy against labeled code: what a tuning agent measures with the skill's score script, and
// what the evals report on their corpus. Labels name code locations, not selector items, so a changed
// selector is scored against the same labels.

/** What a label says about a file (or an item) against one policy. */
export type Label = "violates" | "complies" | "ambiguous"

/** Labels are tuned on (`dev`) or held out to decide with (`test`). */
export type Split = "dev" | "test"

/** A 1-based, inclusive line range. */
export type Range = readonly [number, number]

const Range = Schema.Tuple([Schema.Int, Schema.Int]).check(
  Schema.makeFilter(([start, end]) => (1 <= start && start <= end) || "lines must be [start, end] with 1 <= start <= end")
)

const LabelFields = Schema.Struct({
  path: Schema.optional(Schema.NonEmptyString),
  item: Schema.optional(Schema.NonEmptyString),
  label: Schema.Literals(["violates", "complies", "ambiguous"]),
  lines: Schema.optional(Schema.Array(Range)),
  split: Schema.Literals(["dev", "test"]),
  note: Schema.optional(Schema.String)
})

/**
 * One labeled target for a policy: a file (`path`), or an item without a path (`item`, its id). A violating
 * file gives the line ranges of its violations (`lines`); an item of that file is a violation when its lines
 * overlap one of them.
 */
export type LabelRecord = Schema.Schema.Type<typeof LabelFields>

export class LabelError extends Schema.TaggedError<LabelError>()("LabelError", {
  message: Schema.String
}) {
  override readonly [Runtime.errorExitCode] = 2
}

const formatIssues = SchemaIssue.makeFormatterStandardSchemaV1()

/** Where a target is: its path, or `item <id>`. */
export const targetKey = (record: LabelRecord) => (record.path !== undefined ? record.path : `item ${record.item}`)

/** Parses a labels file, JSONL with one label per non-empty line; `name` is for messages. */
export const parseLabels = Effect.fn("parseLabels")(function*(name: string, text: string) {
  const records: Array<LabelRecord> = []
  const seen = new Set<string>()
  for (const [index, line] of text.split("\n").entries()) {
    if (line.trim() === "") continue
    const fail = (reason: string) => new LabelError({ message: `${name}:${index + 1}: ${reason}` })
    const value = yield* Effect.try({ try: (): unknown => JSON.parse(line), catch: () => fail("not valid JSON") })
    if (typeof value !== "object" || value === null || Array.isArray(value)) return yield* fail("not an object")
    const unknown = Object.keys(value).filter((key) => !(key in LabelFields.fields))
    if (unknown.length > 0) return yield* fail(`unknown field ${unknown.join(", ")}`)
    const record = yield* Schema.decodeUnknownEffect(LabelFields)(value).pipe(
      Effect.mapError((error) =>
        fail(formatIssues(error.issue).issues.map(({ path, message }) => `${path?.length ? `${path.join(".")}: ` : ""}${message}`).join("; "))
      )
    )
    if ((record.path === undefined) === (record.item === undefined)) return yield* fail("give exactly one of path and item")
    if (record.label === "violates" && record.path !== undefined && (record.lines ?? []).length === 0) {
      return yield* fail("a violating file needs lines: the ranges of its violations")
    }
    if (record.lines !== undefined && (record.label !== "violates" || record.path === undefined)) {
      return yield* fail("lines belong only to a violating file")
    }
    const key = targetKey(record)
    if (seen.has(key)) return yield* fail(`${key} is labeled twice`)
    seen.add(key)
    records.push(record)
  }
  return records
})

/** Loads `<directory>/<policy name>.jsonl`. */
export const loadLabels = Effect.fn("loadLabels")(function*(policyName: string, directory = ".lint-anything/labels") {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const file = path.join(directory, `${policyName}.jsonl`)
  const text = yield* fs.readFileString(file).pipe(
    Effect.mapError(() => new LabelError({ message: `cannot read ${file}; label the policy's code there first` }))
  )
  return yield* parseLabels(file, text)
})

const overlaps = (lines: Range, [start, end]: Range) => lines[0] <= end && start <= lines[1]

/**
 * An item's label within its target: a violating file's item is `violates` when its lines overlap one of
 * the violations (an item without lines covers the whole file) and `complies` otherwise; every other item
 * takes its target's label.
 */
export const itemLabel = (target: { readonly label: Label; readonly lines?: ReadonlyArray<Range> }, item: Item): Label =>
  target.label !== "violates" || target.lines === undefined
    ? target.label
    : target.lines.some((range) => item.lines === undefined || overlaps(item.lines, range))
    ? "violates"
    : "complies"

/** How many of `ranges` some item covers; items without lines cover every range. */
export const reachedRanges = (ranges: ReadonlyArray<Range>, items: ReadonlyArray<Item>) =>
  ranges.filter((range) => items.some((item) => item.lines === undefined || overlaps(item.lines, range))).length

/**
 * A target's score as a lint run reports it: its highest item score, 0 when the selector found nothing in
 * it, and `null` when none of its items could be sent.
 */
export const targetScore = (scores: ReadonlyArray<number | null>): number | null => {
  const answered = scores.filter((score) => score !== null)
  return scores.length > 0 && answered.length === 0 ? null : Math.max(0, ...answered)
}

/** The items each label applies to: a file's items by path, a pathless item by id. */
export const itemsOf = (record: LabelRecord, items: ReadonlyArray<Item>) =>
  items.filter((item) => (record.path !== undefined ? item.path === record.path : item.path === undefined && item.id === record.item))

// --- Metrics ----------------------------------------------------------------------------------------

/**
 * A labeled unit with a policy's violation probability (`null`: too large to send). `group` is the
 * resampling unit for intervals: units in one group share requests and are not independent.
 */
export interface Scored<A> {
  readonly subject: A
  readonly label: Label
  readonly group: string
  readonly score: number | null
}

/** Verdict cut-offs: `pass` at or below `floor`, `violation` at or above `threshold`, `review` between. */
export interface Thresholds {
  readonly floor: number
  readonly threshold: number
}

/** The cut-offs a lint run uses. */
export const cliThresholds: Thresholds = { floor: reviewFloor, threshold: defaultThreshold }

export type ScoreVerdict = "pass" | "review" | "violation"

export const verdict = (score: number, { floor, threshold }: Thresholds): ScoreVerdict =>
  score <= floor ? "pass" : score >= threshold ? "violation" : "review"

/** The ideal probability for a unit: 1 for a clear violation, 0.5 when reviewers split, 0 otherwise. */
const idealScore = (scored: Scored<unknown>): number => ({ complies: 0, ambiguous: 0.5, violates: 1 })[scored.label]

// An unsent request reports nothing, so it counts as a 0 score: a miss on violations, harmless otherwise.
const probability = (scored: Scored<unknown>) => scored.score ?? 0

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

const scoresOf = (cases: ReadonlyArray<Scored<unknown>>, label: Label) =>
  cases.filter((scored) => scored.label === label).map(probability)

/** Separation of clear violations from clean units (ambiguous units excluded). */
export const auroc = (cases: ReadonlyArray<Scored<unknown>>): number =>
  separation(scoresOf(cases, "complies"), scoresOf(cases, "violates"))

/**
 * Ordinal concordance: over every pair of units with different targets (clean < ambiguous < violates),
 * the share where the higher target gets the higher score. Rewards placing ambiguous units between.
 */
export const concordance = (cases: ReadonlyArray<Scored<unknown>>): number => {
  const clean = scoresOf(cases, "complies")
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
export const brier = (cases: ReadonlyArray<Scored<unknown>>): number =>
  cases.reduce((sum, scored) => sum + (idealScore(scored) - probability(scored)) ** 2, 0) / cases.length

const share = (cases: ReadonlyArray<Scored<unknown>>, include: (s: Scored<unknown>) => boolean, hit: (s: Scored<unknown>) => boolean) => {
  const included = cases.filter(include)
  return included.length === 0 ? Number.NaN : included.filter(hit).length / included.length
}

/**
 * Macro-averaged F1 of the three verdicts against the three labels (pass↔complies, review↔ambiguous,
 * violation↔violates). Labels absent from both labels and predictions are skipped.
 */
export const verdictF1 = (cases: ReadonlyArray<Scored<unknown>>, thresholds: Thresholds): number => {
  const pairs: ReadonlyArray<readonly [Label, ScoreVerdict]> = [["complies", "pass"], ["ambiguous", "review"], ["violates", "violation"]]
  const f1s = pairs.flatMap(([label, predicted]) => {
    const actual = cases.filter((scored) => scored.label === label).length
    const flagged = cases.filter((scored) => verdict(probability(scored), thresholds) === predicted)
    if (actual === 0 && flagged.length === 0) return []
    const hits = flagged.filter((scored) => scored.label === label).length
    return [(2 * hits) / (actual + flagged.length)]
  })
  return f1s.reduce((sum, value) => sum + value, 0) / f1s.length
}

/** The cut-offs on a 0.025 grid that maximize `verdictF1`; in-sample, so pick them on dev only. */
export const tuneThresholds = (cases: ReadonlyArray<Scored<unknown>>): Thresholds => {
  let best: Thresholds = cliThresholds
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

export interface Quality {
  readonly auroc: number
  readonly concordance: number
  readonly brier: number
  readonly f1: number
  /** Share of clear violations given the `violation` verdict. */
  readonly caught: number
  /** Share of clear violations given `violation` or `review`. */
  readonly surfaced: number
  /** Share of ambiguous units given `review`. */
  readonly ambiguousToReview: number
  /** Share of clean units given `violation` or `review`. */
  readonly falseAlarms: number
  /** Units too large to send. */
  readonly inconclusive: number
}

export const quality = (cases: ReadonlyArray<Scored<unknown>>, thresholds: Thresholds): Quality => {
  const of = (scored: Scored<unknown>) => verdict(probability(scored), thresholds)
  return {
    auroc: auroc(cases),
    concordance: concordance(cases),
    brier: brier(cases),
    f1: verdictF1(cases, thresholds),
    caught: share(cases, (s) => s.label === "violates", (s) => of(s) === "violation"),
    surfaced: share(cases, (s) => s.label === "violates", (s) => of(s) !== "pass"),
    ambiguousToReview: share(cases, (s) => s.label === "ambiguous", (s) => of(s) === "review"),
    falseAlarms: share(cases, (s) => s.label === "complies", (s) => of(s) !== "pass"),
    inconclusive: cases.filter((scored) => scored.score === null).length
  }
}

/** Share of clear violations given `violation` at the CLI's cut-offs. */
export const caught = (cases: ReadonlyArray<Scored<unknown>>) => quality(cases, cliThresholds).caught
/** Share of clean units not passed at the CLI's cut-offs. */
export const falseAlarms = (cases: ReadonlyArray<Scored<unknown>>) => quality(cases, cliThresholds).falseAlarms

// Deterministic PRNG so bootstrap intervals are reproducible.
const mulberry32 = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

const byGroup = <A>(cases: ReadonlyArray<Scored<A>>) => {
  const groups = new Map<string, Array<Scored<A>>>()
  for (const scored of cases) {
    const list = groups.get(scored.group) ?? []
    list.push(scored)
    groups.set(scored.group, list)
  }
  return groups
}

const percentiles = (values: Array<number>): readonly [number, number] => {
  values.sort((a, b) => a - b)
  return values.length === 0
    ? [Number.NaN, Number.NaN]
    : [values[Math.floor(values.length * 0.025)]!, values[Math.floor(values.length * 0.975)]!]
}

/**
 * 95% paired-bootstrap interval of `metric(candidate) − metric(baseline)`, resampling groups. Both runs must
 * cover the same groups.
 */
export const pairedInterval = <A>(
  baseline: ReadonlyArray<Scored<A>>,
  candidate: ReadonlyArray<Scored<A>>,
  metric: (cases: ReadonlyArray<Scored<A>>) => number,
  samples = 2000
): readonly [number, number] => {
  const before = byGroup(baseline)
  const after = byGroup(candidate)
  const groups = [...before.keys()].sort()
  const random = mulberry32(0x5eed)
  const deltas: Array<number> = []
  for (let sample = 0; sample < samples; sample++) {
    const left: Array<Scored<A>> = []
    const right: Array<Scored<A>> = []
    for (let draw = 0; draw < groups.length; draw++) {
      const group = groups[Math.floor(random() * groups.length)]!
      left.push(...before.get(group)!)
      right.push(...(after.get(group) ?? []))
    }
    const delta = metric(right) - metric(left)
    if (!Number.isNaN(delta)) deltas.push(delta)
  }
  return percentiles(deltas)
}

/** 95% bootstrap interval of `metric(cases)`, resampling groups; NaN resamples (no violation drawn) are dropped. */
export const bootstrapInterval = <A>(
  cases: ReadonlyArray<Scored<A>>,
  metric: (cases: ReadonlyArray<Scored<A>>) => number,
  samples = 2000
): readonly [number, number] => {
  const groups = byGroup(cases)
  const keys = [...groups.keys()].sort()
  const random = mulberry32(0x5eed)
  const values: Array<number> = []
  for (let sample = 0; sample < samples; sample++) {
    const drawn: Array<Scored<A>> = []
    for (let draw = 0; draw < keys.length; draw++) drawn.push(...groups.get(keys[Math.floor(random() * keys.length)]!)!)
    const value = metric(drawn)
    if (!Number.isNaN(value)) values.push(value)
  }
  return percentiles(values)
}

// --- Scoring a policy -------------------------------------------------------------------------------

/** What scoring a policy against its labels found. */
export interface PolicyScore {
  /** Each labeled target with its score: the highest score of its items, as a lint run reports it. */
  readonly targets: ReadonlyArray<Scored<LabelRecord>>
  /** Each item in a labeled target, labeled by overlap with its target's violations. */
  readonly items: ReadonlyArray<Scored<Item>>
  /** Violation ranges some item covers, of all labeled violation ranges, per split. */
  readonly reach: Readonly<Record<Split, { readonly reached: number; readonly total: number }>>
}

/**
 * Runs `policy`'s selector from `cwd` and judges the items that fall in a labeled target (only those: the
 * rest of the codebase costs nothing). Needs the `Clef` service.
 */
export const scorePolicy = Effect.fn("scorePolicy")(function*(policy: Policy, labels: ReadonlyArray<LabelRecord>, cwd?: string) {
  const selected = yield* select(policy, cwd)
  const ofTarget = labels.map((record) => ({ record, items: itemsOf(record, selected) }))
  // Judged in the order a lint run judges them, so packing matches as closely as a subset can.
  const inTargets = new Set(ofTarget.flatMap(({ items }) => items))
  const judged = selected.filter((item) => inTargets.has(item))
  const answers = yield* judge(policy, judged)
  const scoreOf = new Map(judged.map((item, index) => [item, answers[index]!]))
  const score = (item: Item) => Result.match(scoreOf.get(item)!, { onSuccess: (violates) => violates, onFailure: () => null })
  const reach = { dev: { reached: 0, total: 0 }, test: { reached: 0, total: 0 } }
  for (const { record, items } of ofTarget) {
    const ranges = record.label === "violates" ? record.lines ?? [] : []
    reach[record.split].reached += reachedRanges(ranges, items)
    reach[record.split].total += ranges.length
  }
  return {
    targets: ofTarget.map(({ record, items }) => ({ subject: record, label: record.label, group: targetKey(record), score: targetScore(items.map(score)) })),
    items: ofTarget.flatMap(({ record, items }) =>
      items.map((item) => ({ subject: item, label: itemLabel(record, item), group: targetKey(record), score: score(item) }))
    ),
    reach
  } satisfies PolicyScore
})
