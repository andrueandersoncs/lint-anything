// Runs an eval selector step as a script: reads items (JSONL) on stdin, transforms them, writes them back
// (JSONL) to stdout. Eval selectors call these steps as `bun "$EVAL_STEPS/<step>.ts"`; evals/selected.ts
// sets EVAL_STEPS. These are eval helpers, not part of the CLI.
import { Effect } from "effect"
import { formatItem, type Item, parseItem } from "../../src/item.ts"

export const runStep = async (name: string, step: (items: ReadonlyArray<Item>) => Effect.Effect<ReadonlyArray<Item>, Error>) => {
  const items: Array<Item> = []
  for (const [index, line] of (await Bun.stdin.text()).split("\n").entries()) {
    if (line.trim() === "") continue
    const parsed = await Effect.runPromise(Effect.result(parseItem(line)))
    if (parsed._tag === "Failure") {
      console.error(`${name}: input line ${index + 1} is not a valid item: ${parsed.failure}`)
      process.exit(2)
    }
    items.push(parsed.success)
  }
  const result = await Effect.runPromise(Effect.result(step(items)))
  if (result._tag === "Failure") {
    console.error(`${name}: ${result.failure.message}`)
    process.exit(2)
  }
  if (result.success.length === 0) return
  // Bun.write(Bun.stdout, …) garbles large output on a pipe; process.stdout.write does not.
  const text = `${result.success.map(formatItem).join("\n")}\n`
  await new Promise<void>((resolve) => process.stdout.write(text, () => resolve()))
}
