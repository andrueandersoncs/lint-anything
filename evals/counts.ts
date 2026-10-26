// Measures `limit`: does counting judged items answer a count rule ("at most 3 issue-less TODOs per file")
// better than asking Clef the count rule about the whole file? Generates 64 files with a known number of
// issue-less TODOs (0 to 7, most near the limit) and judges them both ways through the eval client: A, a
// count-rule policy whose selector emits each whole file as one item; B, a per-TODO policy with `limit`.
//   bun evals/counts.ts [--concurrency 8]
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Result } from "effect"
import { decide, defaultThreshold, reviewFloor, verdictOf } from "../src/lint.ts"
import type { Policy } from "../src/policy.ts"
import { runSelector } from "../src/select.ts"
import { makeClient } from "./client.ts"
import { adHocPolicy, type Case } from "./corpus.ts"
import { auroc, type Scored } from "./metrics.ts"
import { costPerThousand, type ItemCase, productionPlan, scoreItems } from "./selected.ts"

const concurrencyIndex = Bun.argv.indexOf("--concurrency")
const ask = makeClient(concurrencyIndex === -1 ? 8 : Number(Bun.argv[concurrencyIndex + 1]))
const limit = 3

// Deterministic PRNG, so the files (and every request) are the same on each run.
const mulberry32 = (seed: number) => () => {
  let t = (seed += 0x6d2b79f5)
  t = Math.imul(t ^ (t >>> 15), t | 1)
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}
const random = mulberry32(31337)
const pick = <A>(values: ReadonlyArray<A>) => values[Math.floor(random() * values.length)]!
const tasks = ["handle the timeout", "cache this lookup", "validate input", "support paging", "log failures", "make this configurable",
  "split this up", "add retries", "drop the fallback", "batch the writes", "check permissions", "rename after the migration"]
const references = ["(#412)", "see #88", "tracked in OPS-219", "https://github.com/acme/app/issues/77"]
const languages = [
  { extension: "ts", comment: "//", code: (n: number) => `export const step${n} = (value: number) => value + ${n}` },
  { extension: "py", comment: "#", code: (n: number) => `def step_${n}(value):\n    return value + ${n}` },
  { extension: "go", comment: "//", code: (n: number) => `func Step${n}(value int) int { return value + ${n} }` }
]
// Issue-less TODO counts, weighted toward the limit (3 passes, 4 fails).
const counts = [0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 2, 2, 2, 2, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3,
  4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 5, 5, 5, 5, 5, 5, 5, 5, 6, 6, 6, 6, 6, 6, 7, 7, 7, 7, 7, 7]
const directory = mkdtempSync(join(tmpdir(), "lint-anything-counts-"))
const files = await Promise.all(counts.map(async (issueless, index) => {
  const language = languages[index % languages.length]!
  const tracked = Math.floor(random() * 4)
  const todos = [...Array.from({ length: issueless }, () => false), ...Array.from({ length: tracked }, () => true)]
    .map((value) => ({ value, order: random() })).sort((a, b) => a.order - b.order).map(({ value }) => value)
  const lines = [language.code(0)]
  todos.forEach((hasIssue, n) => {
    lines.push("", `${language.comment} ${random() < 0.8 ? "TODO" : "FIXME"}: ${pick(tasks)}${hasIssue ? ` ${pick(references)}` : ""}`, language.code(n + 1))
  })
  const path = `src/module_${index}.${language.extension}`
  const source = `${lines.join("\n")}\n`
  await Bun.write(join(directory, path), source)
  return { path, source, issueless, total: todos.length }
}))

// Both selectors read the generated sources under src/ and end in present.ts, which writes each item's
// location into its text as the corpus selectors do.
// A's rule counts across the file, so its selector hands Clef each whole file as one item.
const whole = adHocPolicy("counts/whole-file", `rg --files --sort path src | bun "$EVAL_STEPS/whole-file.ts" | bun "$EVAL_STEPS/present.ts"`,
  `# At most ${limit} untracked TODOs\n\nA file may contain at most ${limit} \`TODO\` or \`FIXME\` comments that don't reference a tracking issue ` +
  `(\`#123\`, \`ABC-123\`, or an issue URL). Report a file with ${limit + 1} or more.`)
// B's rule is about one TODO, so its selector emits each TODO line; `limit` does the counting.
const items = adHocPolicy("counts/limit",
  `rg --json -w 'TODO|FIXME' src |\n  jq -c 'select(.type == "match") | {id: "\\(.data.path.text):\\(.data.line_number)", path: .data.path.text, ` +
    `lines: [.data.line_number, .data.line_number], text: (.data.lines.text | rtrimstr("\\n"))}' |\n  bun "$EVAL_STEPS/present.ts"`,
  "# TODOs reference an issue\n\nEvery `TODO` or `FIXME` comment must reference a tracking issue, written as `#123`, `ABC-123`, or a full issue URL.",
  { max: limit, per: "file" })

/** Runs `policy`'s selector in the generated directory and judges its items in the CLI's order, one group per file. */
const judge = async (policy: Policy) => {
  const selected = await Effect.runPromise(runSelector(policy, directory))
  const itemCases: Array<ItemCase> = selected.toSorted((a, b) => a.id.localeCompare(b.id)).map((entry) => ({
    id: entry.id, file: { id: entry.path! } as Case["file"], policy, gold: { label: "complies", note: "" }, entry
  }))
  return scoreItems(ask, itemCases, productionPlan)
}
const entryOf = (scored: Scored) => (scored.item as ItemCase).entry

try {
  // A: the count rule asked about each whole file.
  const wholeRun = await judge(whole)
  const wholeScores = new Map(wholeRun.scored.map((scored) => [entryOf(scored).path!, scored.score ?? 0]))

  // B: each TODO judged against the item rule, then counted against the limit.
  const run = await judge(items)
  const counted = new Map(
    decide(items, run.scored.map(entryOf), run.scored.map((scored) => Result.succeed(scored.score ?? 0)), defaultThreshold)
      .map((finding) => [finding.path!, finding])
  )

  const rows = files.map((file) => {
    const aggregateFinding = counted.get(file.path)
    const wholeScore = wholeScores.get(file.path) ?? 0
    return {
      file,
      violates: file.issueless > limit,
      wholeScore,
      wholeSaysViolation: verdictOf(wholeScore, reviewFloor, defaultThreshold) === "violation",
      count: aggregateFinding?.violating?.length ?? 0,
      limitSaysViolation: aggregateFinding?.verdict === "violation"
    }
  })
  const near = rows.filter(({ file }) => file.issueless === limit || file.issueless === limit + 1)
  const accuracy = (subset: typeof rows, says: (row: (typeof rows)[number]) => boolean) =>
    `${((100 * subset.filter((row) => says(row) === row.violates).length) / subset.length).toFixed(0)}% (${subset.filter((row) => says(row) === row.violates).length}/${subset.length})`
  const asScored = (score: (row: (typeof rows)[number]) => number): Array<Scored> =>
    rows.map((row) => ({ item: { id: row.file.path, file: { id: row.file.path }, gold: { label: row.violates ? "violates" : "complies" } } as unknown as Case, score: score(row) }))
  const tokens = (judged: typeof run) => [...judged.inputTokens.values()].reduce((sum, value) => sum + value, 0)
  console.log(`\n${files.length} files, ${rows.filter((row) => row.violates).length} with more than ${limit} issue-less TODOs; ${near.length} with exactly ${limit} or ${limit + 1}.`)
  console.log("| Approach | Accuracy | At the limit (3 or 4) | AUROC | $ / 1k files |\n|---|---|---|---|---|")
  console.log(`| A. count rule, whole file | ${accuracy(rows, (row) => row.wholeSaysViolation)} | ${accuracy(near, (row) => row.wholeSaysViolation)} | ` +
    `${auroc(asScored((row) => row.wholeScore)).toFixed(3)} | $${costPerThousand(tokens(wholeRun), files.length).toFixed(3)} |`)
  console.log(`| B. item rule + limit | ${accuracy(rows, (row) => row.limitSaysViolation)} | ${accuracy(near, (row) => row.limitSaysViolation)} | ` +
    `${auroc(asScored((row) => row.count)).toFixed(3)} | $${costPerThousand(tokens(run), files.length).toFixed(3)} |`)
  const exact = rows.filter((row) => row.count === row.file.issueless).length
  const error = rows.reduce((sum, row) => sum + Math.abs(row.count - row.file.issueless), 0) / rows.length
  console.log(`\nB's counts: exact for ${exact} of ${rows.length} files, mean absolute error ${error.toFixed(2)} TODOs.`)
} finally {
  rmSync(directory, { recursive: true, force: true })
}
