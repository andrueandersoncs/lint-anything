import { Config, Context, Effect, flow, Layer, Result, Runtime, Schedule, Schema } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http"
import type { Policy } from "./policy.ts"
import type { Item } from "./select.ts"
import type { SourceFile } from "./source.ts"

export type Model = "clef" | "clef-flash"

/** Probability that a file or selector item violates a policy. */
export interface Judgment {
  readonly violates: number
}

export class ClefError extends Schema.TaggedError<ClefError>()("ClefError", {
  cause: Schema.Defect()
}) {
  override readonly [Runtime.errorExitCode] = 2
}

/** The request would exceed Clef's context window, which silently truncates state. */
export class RequestTooLarge extends Schema.TaggedError<RequestTooLarge>()("RequestTooLarge", {
  bytes: Schema.Number
}) {}

// Context windows are 65,536 tokens (clef) and 24,576 (clef-flash). A token is at least one byte, so a
// body within these limits is never truncated.
export const maxRequestBytes: Readonly<Record<Model, number>> = { clef: 64_000, "clef-flash": 24_000 }

// Clef takes at most 64 questions per request.
const maxQuestions = 64

// The request shape below won the eval suite's sweeps (evals/, see README): each file is judged as
// excerpts of at most `excerptBytes`, each excerpt sent once with short guidance and one yes/no question
// per policy (with explicit criteria); a policy's score is its highest across the excerpts.
const guidance =
  "Decide whether `file`, read in light of `path`, contains at least one violation of the rule in each question.\n" +
  "Return a calibrated probability that the answer is yes."

/** Largest excerpt Clef judges at once. Semantic violations are local, and long files dilute them. */
export const excerptBytes = 4000

/**
 * Cuts a file into consecutive excerpts of at most `maxBytes`, preferring cuts before top-level
 * declarations, then before any line that follows a blank line. Each excerpt's path names the lines it
 * holds. A file within `maxBytes` is returned whole.
 */
export const excerpts = (file: SourceFile, maxBytes: number): ReadonlyArray<SourceFile> => {
  if (Buffer.byteLength(file.source) <= maxBytes) return [file]
  const lines = file.source.split("\n")
  const afterBlank = (index: number) => index > 0 && lines[index - 1]!.trim() === "" && lines[index]!.trim() !== ""
  const topLevel = (index: number) => afterBlank(index) && !/^[\s})\]]/.test(lines[index]!)
  const result: Array<SourceFile> = []
  for (let start = 0; start < lines.length;) {
    let end = start
    let bytes = 0
    while (end < lines.length && bytes + Buffer.byteLength(lines[end]!) + 1 <= maxBytes) {
      bytes += Buffer.byteLength(lines[end]!) + 1
      end++
    }
    if (end < lines.length) {
      const cutAt = (test: (index: number) => boolean) => {
        for (let index = end; index > start; index--) if (test(index)) return index
        return -1
      }
      const cut = [cutAt(topLevel), cutAt(afterBlank)].find((index) => index > start)
      end = cut ?? Math.max(end, start + 1)
    }
    result.push({ path: `${file.path} (lines ${start + 1}-${end} of ${lines.length})`, source: lines.slice(start, end).join("\n") })
    start = end
  }
  return result
}

const criteria = {
  true: "The file contains at least one complete violation of the rule.",
  false: "The file follows the rule, or the rule governs nothing in it."
}

const Noul = Schema.Struct({
  noul: Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 }))
})

// Workers AI wraps every model response in `result`.
const ClefResponse = Schema.Struct({
  result: Schema.Struct({
    answers: Schema.Record(Schema.String, Noul)
  })
})

/**
 * The question id for a policy: its name with characters Clef rejects replaced by `.`, capped at 100
 * characters, and suffixed `.2`, `.3`, … when another question in the request already has it.
 */
const questionId = (policy: Policy, taken: ReadonlySet<string>) => {
  const base = policy.name.replace(/[^A-Za-z0-9_.-]/g, ".")
  for (let n = 1;; n++) {
    const suffix = n === 1 ? "" : `.${n}`
    const id = base.slice(0, 100 - suffix.length) + suffix
    if (!taken.has(id)) return id
  }
}

const serialize = (id: string, question: object) => {
  const text = `${JSON.stringify(id)}:${JSON.stringify(question)}`
  return { id, text, bytes: Buffer.byteLength(text) }
}

/** One Clef request: its exact body and what each question id answers. */
export interface Planned<A> {
  readonly body: string
  readonly questions: ReadonlyArray<{ readonly id: string; readonly value: A }>
}

/**
 * Packs one question per value, in order, into as few requests sharing `state` as Clef's 64-question
 * limit and the model's byte limit allow. `entry` serializes a value's question given the ids already in
 * its request. A value too large to send even alone is returned in `oversized`.
 */
const pack = <A>(
  model: Model,
  state: string,
  values: ReadonlyArray<A>,
  entry: (value: A, taken: ReadonlySet<string>) => ReturnType<typeof serialize>
) => {
  // The body is assembled from serialized parts so each request's exact size is known while packing.
  const head = `${JSON.stringify({ model, state }).slice(0, -1)},"questions":{`
  const tail = "}}"
  const fixedBytes = Buffer.byteLength(head) + tail.length
  const limit = maxRequestBytes[model]
  const requests: Array<Planned<A>> = []
  const oversized: Array<{ readonly value: A; readonly bytes: number }> = []
  let entries: Array<string> = []
  let questions: Array<{ readonly id: string; readonly value: A }> = []
  let taken = new Set<string>()
  let bytes = fixedBytes
  const flush = () => {
    if (questions.length > 0) requests.push({ body: `${head}${entries.join(",")}${tail}`, questions })
    entries = []
    questions = []
    taken = new Set()
    bytes = fixedBytes
  }
  for (const value of values) {
    const alone = entry(value, new Set())
    if (fixedBytes + alone.bytes > limit) {
      oversized.push({ value, bytes: fixedBytes + alone.bytes })
      continue
    }
    let next = entry(value, taken)
    if (questions.length === maxQuestions || bytes + ",".length + next.bytes > limit) {
      flush()
      next = alone
    }
    bytes += (questions.length === 0 ? 0 : ",".length) + next.bytes
    entries.push(next.text)
    questions.push({ id: next.id, value })
    taken.add(next.id)
  }
  flush()
  return { requests, oversized }
}

/**
 * Plans the requests that judge one excerpt (or whole file) against `policies`: the text once per
 * request and one question per policy.
 */
export const planRequests = (model: Model, file: SourceFile, policies: ReadonlyArray<Policy>) =>
  pack(
    model,
    `${guidance}\n\npath: ${file.path}\n\nfile:\n${file.source}`,
    policies,
    (policy, taken) => serialize(questionId(policy, taken), { type: "noul", instructions: `Rule:\n${policy.source}`, criteria })
  )

// Selector items: the eval suite's item sweep (evals/items.ts, see README) chose this shape. The rule goes
// in the state once and each item is one question; one request per item scored worse and cost 2.5×.
const itemGuidance = "Each question shows one item with its location and any context. Decide whether that item " +
  "contains at least one violation of the rule below.\nReturn a calibrated probability that the answer is yes."

export const itemCriteria = {
  true: "The item contains at least one complete violation of the rule.",
  false: "The item follows the rule, or the rule governs nothing in it."
}

/** An item as the judge reads it: where it is, any context, then the item itself. */
export const renderItem = (item: Item) =>
  [
    `location: ${item.path ?? item.id}${item.lines === undefined ? "" : ` (lines ${item.lines[0]}-${item.lines[1]})`}`,
    ...(item.context === undefined || item.context === "" ? [] : [`context:\n${item.context}`]),
    `item:\n${item.text}`
  ].join("\n\n")

/**
 * Plans the requests that judge a selector's `items` against `policy`: the rule once per request and one
 * question per item. Questions answer items by index into `items`.
 */
export const planItemRequests = (model: Model, policy: Policy, items: ReadonlyArray<Item>) =>
  pack(
    model,
    `${itemGuidance}\n\nRule:\n${policy.source}`,
    items.map((_, index) => index),
    (index, taken) => serialize(`i${taken.size}`, { type: "noul", instructions: renderItem(items[index]!), criteria: itemCriteria })
  )

export class Clef extends Context.Service<Clef, {
  /** Judges `file` against every policy, excerpt by excerpt; results follow `policies` order. */
  judge(
    file: SourceFile,
    policies: ReadonlyArray<Policy>
  ): Effect.Effect<ReadonlyArray<Result.Result<Judgment, RequestTooLarge>>, ClefError>
  /** Judges each of a selector's `items` against `policy`; results follow `items` order. */
  judgeItems(
    policy: Policy,
    items: ReadonlyArray<Item>
  ): Effect.Effect<ReadonlyArray<Result.Result<Judgment, RequestTooLarge>>, ClefError>
}>()("lint-anything/Clef") {
  static readonly layer = (model: Model) =>
    Layer.effect(
      Clef,
      Effect.gen(function*() {
        const { accountId, token, baseUrl } = yield* Config.all({
          accountId: Config.String("CLOUDFLARE_ACCOUNT_ID"),
          token: Config.Redacted("CLOUDFLARE_AUTH_TOKEN"),
          baseUrl: Config.String("CLOUDFLARE_API_BASE_URL").pipe(
            Config.withDefault("https://api.cloudflare.com/client/v4")
          )
        }).pipe(Effect.mapError((cause) => new ClefError({ cause })))
        const client = (yield* HttpClient.HttpClient).pipe(
          HttpClient.mapRequest(flow(
            HttpClientRequest.prependUrl(`${baseUrl}/accounts/${accountId}/ai/run/@cf/cloudflare`),
            HttpClientRequest.bearerToken(token),
            HttpClientRequest.acceptJson
          )),
          HttpClient.filterStatusOk,
          HttpClient.retryTransient({ schedule: Schedule.exponential(500), times: 3 })
        )

        /** Sends one planned request and returns each question's answer, keyed like `request.questions`. */
        const send = Effect.fn("Clef.send")(function*<A>(request: Planned<A>) {
          const { result } = yield* HttpClientRequest.post(`/${model}`).pipe(
            HttpClientRequest.bodyText(request.body, "application/json"),
            client.execute,
            Effect.flatMap(HttpClientResponse.schemaBodyJson(ClefResponse)),
            Effect.mapError((cause) => new ClefError({ cause }))
          )
          const answers: Array<{ readonly value: A; readonly noul: number }> = []
          for (const { id, value } of request.questions) {
            const answer = result.answers[id]
            if (answer === undefined) {
              return yield* new ClefError({ cause: new Error(`Clef returned no answer for ${id}`) })
            }
            answers.push({ value, noul: answer.noul })
          }
          return answers
        })

        const judge = Effect.fn("Clef.judge")(function*(file: SourceFile, policies: ReadonlyArray<Policy>) {
          // Each policy keeps its highest score across excerpts; it is too large only if no excerpt could send it.
          const scores = new Map<Policy, number>()
          const tooLarge = new Map<Policy, number>()
          for (const excerpt of excerpts(file, excerptBytes)) {
            const { requests, oversized } = planRequests(model, excerpt, policies)
            for (const { value: policy, bytes } of oversized) tooLarge.set(policy, Math.max(bytes, tooLarge.get(policy) ?? 0))
            for (const request of requests) {
              for (const { value: policy, noul } of yield* send(request)) {
                scores.set(policy, Math.max(noul, scores.get(policy) ?? 0))
              }
            }
          }
          const results: Array<Result.Result<Judgment, RequestTooLarge>> = []
          for (const policy of policies) {
            const violates = scores.get(policy)
            const bytes = tooLarge.get(policy)
            if (violates !== undefined) results.push(Result.succeed({ violates }))
            else if (bytes !== undefined) results.push(Result.fail(new RequestTooLarge({ bytes })))
            // planRequests places every policy in a request or in `oversized` for every excerpt.
            else return yield* Effect.die(new Error(`no judgment for ${policy.name}`))
          }
          return results
        })

        const judgeItems = Effect.fn("Clef.judgeItems")(function*(policy: Policy, items: ReadonlyArray<Item>) {
          const { requests, oversized } = planItemRequests(model, policy, items)
          const results: Array<Result.Result<Judgment, RequestTooLarge>> = []
          for (const { value: index, bytes } of oversized) results[index] = Result.fail(new RequestTooLarge({ bytes }))
          const answered = yield* Effect.forEach(requests, send, { concurrency: 8 })
          for (const { value: index, noul } of answered.flat()) results[index] = Result.succeed({ violates: noul })
          return results
        })

        return Clef.of({ judge, judgeItems })
      })
    ).pipe(Layer.provide(FetchHttpClient.layer))
}
