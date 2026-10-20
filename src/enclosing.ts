import { Effect } from "effect"
import { formatItem, type Item, parseItem, SelectorError } from "./select.ts"

const indent = (line: string) => line.length - line.trimStart().length
const numbered = (lines: ReadonlyArray<string>, from: number, to: number) =>
  lines.slice(from - 1, to).map((line, index) => `${from + index}: ${line}`).join("\n")
// A line that opens a block: a function, method, class, or arrow body, or a Python `…:` header.
const opensBlock = /\b(function|def|func|class)\b|=>\s*\{?\s*$|\)\s*(:\s*[^=]+)?\{\s*$|:\s*$/
const maxLines = 80

/**
 * The block that encloses lines `start`-`end` of `lines`: the nearest less-indented line above that opens
 * a block, down to where that block closes, numbered and capped at 80 lines around the item. With no
 * enclosing block, the 15 lines after the item.
 */
export const enclosingBlock = (lines: ReadonlyArray<string>, [start, end]: readonly [number, number]) => {
  const own = indent(lines[start - 1] ?? "")
  for (let at = start - 1; at >= 1; at--) {
    const line = lines[at - 1]!
    if (line.trim() === "" || indent(line) >= own || !opensBlock.test(line)) continue
    let close = end
    for (let next = end + 1; next <= lines.length; next++) {
      const candidate = lines[next - 1]!
      if (candidate.trim() === "") continue
      if (indent(candidate) <= indent(line)) {
        close = /^\s*[}\])]/.test(candidate) ? next : next - 1
        break
      }
      close = next
    }
    const from = Math.max(at, Math.min(start - 30, close - maxLines + 1))
    const to = Math.min(close, from + maxLines - 1)
    return `lines ${from}-${to}:\n${numbered(lines, from, to)}`
  }
  const to = Math.min(lines.length, end + 15)
  return `no enclosing block; lines ${end + 1}-${to} follow:\n${numbered(lines, end + 1, to)}`
}

/**
 * `lint-anything enclosing`: reads items (JSONL) on stdin and writes them back with an `enclosing`
 * evidence field for each item that has a `path` and `lines`. Paths are read from the current directory.
 */
export const enclosing = Effect.fn("enclosing")(function*() {
  const input = yield* Effect.promise(() => Bun.stdin.text())
  const files = new Map<string, ReadonlyArray<string>>()
  const output: Array<string> = []
  for (const [index, line] of input.split("\n").entries()) {
    if (line.trim() === "") continue
    const item: Item = yield* parseItem(line).pipe(
      Effect.mapError((reason) => new SelectorError({ message: `enclosing: input line ${index + 1} is not a valid item: ${reason}` }))
    )
    if (item.path === undefined || item.lines === undefined) {
      output.push(formatItem(item))
      continue
    }
    const path = item.path
    if (!files.has(path)) {
      const source = yield* Effect.tryPromise({
        try: () => Bun.file(path).text(),
        catch: () => new SelectorError({ message: `enclosing: cannot read ${path}` })
      })
      files.set(path, source.split("\n"))
    }
    output.push(formatItem({ ...item, evidence: [...item.evidence, ["enclosing", enclosingBlock(files.get(path)!, item.lines)]] }))
  }
  if (output.length > 0) yield* Effect.promise(() => Bun.write(Bun.stdout, `${output.join("\n")}\n`))
})
