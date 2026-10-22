import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { Config, Context, Effect, flow, Layer, Ref, Result, Runtime, Schedule, Schema } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http"
import type { Item } from "./item.ts"
import type { Policy } from "./policy.ts"

export type Model = "clef" | "clef-flash"

/** Probability that a selector item violates a policy. */
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

const Noul = Schema.Struct({
  noul: Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 }))
})

// Workers AI wraps every model response in `result`.
const ClefResponse = Schema.Struct({
  result: Schema.Struct({
    answers: Schema.Record(Schema.String, Noul)
  })
})

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

// Nothing is added to what the policy says: the request's text is the policy body, each question is an
// item's text, and the policy's criteria (if any) say what yes and no mean. Packing a policy's items as
// questions of one request won the eval suite's sweep (README, Evals); one request per item cost 2.5×.
const itemState = (policy: Policy) => policy.body
const itemQuestion = (policy: Policy, item: Item) =>
  ({ type: "noul", instructions: item.text, ...(policy.criteria === undefined ? {} : { criteria: policy.criteria }) })

/**
 * Plans the requests that judge a selector's `items` against `policy`: the policy body once per request and
 * one question per item. Questions answer items by index into `items`.
 */
export const planItemRequests = (model: Model, policy: Policy, items: ReadonlyArray<Item>) =>
  pack(model, itemState(policy), items.map((_, index) => index), (index, taken) => serialize(`i${taken.size}`, itemQuestion(policy, items[index]!)))

/**
 * Answers kept on disk, one file per question, keyed by the model, the request text, and the question
 * (not its id or the other questions in the request), so unchanged questions aren't sent again.
 */
const answerCache = (model: Model, directory: string) => {
  const path = (state: string, question: object) => {
    const key = new Bun.CryptoHasher("sha256").update(`${model}\0${state}\0${JSON.stringify(question)}`).digest("hex")
    return join(directory, key.slice(0, 2), key)
  }
  return {
    get: (state: string, question: object): number | undefined => {
      const file = path(state, question)
      return existsSync(file) ? Number(readFileSync(file, "utf8")) : undefined
    },
    set: (state: string, question: object, noul: number) => {
      const file = path(state, question)
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, String(noul))
    }
  }
}

export class Clef extends Context.Service<Clef, {
  /** Judges each of a selector's `items` against `policy`; results follow `items` order. */
  judgeItems(
    policy: Policy,
    items: ReadonlyArray<Item>
  ): Effect.Effect<ReadonlyArray<Result.Result<Judgment, RequestTooLarge>>, ClefError>
  /** Requests sent and answers taken from the cache so far. */
  readonly stats: Effect.Effect<{ readonly requests: number; readonly cached: number }>
}>()("lint-anything/Clef") {
  /** Clef on Workers AI; with `cacheDirectory`, answers are cached there per question across runs. */
  static readonly layer = (model: Model, cacheDirectory?: string) =>
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

        const cache = cacheDirectory === undefined ? undefined : answerCache(model, cacheDirectory)
        const counts = yield* Ref.make({ requests: 0, cached: 0 })

        /** Sends one planned request and returns each question's answer, keyed like `request.questions`. */
        const send = Effect.fn("Clef.send")(function*<A>(request: Planned<A>) {
          yield* Ref.update(counts, (count) => ({ ...count, requests: count.requests + 1 }))
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

        /**
         * Answers each value's question: from the cache when it has one, otherwise by sending the misses,
         * planned by `plan`, and caching their answers. Returns answers and values too large to send.
         */
        const answer = Effect.fn("Clef.answer")(function*<A>(
          state: string,
          values: ReadonlyArray<A>,
          question: (value: A) => object,
          plan: (misses: ReadonlyArray<A>) => { readonly requests: ReadonlyArray<Planned<A>>; readonly oversized: ReadonlyArray<{ readonly value: A; readonly bytes: number }> },
          concurrency: number
        ) {
          const answers: Array<{ readonly value: A; readonly noul: number }> = []
          const misses: Array<A> = []
          for (const value of values) {
            const noul = cache?.get(state, question(value))
            if (noul === undefined) misses.push(value)
            else answers.push({ value, noul })
          }
          if (answers.length > 0) yield* Ref.update(counts, (count) => ({ ...count, cached: count.cached + answers.length }))
          const { requests, oversized } = plan(misses)
          for (const sent of (yield* Effect.forEach(requests, send, { concurrency })).flat()) {
            cache?.set(state, question(sent.value), sent.noul)
            answers.push(sent)
          }
          return { answers, oversized }
        })

        const judgeItems = Effect.fn("Clef.judgeItems")(function*(policy: Policy, items: ReadonlyArray<Item>) {
          const { answers, oversized } = yield* answer(
            itemState(policy),
            items.map((_, index) => index),
            (index) => itemQuestion(policy, items[index]!),
            (misses) => {
              const planned = planItemRequests(model, policy, misses.map((index) => items[index]!))
              return {
                requests: planned.requests.map(({ body, questions }) => ({ body, questions: questions.map(({ id, value }) => ({ id, value: misses[value]! })) })),
                oversized: planned.oversized.map(({ value, bytes }) => ({ value: misses[value]!, bytes }))
              }
            },
            8
          )
          const results: Array<Result.Result<Judgment, RequestTooLarge>> = []
          for (const { value: index, bytes } of oversized) results[index] = Result.fail(new RequestTooLarge({ bytes }))
          for (const { value: index, noul } of answers) results[index] = Result.succeed({ violates: noul })
          return results
        })

        return Clef.of({ judgeItems, stats: Ref.get(counts) })
      })
    ).pipe(Layer.provide(FetchHttpClient.layer))
}
