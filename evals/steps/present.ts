// Eval selector step, the last in a pipeline: `bun "$EVAL_STEPS/present.ts"` writes each item's location and
// context fields into its text, so the item is exactly what Clef reads:
//
//   location: <path or id> (lines <start>-<end>)
//
//   <field>:
//   <value>            (each non-empty context field, in order)
//
//   item:
//   <text>
//
// This is the layout the CLI rendered items in before items became text only.
import { Effect } from "effect"
import { runStep } from "./step.ts"

await runStep("present", (items) =>
  Effect.succeed(items.map((item) => ({
    id: item.id,
    ...(item.path === undefined ? {} : { path: item.path }),
    ...(item.lines === undefined ? {} : { lines: item.lines }),
    text: [
      `location: ${item.path ?? item.id}${item.lines === undefined ? "" : ` (lines ${item.lines[0]}-${item.lines[1]})`}`,
      ...item.evidence.flatMap(([name, value]) => (value === "" ? [] : [`${name}:\n${value}`])),
      `item:\n${item.text}`
    ].join("\n\n"),
    evidence: []
  }))))
