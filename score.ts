#!/usr/bin/env bun
// The lint-anything skill's score script, bundled to skills/lint-anything/scripts/score.js. Scores a policy
// against the code labeled for it in .lint-anything/labels/<policy>.jsonl, from the project root:
//   bun score.js <policy>                  the policy in .lint-anything/rules/<policy>.md
//   bun score.js <policy> <candidate.md>   that policy against a candidate (any path), paired
// Only items in labeled files are judged; answers share the CLI's cache in .lint-anything/cache.
import { BunServices } from "@effect/platform-bun"
import { Console, Effect, FileSystem, Layer, Runtime, Schema } from "effect"
import { Clef, inputTokenPrice, sumUsage } from "./src/clef.ts"
import { parsePolicy, type Policy } from "./src/policy.ts"
import {
  auroc,
  bootstrapInterval,
  caught,
  cliThresholds,
  falseAlarms,
  type Label,
  type LabelRecord,
  loadLabels,
  pairedInterval,
  type PolicyScore,
  quality,
  type Scored,
  scorePolicy,
  type Split,
  targetKey,
  verdict
} from "./src/score.ts"

const rulesDirectory = ".lint-anything/rules"
const cacheDirectory = ".lint-anything/cache"
const usage = "usage: bun score.js <policy> [candidate.md]   (from the project root)"

class UsageError extends Schema.TaggedError<UsageError>()("UsageError", { message: Schema.String }) {
  override readonly [Runtime.errorExitCode] = 2
}

const fixed = (value: number) => (Number.isNaN(value) ? "–" : value.toFixed(3))
const percent = (value: number) => (Number.isNaN(value) ? "–" : `${(value * 100).toFixed(0)}%`)
const signed = (value: number) => (Number.isNaN(value) ? "–" : `${value >= 0 ? "+" : ""}${value.toFixed(3)}`)
const interval = ([low, high]: readonly [number, number], format: (value: number) => string) => `[${format(low)}, ${format(high)}]`
const count = (cases: ReadonlyArray<Scored<unknown>>, label: Label) => cases.filter((scored) => scored.label === label).length
const ofSplit = <A extends Scored<LabelRecord>>(cases: ReadonlyArray<A>, split: Split) => cases.filter((scored) => scored.subject.split === split)
const splits: ReadonlyArray<Split> = ["dev", "test"]

const table = (scored: PolicyScore) => {
  const rows = [
    "| split | labels (violates / complies / ambiguous) | violations reached | AUROC [95%] | caught | surfaced | false alarms | ambiguous → review | too large |",
    "|---|---|---|---|---|---|---|---|---|"
  ]
  for (const split of splits) {
    const cases = ofSplit(scored.targets, split)
    const q = quality(cases, cliThresholds)
    const { reached, total } = scored.reach[split]
    rows.push(`| ${split} | ${count(cases, "violates")} / ${count(cases, "complies")} / ${count(cases, "ambiguous")} | ${reached}/${total} | ` +
      `${fixed(q.auroc)} ${interval(bootstrapInterval(cases, auroc), fixed)} | ${percent(q.caught)} | ${percent(q.surfaced)} | ` +
      `${percent(q.falseAlarms)} | ${percent(q.ambiguousToReview)} | ${q.inconclusive} |`)
  }
  return rows.join("\n")
}

const points = (value: number) => (Number.isNaN(value) ? "–" : `${value >= 0 ? "+" : ""}${(value * 100).toFixed(0)} pts`)

const comparison = (current: PolicyScore, candidate: PolicyScore) => {
  const rows = [
    "| split | AUROC | caught | false alarms |",
    "|---|---|---|---|"
  ]
  for (const split of splits) {
    const [before, after] = [ofSplit(current.targets, split), ofSplit(candidate.targets, split)]
    const delta = (metric: (cases: ReadonlyArray<Scored<unknown>>) => number, format: (value: number) => string) => {
      const range = pairedInterval(before, after, metric)
      const noise = range[0] <= 0 && 0 <= range[1] ? ", within noise" : ""
      return `${format(metric(after) - metric(before))} ${interval(range, format)}${noise}`
    }
    rows.push(`| ${split} | ${delta(auroc, signed)} | ${delta(caught, points)} | ${delta(falseAlarms, points)} |`)
  }
  return rows.join("\n")
}

/** Dev targets the policy gets wrong at the CLI's cut-offs, and violations no item reaches. Test stays hidden. */
const devMistakes = (scored: PolicyScore) => {
  const lines: Array<string> = []
  const dev = ofSplit(scored.targets, "dev")
  const itemsOf = (record: LabelRecord) => scored.items.filter((item) => item.group === targetKey(record))
  for (const target of dev) {
    const got = target.score === null ? "too large" : verdict(target.score, cliThresholds)
    const score = target.score === null ? "–" : target.score.toFixed(2)
    const record = target.subject
    const where = targetKey(record)
    if (target.label === "violates") {
      const items = itemsOf(record).map(({ subject }) => subject)
      const unreached = (record.lines ?? []).filter(([start, end]) =>
        !items.some((item) => item.lines === undefined || (item.lines[0] <= end && start <= item.lines[1])))
      if (unreached.length > 0) lines.push(`- ${where}: violation at ${unreached.map(([s, e]) => `${s}-${e}`).join(", ")} is in no item`)
      if (got !== "violation") lines.push(`- ${where}: violates, got ${got} (${score})`)
    } else if (target.label === "complies" && got !== "pass") {
      const worst = itemsOf(record).toSorted((a, b) => (b.score ?? 0) - (a.score ?? 0))[0]
      const at = worst?.subject.lines === undefined ? "" : ` at ${worst.subject.lines[0]}-${worst.subject.lines[1]}`
      lines.push(`- ${where}: complies, got ${got} (${score}${at})`)
    } else if (target.label === "ambiguous" && got !== "review") {
      lines.push(`- ${where}: ambiguous, got ${got} (${score})`)
    }
  }
  return lines.length === 0 ? "none" : lines.join("\n")
}

const program = Effect.gen(function*() {
  const [name, candidatePath, ...extra] = Bun.argv.slice(2)
  if (name === undefined || name.startsWith("-") || extra.length > 0) return yield* new UsageError({ message: usage })
  const fs = yield* FileSystem.FileSystem
  const read = (path: string) => fs.readFileString(path).pipe(Effect.mapError(() => new UsageError({ message: `cannot read ${path}` })))
  const current = yield* parsePolicy(name, yield* read(`${rulesDirectory}/${name}.md`))
  const candidate: Policy | undefined = candidatePath === undefined
    ? undefined
    : yield* parsePolicy(`${name} (candidate)`, yield* read(candidatePath))
  const labels = yield* loadLabels(name)
  const clef = yield* Clef
  const [base, other] = yield* Effect.all([
    scorePolicy(current, labels),
    candidate === undefined ? Effect.succeed(undefined) : scorePolicy(candidate, labels)
  ], { concurrency: 2 })
  const total = (split: Split) => labels.filter((record) => record.split === split).length
  yield* Console.log(`${name}: ${labels.length} labeled targets (dev ${total("dev")}, test ${total("test")}); verdicts at the CLI's cut-offs ` +
    `${cliThresholds.floor} / ${cliThresholds.threshold}; a target scores its highest item (0 without items); intervals are 95% bootstraps over targets.\n`)
  yield* Console.log(`current (${rulesDirectory}/${name}.md)\n${table(base)}\n`)
  if (other !== undefined) {
    yield* Console.log(`candidate (${candidatePath})\n${table(other)}\n`)
    yield* Console.log(`candidate − current, paired over the same targets\n${comparison(base, other)}\n`)
    yield* Console.log("Decide on test; tune on dev.\n")
  }
  yield* Console.log(`dev mistakes (${other === undefined ? "current" : "candidate"}; test is held out)\n${devMistakes(other ?? base)}\n`)
  const spent = sumUsage((yield* clef.stats).values())
  yield* Console.log(`cost: ${spent.requests} requests, ${spent.cached} answers from the cache, ${spent.inputTokens} input tokens, ` +
    `$${(spent.inputTokens * inputTokenPrice).toFixed(4)}`)
})

program.pipe(
  Effect.provide(Layer.mergeAll(Clef.layer(cacheDirectory), BunServices.layer)),
  Effect.catch((error) =>
    Console.error(`error: ${"message" in error ? error.message : String(error)}`).pipe(Effect.andThen(Effect.sync(() => (process.exitCode = 2))))
  ),
  Effect.runPromise
)
