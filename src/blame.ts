import { Effect } from "effect"
import { itemStep, SelectorError } from "./select.ts"

const day = 86_400_000
const isoDate = (epochMs: number) => new Date(epochMs).toISOString().slice(0, 10)

/** Today's UTC date, `YYYY-MM-DD`. */
export const currentDate = () => isoDate(Date.now())

/**
 * When an item's lines were last changed: the newest commit date among them in `git blame`, and how many
 * days before `today` that was. Undefined when git has no committed history for the lines.
 */
const lastChanged = (path: string, [start, end]: readonly [number, number], today: string) =>
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

/**
 * `lint-anything blame [--today YYYY-MM-DD]`: reads items (JSONL) on stdin and writes them back with a
 * `changed` evidence field for each item with a `path` and `lines` that git has history for: the newest
 * commit date among the item's lines and how many days before `today` (default: the current UTC date).
 */
export const blame = (today: string) =>
  Number.isNaN(Date.parse(today))
    ? Effect.fail(new SelectorError({ message: `blame: --today ${today} is not a date` }))
    : itemStep("blame", (item) =>
      item.path === undefined || item.lines === undefined
        ? Effect.succeed(item)
        : lastChanged(item.path, item.lines, today).pipe(
          Effect.map((changed) => (changed === undefined ? item : { ...item, evidence: [...item.evidence, ["changed", changed] as const] }))
        ))
