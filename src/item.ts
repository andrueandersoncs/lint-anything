import { Effect, Schema, SchemaIssue } from "effect"
import { maxMediaFiles, mediaExtensions, mediaKinds, mediaNoun, mediaTypeOf } from "./media.ts"

const ItemFields = Schema.Struct({
  id: Schema.NonEmptyString,
  text: Schema.NonEmptyString,
  path: Schema.optional(Schema.NonEmptyString),
  lines: Schema.optional(Schema.Tuple([Schema.Int, Schema.Int]).check(
    Schema.makeFilter(([start, end]) => (1 <= start && start <= end) || "lines must be [start, end] with 1 <= start <= end")
  )),
  media: Schema.optional(Schema.Array(Schema.NonEmptyString))
})

/**
 * One thing a selector picked out to judge. `text` is everything the decision model reads for it, context included; `id`
 * names it in findings; `path` and `lines` (1-based, inclusive) say where findings point. `media` lists the image, audio,
 * and video files the model is shown with it, by path from where the selector ran.
 */
export type Item = Schema.Schema.Type<typeof ItemFields>

const formatIssues = SchemaIssue.makeFormatterStandardSchemaV1()

/** Why `media` can't be shown to a model: a file without a media type, or more files of a kind than an item may show. */
const mediaProblem = (media: ReadonlyArray<string>) => {
  const untyped = media.find((file) => mediaTypeOf(file) === undefined)
  if (untyped !== undefined) return `media ${untyped} is not a file type decision models take (${mediaExtensions.join(", ")})`
  for (const kind of mediaKinds) {
    const count = media.filter((file) => mediaTypeOf(file)!.kind === kind).length
    if (count > maxMediaFiles[kind]) {
      return `media lists ${count} ${mediaNoun[kind]}; an item shows the model at most ${maxMediaFiles[kind]}`
    }
  }
  return undefined
}

/** Parses one JSONL line into an item; fails with a message saying what is wrong with it. */
export const parseItem = Effect.fn("parseItem")(function*(line: string) {
  const value = yield* Effect.try({ try: (): unknown => JSON.parse(line), catch: () => "not valid JSON" })
  if (typeof value !== "object" || value === null || Array.isArray(value)) return yield* Effect.fail("not an object")
  const unknown = Object.keys(value).filter((key) => !(key in ItemFields.fields))
  if (unknown.length > 0) {
    return yield* Effect.fail(`unknown field ${unknown.join(", ")}; put what the model should read in text`)
  }
  const item = yield* Schema.decodeUnknownEffect(ItemFields)(value).pipe(
    Effect.mapError((error) =>
      formatIssues(error.issue).issues.map(({ path, message }) => `${path?.length ? `${path.join(".")}: ` : ""}${message}`).join("; ")
    )
  )
  const problem = item.media === undefined ? undefined : mediaProblem(item.media)
  return problem === undefined ? item : yield* Effect.fail(problem)
})
