import { Effect, Schema, SchemaIssue } from "effect"

const ItemFields = Schema.Struct({
  id: Schema.NonEmptyString,
  text: Schema.NonEmptyString,
  path: Schema.optional(Schema.NonEmptyString),
  lines: Schema.optional(Schema.Tuple([Schema.Int, Schema.Int]).check(
    Schema.makeFilter(([start, end]) => (1 <= start && start <= end) || "lines must be [start, end] with 1 <= start <= end")
  ))
})

/**
 * One thing a selector picked out to judge. `text` is everything Clef reads for it, context included; `id`
 * names it in findings; `path` and `lines` (1-based, inclusive) say where findings point.
 */
export type Item = Schema.Schema.Type<typeof ItemFields>

const formatIssues = SchemaIssue.makeFormatterStandardSchemaV1()

/** Parses one JSONL line into an item; fails with a message saying what is wrong with it. */
export const parseItem = Effect.fn("parseItem")(function*(line: string) {
  const value = yield* Effect.try({ try: (): unknown => JSON.parse(line), catch: () => "not valid JSON" })
  if (typeof value !== "object" || value === null || Array.isArray(value)) return yield* Effect.fail("not an object")
  const unknown = Object.keys(value).filter((key) => !(key in ItemFields.fields))
  if (unknown.length > 0) {
    return yield* Effect.fail(`unknown field ${unknown.join(", ")}; put what Clef should read in text`)
  }
  return yield* Schema.decodeUnknownEffect(ItemFields)(value).pipe(
    Effect.mapError((error) =>
      formatIssues(error.issue).issues.map(({ path, message }) => `${path?.length ? `${path.join(".")}: ` : ""}${message}`).join("; ")
    )
  )
})
