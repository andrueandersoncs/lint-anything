import { Effect, Result } from "effect"
import { Clef } from "./clef.ts"
import { itemStep, SelectorError } from "./select.ts"

const fieldName = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * `lint-anything ask --field NAME "QUESTION"`: reads items (JSONL) on stdin and writes them back with a
 * `NAME` field holding the probability, to four decimals, that the answer to the yes/no question is yes for
 * each item (empty when the item is too large to send). A later step can filter on it, for example
 * `jq -c 'select((.NAME | tonumber) < 0.5) | del(.NAME)'`.
 */
export const ask = (question: string, field: string) =>
  !fieldName.test(field) || ["id", "text", "path", "lines"].includes(field)
    ? Effect.fail(new SelectorError({ message: `ask: --field ${field} must match [A-Za-z_][A-Za-z0-9_]* and not be id, text, path, or lines` }))
    : itemStep("ask", (items) =>
      Effect.gen(function*() {
        const answers = yield* (yield* Clef).ask(question, items)
        return items.map((item, index) => {
          const answer = answers[index]!
          const value = Result.isSuccess(answer) ? answer.success.toFixed(4) : ""
          return { ...item, evidence: [...item.evidence.filter(([name]) => name !== field), [field, value] as const] }
        })
      }))
