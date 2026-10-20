// Eval selector step: `bun "$EVAL_STEPS/blame.ts" YYYY-MM-DD` adds a `changed` evidence field to each item
// with a `path` and `lines` that git has history for: the newest commit date among the item's lines and how
// many days before the given date (JSONL in, JSONL out).
import { Effect } from "effect"
import { runStep } from "./step.ts"

const day = 86_400_000
const isoDate = (epochMs: number) => new Date(epochMs).toISOString().slice(0, 10)
const today = Bun.argv[2] ?? ""
if (Number.isNaN(Date.parse(today))) {
  console.error(`blame: pass the date ages are counted to, YYYY-MM-DD (got ${JSON.stringify(today)})`)
  process.exit(2)
}

const lastChanged = (path: string, [start, end]: readonly [number, number]) =>
  Effect.promise(() => Bun.$`git blame --porcelain -L ${start},${end} -- ${path}`.quiet().nothrow()).pipe(
    Effect.map((result) => {
      const porcelain = result.stdout.toString()
      // Uncommitted lines blame to the all-zero commit; they have no history yet.
      if (result.exitCode !== 0 || /^0{40} /m.test(porcelain)) return undefined
      const times = [...porcelain.matchAll(/^committer-time (\d+)$/gm)].map((match) => Number(match[1]) * 1000)
      if (times.length === 0) return undefined
      const newest = isoDate(Math.max(...times))
      return `${newest}, ${Math.round((Date.parse(today) - Date.parse(newest)) / day)} days before ${today}`
    })
  )

await runStep("blame", (items) =>
  Effect.forEach(items, (item) =>
    item.path === undefined || item.lines === undefined
      ? Effect.succeed(item)
      : lastChanged(item.path, item.lines).pipe(
        Effect.map((changed) => (changed === undefined ? item : { ...item, evidence: [...item.evidence, ["changed", changed] as const] }))
      ), { concurrency: 8 }))
