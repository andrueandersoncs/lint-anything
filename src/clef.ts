import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { Cause, Config, Context, Effect, flow, Layer, Ref, Result, Runtime, Schedule, Schema, Semaphore } from "effect"
import { FetchHttpClient, HttpClient, HttpClientError, HttpClientRequest, HttpClientResponse } from "effect/http"
import type { Item } from "./item.ts"
import type { Policy } from "./policy.ts"

/** The Workers AI model lint-anything asks: `@cf/cloudflare/clef`. */
export const model = "clef"

/** Probability that a selector item violates a policy. */
export interface Judgment {
  readonly violates: number
}

export class ClefError extends Schema.TaggedError<ClefError>()("ClefError", {
  message: Schema.String
}) {
  override readonly [Runtime.errorExitCode] = 2
}

/** The request would exceed Clef's context window, which silently truncates state. */
export class RequestTooLarge extends Schema.TaggedError<RequestTooLarge>()("RequestTooLarge", {
  bytes: Schema.Number
}) {}

// Clef's context window is 65,536 tokens. A token is at least one byte, so a body within this limit is
// never truncated.
const maxRequestBytes = 64_000

// Clef takes at most 64 questions per request.
const maxQuestions = 64

/** USD per input token. Clef bills no output tokens. */
export const inputTokenPrice = 0.24e-6

// Requests in flight at once across the whole run, as many as one policy sent before policies ran
// concurrently, so a run puts no more load on Workers AI than it did.
const maxConcurrentRequests = 8

// One attempt, response body included, may take this long before it counts as a transient failure and is
// retried. Of 247,770 eval requests, 9 took over 10 seconds and 1 over 60 (the slowest 80).
const attemptTimeout = "60 seconds"
const attemptRetries = 3

/**
 * How long a cached answer stands. After it, the question is asked again, so answers follow updates to the
 * model, and the expired file is deleted, so the cache doesn't grow without bound.
 */
export const cacheMaxAgeMs = 30 * 24 * 60 * 60 * 1000
// Deleting expired answers walks the whole cache, so a run does it at most once a day.
const pruneIntervalMs = 24 * 60 * 60 * 1000

const Noul = Schema.Struct({
  noul: Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 }))
})

// Workers AI wraps every model response in `result`.
const ClefResponse = Schema.Struct({
  result: Schema.Struct({
    answers: Schema.Record(Schema.String, Noul),
    usage: Schema.optional(Schema.Struct({ input_tokens: Schema.Number }))
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
 * limit and byte limit allow. `entry` serializes a value's question given the ids already in
 * its request. A value too large to send even alone is returned in `oversized`.
 */
const pack = <A>(
  state: string,
  values: ReadonlyArray<A>,
  entry: (value: A, taken: ReadonlySet<string>) => ReturnType<typeof serialize>
) => {
  // The body is assembled from serialized parts so each request's exact size is known while packing.
  const head = `${JSON.stringify({ model, state }).slice(0, -1)},"questions":{`
  const tail = "}}"
  const fixedBytes = Buffer.byteLength(head) + tail.length
  const limit = maxRequestBytes
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
// item's text, and the policy's criteria say what yes and no mean. Packing a policy's items as
// questions of one request won the eval suite's sweep (README, Evals); one request per item cost 2.5×.
const itemState = (policy: Policy) => policy.body
const itemQuestion = (policy: Policy, item: Item) => ({ type: "noul", instructions: item.text, criteria: policy.criteria })

/**
 * Plans the requests that judge a selector's `items` against `policy`: the policy body once per request and
 * one question per item. Questions answer items by index into `items`.
 */
export const planItemRequests = (policy: Policy, items: ReadonlyArray<Item>) =>
  pack(itemState(policy), items.map((_, index) => index), (index, taken) => serialize(`i${taken.size}`, itemQuestion(policy, items[index]!)))

/**
 * Answers kept on disk, one file per question, keyed by the model, the request text, and the question
 * (not its id or the other questions in the request), so unchanged questions aren't sent again. An answer
 * older than `cacheMaxAgeMs` at `now` is a miss.
 */
const answerCache = (directory: string, now: number) => {
  const path = (state: string, question: object) => {
    const key = new Bun.CryptoHasher("sha256").update(`${model}\0${state}\0${JSON.stringify(question)}`).digest("hex")
    return join(directory, key.slice(0, 2), key)
  }
  const fresh = (file: string) => {
    const stats = statSync(file, { throwIfNoEntry: false })
    return stats !== undefined && now - stats.mtimeMs < cacheMaxAgeMs
  }
  return {
    get: (state: string, question: object): number | undefined => {
      const file = path(state, question)
      if (!fresh(file)) return undefined
      // Anything but a number in [0, 1] is a miss, never an answer: `Number("")` is 0, a pass.
      const text = readFileSync(file, "utf8").trim()
      const noul = Number(text)
      return text !== "" && noul >= 0 && noul <= 1 ? noul : undefined
    },
    set: (state: string, question: object, noul: number) => {
      const file = path(state, question)
      mkdirSync(dirname(file), { recursive: true })
      // Written whole beside the answer and renamed over it, so no run ever reads a partly written answer.
      const temporary = `${file}.${process.pid}.tmp`
      writeFileSync(temporary, String(noul))
      renameSync(temporary, file)
    },
    /**
     * Deletes expired answers (and temporary files a crashed run left), unless the `pruned` marker says a
     * run already did within `pruneIntervalMs`.
     */
    prune: () => {
      if (statSync(directory, { throwIfNoEntry: false }) === undefined) return
      const marker = join(directory, "pruned")
      const last = statSync(marker, { throwIfNoEntry: false })
      if (last !== undefined && now - last.mtimeMs < pruneIntervalMs) return
      for (const shard of readdirSync(directory)) {
        if (!/^[0-9a-f]{2}$/.test(shard)) continue
        for (const name of readdirSync(join(directory, shard))) {
          const file = join(directory, shard, name)
          if (!fresh(file)) rmSync(file, { force: true })
        }
      }
      writeFileSync(marker, "")
    }
  }
}

/** What judging one policy cost in a run. */
export interface Usage {
  /** Requests sent to Clef (retries of a request not counted again). */
  readonly requests: number
  /** Answers taken from the cache instead of asked. */
  readonly cached: number
  /** Input tokens Clef reported for the requests sent; Clef bills no output tokens. */
  readonly inputTokens: number
  /** Requests whose response reported no token count, so `inputTokens` leaves them out. */
  readonly unmetered: number
}

export const noUsage: Usage = { requests: 0, cached: 0, inputTokens: 0, unmetered: 0 }

export const sumUsage = (usages: Iterable<Usage>): Usage => {
  let sum = noUsage
  for (const usage of usages) {
    sum = {
      requests: sum.requests + usage.requests,
      cached: sum.cached + usage.cached,
      inputTokens: sum.inputTokens + usage.inputTokens,
      unmetered: sum.unmetered + usage.unmetered
    }
  }
  return sum
}

/** Says why a request failed in terms a user can act on: the HTTP status and Cloudflare's error, a timeout, or the network error. */
const failureMessage = (error: unknown): Effect.Effect<string> => {
  if (Cause.isTimeoutError(error)) {
    return Effect.succeed(`Clef did not respond within ${attemptTimeout}, after ${attemptRetries} retries`)
  }
  if (HttpClientError.isHttpClientError(error)) {
    const { reason } = error
    if (reason._tag !== "StatusCodeError") {
      const cause = "cause" in reason && reason.cause instanceof Error ? `: ${reason.cause.message}` : ""
      return Effect.succeed(`Clef request failed: ${error.message}${cause}`)
    }
    return reason.response.text.pipe(
      Effect.timeout("5 seconds"),
      Effect.map((text) => text.trim().slice(0, 500)),
      Effect.orElseSucceed(() => ""),
      Effect.map((body) => `Clef responded with HTTP ${reason.response.status}${body === "" ? "" : `: ${body}`}`)
    )
  }
  return Effect.succeed(`Clef sent an unexpected response: ${error instanceof Error ? error.message : String(error)}`)
}

export class Clef extends Context.Service<Clef, {
  /** Judges each of a selector's `items` against `policy`; results follow `items` order. */
  judgeItems(
    policy: Policy,
    items: ReadonlyArray<Item>
  ): Effect.Effect<ReadonlyArray<Result.Result<Judgment, RequestTooLarge>>, ClefError>
  /** What each policy judged so far cost, by policy name; a policy that sent and cached nothing is absent. */
  readonly stats: Effect.Effect<ReadonlyMap<string, Usage>>
}>()("lint-anything/Clef") {
  /**
   * Clef on Workers AI; with `cacheDirectory`, answers are cached there per question across runs, and
   * answers older than `cacheMaxAgeMs` are asked again and deleted.
   */
  static readonly layer = (cacheDirectory?: string) =>
    Layer.effect(
      Clef,
      Effect.gen(function*() {
        const required = <A>(name: string, config: Config.Config<A>) =>
          config.pipe(Effect.mapError(() => new ClefError({ message: `${name} is not set; set it in the environment or in .env` })))
        const accountId = yield* required("CLOUDFLARE_ACCOUNT_ID", Config.String("CLOUDFLARE_ACCOUNT_ID"))
        const token = yield* required("CLOUDFLARE_AUTH_TOKEN", Config.Redacted("CLOUDFLARE_AUTH_TOKEN"))
        const baseUrl = yield* Config.String("CLOUDFLARE_API_BASE_URL").pipe(
          Config.withDefault("https://api.cloudflare.com/client/v4"),
          Effect.mapError((error) => new ClefError({ message: `CLOUDFLARE_API_BASE_URL: ${error.message}` }))
        )
        const client = (yield* HttpClient.HttpClient).pipe(
          HttpClient.mapRequest(flow(
            HttpClientRequest.prependUrl(`${baseUrl}/accounts/${accountId}/ai/run/@cf/cloudflare`),
            HttpClientRequest.bearerToken(token),
            HttpClientRequest.acceptJson
          )),
          HttpClient.filterStatusOk,
          // The body is read within the attempt (the response keeps it for decoding), so a stalled body
          // times out, and is retried, like a stalled response.
          HttpClient.transformResponse(flow(Effect.tap((response) => response.text), Effect.timeout(attemptTimeout))),
          HttpClient.retryTransient({ schedule: Schedule.exponential(500), times: attemptRetries })
        )

        const cache = cacheDirectory === undefined ? undefined : answerCache(cacheDirectory, Date.now())
        if (cache !== undefined) yield* Effect.sync(cache.prune)
        const permits = yield* Semaphore.make(maxConcurrentRequests)
        const usage = yield* Ref.make<ReadonlyMap<string, Usage>>(new Map())
        const record = (policy: string, added: Partial<Usage>) =>
          Ref.update(usage, (byPolicy) => new Map(byPolicy).set(policy, sumUsage([byPolicy.get(policy) ?? noUsage, { ...noUsage, ...added }])))

        /** Sends one planned request for `policy` and returns each question's answer, keyed like `request.questions`. */
        const send = Effect.fn("Clef.send")(function*<A>(policy: string, request: Planned<A>) {
          const { result } = yield* record(policy, { requests: 1 }).pipe(
            Effect.andThen(HttpClientRequest.post(`/${model}`).pipe(
              HttpClientRequest.bodyText(request.body, "application/json"),
              client.execute
            )),
            Effect.flatMap(HttpClientResponse.schemaBodyJson(ClefResponse)),
            permits.withPermit,
            Effect.catch((error) => Effect.flatMap(failureMessage(error), (message) => Effect.fail(new ClefError({ message }))))
          )
          yield* record(policy, result.usage === undefined ? { unmetered: 1 } : { inputTokens: result.usage.input_tokens })
          const answers: Array<{ readonly value: A; readonly noul: number }> = []
          for (const { id, value } of request.questions) {
            const answer = result.answers[id]
            if (answer === undefined) {
              return yield* new ClefError({ message: `Clef returned no answer for question ${id}` })
            }
            answers.push({ value, noul: answer.noul })
          }
          return answers
        })

        /**
         * Answers each value's question for `policy`: from the cache when it has one, otherwise by sending
         * the misses, planned by `plan`, and caching their answers. Returns answers and values too large to send.
         */
        const answer = Effect.fn("Clef.answer")(function*<A>(
          policy: string,
          state: string,
          values: ReadonlyArray<A>,
          question: (value: A) => object,
          plan: (misses: ReadonlyArray<A>) => { readonly requests: ReadonlyArray<Planned<A>>; readonly oversized: ReadonlyArray<{ readonly value: A; readonly bytes: number }> }
        ) {
          const answers: Array<{ readonly value: A; readonly noul: number }> = []
          const misses: Array<A> = []
          for (const value of values) {
            const noul = cache?.get(state, question(value))
            if (noul === undefined) misses.push(value)
            else answers.push({ value, noul })
          }
          if (answers.length > 0) yield* record(policy, { cached: answers.length })
          const { requests, oversized } = plan(misses)
          // `permits` bounds requests in flight across the run. Each request's answers are cached as it
          // returns, so a run that fails later keeps every answer it received.
          const sent = yield* Effect.forEach(requests, (request) =>
            send(policy, request).pipe(Effect.tap((received) =>
              Effect.sync(() => {
                for (const { value, noul } of received) cache?.set(state, question(value), noul)
              })
            )), { concurrency: "unbounded" })
          answers.push(...sent.flat())
          return { answers, oversized }
        })

        const judgeItems = Effect.fn("Clef.judgeItems")(function*(policy: Policy, items: ReadonlyArray<Item>) {
          const { answers, oversized } = yield* answer(
            policy.name,
            itemState(policy),
            items.map((_, index) => index),
            (index) => itemQuestion(policy, items[index]!),
            (misses) => {
              const planned = planItemRequests(policy, misses.map((index) => items[index]!))
              return {
                requests: planned.requests.map(({ body, questions }) => ({ body, questions: questions.map(({ id, value }) => ({ id, value: misses[value]! })) })),
                oversized: planned.oversized.map(({ value, bytes }) => ({ value: misses[value]!, bytes }))
              }
            }
          )
          const results: Array<Result.Result<Judgment, RequestTooLarge>> = []
          for (const { value: index, bytes } of oversized) results[index] = Result.fail(new RequestTooLarge({ bytes }))
          for (const { value: index, noul } of answers) results[index] = Result.succeed({ violates: noul })
          return results
        })

        return Clef.of({ judgeItems, stats: Ref.get(usage) })
      })
    ).pipe(Layer.provide(FetchHttpClient.layer))
}
