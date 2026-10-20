// Measures whether evidence from outside the file (today's date, git history) makes a date rule judgeable.
// Builds a git repository whose TODOs were committed on known dates, then judges "TODOs added more than 90
// days ago must reference an issue" with four policies that differ only in their evidence.
//   bun evals/history.ts [--concurrency 8]
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { defaultItemThreshold, itemReviewFloor } from "../src/lint.ts"
import { parsePolicy } from "../src/policy.ts"
import { runSelector, withEvidence } from "../src/select.ts"
import { makeClient } from "./client.ts"
import type { Case } from "./corpus.ts"
import { auroc, brier, pairedInterval, quality, type Scored } from "./metrics.ts"
import { costPerThousand, type ItemCase, productionPlan, scoreItems } from "./selected.ts"

const args = Bun.argv.slice(2)
const concurrencyIndex = args.indexOf("--concurrency")
const concurrency = concurrencyIndex === -1 ? 8 : Number(args[concurrencyIndex + 1])
const today = "2026-10-20"
const day = 86_400_000

// --- Fixture --------------------------------------------------------------------------------------

// Deterministic PRNG, so the repository (and every request) is the same on each run.
const mulberry32 = (seed: number) => () => {
  let t = (seed += 0x6d2b79f5)
  t = Math.imul(t ^ (t >>> 15), t | 1)
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}
const random = mulberry32(20261020)
const pick = <A>(values: ReadonlyArray<A>) => values[Math.floor(random() * values.length)]!

const tasks = [
  "handle the timeout case", "remove this once the old API is gone", "cache this lookup", "validate the input",
  "support pagination", "log the failure", "make this configurable", "split this function", "add retries",
  "use the shared client", "document the edge cases", "drop the legacy fallback", "batch these writes",
  "check permissions first", "clean up after the migration", "rename once callers move"
]
const references = ["(#4127)", "see #812", "tracked in OPS-219", "https://github.com/acme/app/issues/77", "(PLAT-1043)"]
const languages = [
  { extension: "ts", comment: "//", code: (n: number) => `export const step${n} = (value: number) => value + ${n}` },
  { extension: "py", comment: "#", code: (n: number) => `def step_${n}(value):\n    return value + ${n}` },
  { extension: "go", comment: "//", code: (n: number) => `func Step${n}(value int) int { return value + ${n} }` }
]

interface Todo {
  readonly path: string
  readonly age: number
  readonly issue: boolean
  readonly text: string
  line?: number
}

const todos: Array<Todo> = []
const files = Array.from({ length: 18 }, (_, index) => {
  const language = languages[index % languages.length]!
  return { path: `src/module_${index}.${language.extension}`, language }
})
for (const file of files) {
  for (let n = 0; n < 7; n++) {
    // Nearly half sit within ten days of the 90-day threshold.
    const age = random() < 0.45 ? 80 + Math.floor(random() * 21) : 1 + Math.floor(random() * 400)
    const issue = random() < 0.35
    const marker = random() < 0.8 ? "TODO" : "FIXME"
    todos.push({
      path: file.path,
      age,
      issue,
      text: `${file.language.comment} ${marker}: ${pick(tasks)}${issue ? ` ${pick(references)}` : ""}`
    })
  }
}

const repository = mkdtempSync(join(tmpdir(), "lint-anything-history-"))
const git = (env: Record<string, string>, ...command: Array<string>) =>
  Bun.$`git ${command}`.cwd(repository).env({ ...process.env, ...env }).quiet()
const at = (age: number) => {
  const date = `${new Date(Date.parse(today) - age * day).toISOString().slice(0, 10)}T12:00:00Z`
  return { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date, GIT_AUTHOR_NAME: "eval", GIT_AUTHOR_EMAIL: "eval@example.com", GIT_COMMITTER_NAME: "eval", GIT_COMMITTER_EMAIL: "eval@example.com" }
}
await git({}, "init", "-q")
const contents = new Map(files.map((file) => [file.path, file.language.code(0).split("\n")]))
for (const [path, lines] of contents) await Bun.write(join(repository, path), `${lines.join("\n")}\n`)
await git(at(450), "add", "-A")
await git(at(450), "commit", "-q", "-m", "Initial modules")
// Oldest first, so every TODO line is blamed on the commit that added it.
const ordered = [...todos].sort((a, b) => b.age - a.age)
for (const [index, todo] of ordered.entries()) {
  const lines = contents.get(todo.path)!
  const language = files.find((file) => file.path === todo.path)!.language
  lines.push("", todo.text, ...language.code(index + 1).split("\n"))
  todo.line = lines.indexOf(todo.text, lines.length - 1 - language.code(index + 1).split("\n").length)
  await Bun.write(join(repository, todo.path), `${lines.join("\n")}\n`)
  await git(at(todo.age), "commit", "-q", "-am", `Add step ${index + 1}`)
}
const truth = new Map(todos.map((todo) => [`${todo.path}:${todo.line! + 1}`, todo]))

// --- Policies -------------------------------------------------------------------------------------

const rule = "# Old TODOs reference an issue\n\nA `TODO` or `FIXME` comment added more than 90 days ago must reference a tracking issue, " +
  "written as `#123`, `ABC-123`, or a full issue URL. TODOs added in the last 90 days don't need one."
const select = (steps: string) =>
  `select: |\n  rg --json -w 'TODO|FIXME' "$@" |\n    jq -c 'select(.type == "match") | {id: "\\(.data.path.text):\\(.data.line_number)", ` +
  `path: .data.path.text, lines: [.data.line_number, .data.line_number], text: (.data.lines.text | rtrimstr("\\n"))}'${steps}`
const todayStep = `evidence:\n  today: echo ${today}\n`
const arms = {
  none: `---\n${select("")}\n---\n${rule}\n`,
  today: `---\n${todayStep}${select("")}\n---\n${rule}\n\nToday is {{today}}.\n`,
  // The commit date alone; Clef has to work out the age.
  date: `---\n${todayStep}${select(` |\n    $LINT_ANYTHING blame --today ${today} | jq -c '.changed |= (split(",")[0])'`)}\n---\n${rule}\n\nToday is {{today}}.\n`,
  age: `---\n${todayStep}${select(` |\n    $LINT_ANYTHING blame --today ${today}`)}\n---\n${rule}\n\nToday is {{today}}.\n`
}

// --- Run ------------------------------------------------------------------------------------------

const ask = makeClient(concurrency)
const paths = files.map((file) => file.path)
const results = []
try {
  for (const [arm, source] of Object.entries(arms)) {
    const policy = Effect.runSync(parsePolicy(`history/${arm}`, source))
    const selected = await Effect.runPromise(withEvidence(policy, paths, repository, (resolved, env) =>
      runSelector({ ...resolved, select: policy.select! }, paths, repository, env).pipe(Effect.map((items) => ({ items, resolved })))))
    const items: Array<ItemCase> = selected.items.map((entry) => {
      const todo = truth.get(entry.id)
      if (todo === undefined) throw new Error(`selector found an unexpected TODO at ${entry.id}`)
      return {
        id: `${arm}:${entry.id}`,
        file: { id: entry.path! } as Case["file"],
        policy: selected.resolved,
        gold: { label: todo.age > 90 && !todo.issue ? "violates" : "complies", note: "" },
        entry
      }
    })
    if (items.length !== todos.length) throw new Error(`${arm}: selected ${items.length} of ${todos.length} TODOs`)
    const run = await scoreItems(ask, items, productionPlan)
    results.push({ arm, run, items })
  }
} finally {
  rmSync(repository, { recursive: true, force: true })
}

// --- Report ---------------------------------------------------------------------------------------

const ageOf = (scored: Scored) => truth.get((scored.item as ItemCase).entry.id)!
const near = (scored: ReadonlyArray<Scored>) => scored.filter((entry) => Math.abs(ageOf(entry).age - 90) <= 5)
const youngWithoutIssue = (scored: ReadonlyArray<Scored>) => scored.filter((entry) => ageOf(entry).age <= 90 && !ageOf(entry).issue)
// Binary accuracy at the CLI's item threshold: `violation` vs. anything else.
const accuracy = (scored: ReadonlyArray<Scored>) =>
  scored.filter((entry) => ((entry.score ?? 0) >= defaultItemThreshold) === (entry.item.gold.label === "violates")).length / scored.length
const flagged = (scored: ReadonlyArray<Scored>) => scored.filter((entry) => (entry.score ?? 0) > itemReviewFloor).length / scored.length
const fixed = (value: number) => (Number.isNaN(value) ? "–" : value.toFixed(3))
const percent = (value: number) => `${(value * 100).toFixed(0)}%`
const baseline = results[0]!
const delta = (scored: ReadonlyArray<Scored>, metric: (cases: ReadonlyArray<Scored>) => number) => {
  if (scored === baseline.run.scored) return ""
  const [low, high] = pairedInterval(baseline.run.scored, scored, metric)
  return ` [${low >= 0 ? "+" : ""}${low.toFixed(3)}, ${high >= 0 ? "+" : ""}${high.toFixed(3)}]`
}
const violating = todos.filter((todo) => todo.age > 90 && !todo.issue).length
const nearCount = todos.filter((todo) => Math.abs(todo.age - 90) <= 5).length
console.log(`\nhistory: ${todos.length} TODOs in ${files.length} files (${violating} violating; ${nearCount} within 5 days of the threshold). ` +
  `Intervals: 95% paired bootstrap vs ${baseline.arm}, resampling files.\n`)
console.log("| Evidence | AUROC | Brier | Accuracy at 0.65 | Near threshold (±5 days) accuracy | Issue-less TODOs ≤ 90 days old flagged | Caught / false alarms | $ / 1k items |")
console.log("|---|---|---|---|---|---|---|---|")
for (const { arm, run, items } of results) {
  const q = quality(run.scored, { floor: itemReviewFloor, threshold: defaultItemThreshold })
  const tokens = [...run.inputTokens.values()].reduce((sum, value) => sum + value, 0)
  console.log(`| ${arm} | ${fixed(auroc(run.scored))}${delta(run.scored, auroc)} | ${fixed(brier(run.scored))}${delta(run.scored, brier)} | ` +
    `${percent(accuracy(run.scored))}${delta(run.scored, accuracy)} | ${percent(accuracy(near(run.scored)))} | ` +
    `${percent(flagged(youngWithoutIssue(run.scored)))} | ${percent(q.caught)} / ${percent(q.falseAlarms)} | ` +
    `$${costPerThousand(tokens, items.length).toFixed(3)} |`)
}
