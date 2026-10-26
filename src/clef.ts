import { Database } from "bun:sqlite"
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { Cause, Config, Context, Effect, flow, Layer, Ref, Result, Runtime, Schedule, Schema, Semaphore } from "effect"
import { FetchHttpClient, HttpClient, HttpClientError, HttpClientRequest, HttpClientResponse } from "effect/http"

/** The Workers AI model lint-anything asks: `@cf/cloudflare/clef`. */
export const model = "clef"

/**
 * One yes/no question: `instructions` is what Clef judges, and `criteria` say what a yes (`true`) and a no
 * (`false`) mean. Clef answers with the probability of yes.
 */
export interface Question {
  readonly instructions: string
  readonly criteria: { readonly true: string; readonly false: string }
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
 * model, and the expired answer is deleted, so the cache doesn't grow without bound.
 */
export const cacheMaxAgeMs = 30 * 24 * 60 * 60 * 1000

/** The answer cache's SQLite database, in the cache directory. */
const cacheFile = "answers.sqlite"
// A run that finds the database locked by another run's write waits this long before failing.
const cacheBusyTimeoutMs = 10_000

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

// `criteria` is passed through as given: the request body and the cache key are its serialization.
const noul = (question: Question) => ({ type: "noul", instructions: question.instructions, criteria: question.criteria })

/**
 * Plans the requests that ask `questions` under `state`: the state once per request and as many questions
 * as fit. Planned questions answer by index into `questions`.
 */
export const planRequests = (state: string, questions: ReadonlyArray<Question>) =>
  pack(state, questions.map((_, index) => index), (index, taken) => serialize(`i${taken.size}`, noul(questions[index]!)))

/**
 * Answers kept on disk in one SQLite database, one row per question, keyed by the model, the request text,
 * and the question (not its id or the other questions in the request), so unchanged questions aren't sent
 * again. Opening it deletes answers older than `cacheMaxAgeMs` at `now`, so they are asked again.
 */
const openAnswerCache = (directory: string, now: number) => {
  mkdirSync(directory, { recursive: true })
  const db = new Database(join(directory, cacheFile))
  // Concurrent runs share the file: in WAL mode they read while another writes, and writers take turns.
  db.run(`PRAGMA busy_timeout = ${cacheBusyTimeoutMs}`)
  db.run("PRAGMA journal_mode = WAL")
  // A row holds only a probability (the CHECK), so an edited database can't hand back a non-answer.
  db.run(`CREATE TABLE IF NOT EXISTS answers (
    key BLOB PRIMARY KEY,
    noul REAL NOT NULL CHECK (noul BETWEEN 0 AND 1),
    answered INTEGER NOT NULL
  ) STRICT, WITHOUT ROWID`)
  db.run("CREATE INDEX IF NOT EXISTS answers_answered ON answers (answered)")
  db.run("DELETE FROM answers WHERE answered <= ?", [now - cacheMaxAgeMs])
  const select = db.query<{ noul: number }, [Uint8Array]>("SELECT noul FROM answers WHERE key = ?")
  const upsert = db.query("INSERT OR REPLACE INTO answers (key, noul, answered) VALUES (?, ?, ?)")
  const key = (state: string, question: object): Uint8Array =>
    new Bun.CryptoHasher("sha256").update(`${model}\0${state}\0${JSON.stringify(question)}`).digest()
  // One transaction per request's answers: a run stopped later keeps every answer it received.
  const insert = db.transaction((state: string, answers: ReadonlyArray<{ readonly question: object; readonly noul: number }>) => {
    const answered = Date.now()
    for (const { question, noul } of answers) upsert.run(key(state, question), noul, answered)
  })
  const failed = (error: unknown) =>
    new ClefError({ message: `answer cache ${join(directory, cacheFile)}: ${error instanceof Error ? error.message : String(error)}` })
  return {
    /** Each question's cached answer, or `undefined` when it has none. */
    get: (state: string, questions: ReadonlyArray<object>) =>
      Effect.try({ try: () => questions.map((question) => select.get(key(state, question))?.noul), catch: failed }),
    set: (state: string, answers: ReadonlyArray<{ readonly question: object; readonly noul: number }>) =>
      Effect.try({ try: () => insert(state, answers), catch: failed }),
    close: () => db.close()
  }
}

/** What one source's questions cost in a run. */
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
  /**
   * Asks each of `questions` under the shared `state`; results follow `questions` order, each the probability
   * of yes, or `RequestTooLarge` for a question too large to send. `source` names who asked, for `stats`.
   */
  ask(
    source: string,
    state: string,
    questions: ReadonlyArray<Question>
  ): Effect.Effect<ReadonlyArray<Result.Result<number, RequestTooLarge>>, ClefError>
  /** What each source's questions cost so far, by source; a source that sent and cached nothing is absent. */
  readonly stats: Effect.Effect<ReadonlyMap<string, Usage>>
}>()("lint-anything/Clef") {
  /**
   * Clef on Workers AI; with `cacheDirectory`, answers are cached in a database there per question across
   * runs, and answers older than `cacheMaxAgeMs` are deleted and asked again.
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

        const cache = cacheDirectory === undefined ? undefined : yield* Effect.acquireRelease(
          Effect.try({
            try: () => openAnswerCache(cacheDirectory, Date.now()),
            catch: (error) =>
              new ClefError({ message: `cannot open the answer cache in ${cacheDirectory}: ${error instanceof Error ? error.message : String(error)}` })
          }),
          (cache) => Effect.sync(cache.close)
        )
        const permits = yield* Semaphore.make(maxConcurrentRequests)
        const usage = yield* Ref.make<ReadonlyMap<string, Usage>>(new Map())
        const record = (source: string, added: Partial<Usage>) =>
          Ref.update(usage, (bySource) => new Map(bySource).set(source, sumUsage([bySource.get(source) ?? noUsage, { ...noUsage, ...added }])))

        /** Sends one planned request for `source` and returns each question's answer, keyed like `request.questions`. */
        const send = Effect.fn("Clef.send")(function*<A>(source: string, request: Planned<A>) {
          const { result } = yield* record(source, { requests: 1 }).pipe(
            Effect.andThen(HttpClientRequest.post(`/${model}`).pipe(
              HttpClientRequest.bodyText(request.body, "application/json"),
              client.execute
            )),
            Effect.flatMap(HttpClientResponse.schemaBodyJson(ClefResponse)),
            permits.withPermit,
            Effect.catch((error) => Effect.flatMap(failureMessage(error), (message) => Effect.fail(new ClefError({ message }))))
          )
          yield* record(source, result.usage === undefined ? { unmetered: 1 } : { inputTokens: result.usage.input_tokens })
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
         * Answers each question for `source`: from the cache when it has one, otherwise by sending the
         * misses and caching their answers. Results follow `questions` order.
         */
        const ask = Effect.fn("Clef.ask")(function*(source: string, state: string, questions: ReadonlyArray<Question>) {
          const results: Array<Result.Result<number, RequestTooLarge>> = []
          const misses: Array<number> = []
          const cached = cache === undefined ? [] : yield* cache.get(state, questions.map(noul))
          questions.forEach((_, index) => {
            const answer = cached[index]
            if (answer === undefined) misses.push(index)
            else results[index] = Result.succeed(answer)
          })
          if (misses.length < questions.length) yield* record(source, { cached: questions.length - misses.length })
          const { requests, oversized } = planRequests(state, misses.map((index) => questions[index]!))
          for (const { value, bytes } of oversized) results[misses[value]!] = Result.fail(new RequestTooLarge({ bytes }))
          // `permits` bounds requests in flight across the run. Each request's answers are cached as it
          // returns, so a run that fails later keeps every answer it received.
          yield* Effect.forEach(requests, (request) =>
            send(source, request).pipe(Effect.tap((received) => {
              for (const { value, noul: answer } of received) results[misses[value]!] = Result.succeed(answer)
              return cache === undefined
                ? Effect.void
                : cache.set(state, received.map(({ value, noul: answer }) => ({ question: noul(questions[misses[value]!]!), noul: answer })))
            })), { concurrency: "unbounded", discard: true })
          return results
        })

        return Clef.of({ ask, stats: Ref.get(usage) })
      })
    ).pipe(Layer.provide(FetchHttpClient.layer))
}
