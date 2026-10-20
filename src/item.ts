import { Effect, Schema } from "effect"

const Located = Schema.Struct({
  id: Schema.NonEmptyString,
  text: Schema.NonEmptyString,
  path: Schema.optional(Schema.NonEmptyString),
  lines: Schema.optional(Schema.Tuple([Schema.Int, Schema.Int]).check(
    Schema.makeFilter(([start, end]) => (1 <= start && start <= end) || "lines must be [start, end] with 1 <= start <= end")
  ))
})
const located = new Set(Object.keys(Located.fields))

/**
 * One thing to judge against a rule: an item a policy's selector picked out, or one of a policy's
 * examples. `id` names it in findings; `path` and `lines` (1-based, inclusive) locate it. Every other
 * field is evidence: a named string the judge reads alongside the item, in the order it was written.
 */
export interface Item extends Schema.Schema.Type<typeof Located> {
  readonly evidence: ReadonlyArray<readonly [name: string, value: string]>
}

/** Reads an item from a parsed JSON value; fails with a message saying what is wrong with it. */
export const toItem = Effect.fn("toItem")(function*(value: unknown) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return yield* Effect.fail("not an object")
  const fields = yield* Schema.decodeUnknownEffect(Located)(value).pipe(Effect.mapError((error) => error.message))
  const evidence: Array<readonly [string, string]> = []
  for (const [name, field] of Object.entries(value)) {
    if (located.has(name)) continue
    if (typeof field !== "string") return yield* Effect.fail(`evidence field ${name} must be a string`)
    evidence.push([name, field])
  }
  return { ...fields, evidence } satisfies Item
})

/** Parses one JSONL line into an item. */
export const parseItem = (line: string) =>
  Effect.try({ try: (): unknown => JSON.parse(line), catch: () => "not valid JSON" }).pipe(Effect.flatMap(toItem))

/** The item as one JSONL line, evidence fields after the located ones. */
export const formatItem = ({ evidence, ...located }: Item) =>
  JSON.stringify({ ...located, ...Object.fromEntries(evidence) })
