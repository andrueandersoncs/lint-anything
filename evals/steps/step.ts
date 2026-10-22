// Runs an eval selector step as a script: reads items (JSONL) on stdin, transforms them, writes them back
// (JSONL) to stdout. Eval selectors call these steps as `bun "$EVAL_STEPS/<step>.ts"`; evals/selected.ts
// sets EVAL_STEPS. These are eval helpers, not part of the CLI.
//
// Inside a selector pipeline an item may carry context fields beyond id, text, path, and lines; the CLI
// accepts only those four, so a pipeline ends with `present.ts`, which writes the context into the text.
import { Effect } from "effect"

export interface StepItem {
  readonly id: string
  readonly text: string
  readonly path?: string
  readonly lines?: readonly [number, number]
  /** Context fields in the order they were added. */
  readonly evidence: ReadonlyArray<readonly [name: string, value: string]>
}

const located = new Set(["id", "text", "path", "lines"])

const parseStepItem = (line: string): StepItem | string => {
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    return "not valid JSON"
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return "not an object"
  const record = value as Record<string, unknown>
  if (typeof record.id !== "string" || record.id === "") return "id must be a non-empty string"
  if (typeof record.text !== "string" || record.text === "") return "text must be a non-empty string"
  if (record.path !== undefined && typeof record.path !== "string") return "path must be a string"
  const lines = record.lines
  if (lines !== undefined && !(Array.isArray(lines) && lines.length === 2 && lines.every(Number.isInteger))) return "lines must be [start, end]"
  const evidence: Array<readonly [string, string]> = []
  for (const [name, field] of Object.entries(record)) {
    if (located.has(name)) continue
    if (typeof field !== "string") return `context field ${name} must be a string`
    evidence.push([name, field])
  }
  return {
    id: record.id,
    text: record.text,
    ...(typeof record.path === "string" ? { path: record.path } : {}),
    ...(lines === undefined ? {} : { lines: lines as [number, number] }),
    evidence
  }
}

export const formatStepItem = ({ evidence, ...item }: StepItem) => JSON.stringify({ ...item, ...Object.fromEntries(evidence) })

export const runStep = async (name: string, step: (items: ReadonlyArray<StepItem>) => Effect.Effect<ReadonlyArray<StepItem>, Error>) => {
  const items: Array<StepItem> = []
  for (const [index, line] of (await Bun.stdin.text()).split("\n").entries()) {
    if (line.trim() === "") continue
    const parsed = parseStepItem(line)
    if (typeof parsed === "string") {
      console.error(`${name}: input line ${index + 1} is not a valid item: ${parsed}`)
      process.exit(2)
    }
    items.push(parsed)
  }
  const result = await Effect.runPromise(Effect.result(step(items)))
  if (result._tag === "Failure") {
    console.error(`${name}: ${result.failure.message}`)
    process.exit(2)
  }
  if (result.success.length === 0) return
  // Bun.write(Bun.stdout, …) garbles large output on a pipe; process.stdout.write does not.
  const text = `${result.success.map(formatStepItem).join("\n")}\n`
  await new Promise<void>((resolve) => process.stdout.write(text, () => resolve()))
}
