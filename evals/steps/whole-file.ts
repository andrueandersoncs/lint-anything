// Eval selector: each file whose path it reads on stdin becomes one item holding the whole file. For rules
// about a file as a whole. Empty files emit nothing.
import { inputPaths } from "./step.ts"

export const run = async (args: ReadonlyArray<string>) => {
  const items: Array<string> = []
  for (const path of await inputPaths("whole-file", args)) {
    const text = await Bun.file(path).text()
    if (text.trim() === "") continue
    const lines = text.endsWith("\n") ? text.split("\n").length - 1 : text.split("\n").length
    items.push(JSON.stringify({ id: path, path, lines: [1, Math.max(1, lines)], text }))
  }
  if (items.length > 0) await new Promise<void>((resolve) => process.stdout.write(`${items.join("\n")}\n`, () => resolve()))
}

if (import.meta.main) await run(Bun.argv.slice(2))
