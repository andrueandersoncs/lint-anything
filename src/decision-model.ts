import { Database } from "bun:sqlite"
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { Cause, Config, Context, Effect, flow, Layer, Option, Redacted, Ref, Result, Runtime, Schedule, Schema, Semaphore } from "effect"
import { FetchHttpClient, HttpClient, HttpClientError, HttpClientRequest } from "effect/http"

/**
 * One yes/no question: `instructions` is what the decision model judges, and `criteria` say what a yes
 * (`true`) and a no (`false`) mean. The model answers with the probability of yes.
 */
export interface Question {
  readonly instructions: string
  readonly criteria: { readonly true: string; readonly false: string }
}

export class DecisionModelError extends Schema.TaggedError<DecisionModelError>()("DecisionModelError", {
  message: Schema.String
}) {
  override readonly [Runtime.errorExitCode] = 2
}

/** The question was not sent: its request would exceed the request size limit. */
export class RequestTooLarge extends Schema.TaggedError<RequestTooLarge>()("RequestTooLarge", {
  bytes: Schema.Number,
  message: Schema.String
}) {}

/** The model declined to answer the question (an OpenAI Decisions `refusal`, or a request Gemini's safety filters blocked). */
export class Declined extends Schema.TaggedError<Declined>()("Declined", {
  message: Schema.String
}) {}

/** Why a question has no answer. */
export type Unanswered = RequestTooLarge | Declined

// Clef's context window is 65,536 tokens. A token is at least one byte, so a body within this limit is
// never truncated by Clef, or by any model whose window is at least as large. Every model gets the same
// limit, so a policy's items are packed alike whichever model judges them.
const maxRequestBytes = 64_000

// Clef takes at most 64 questions per request; every decision API that documents a limit takes at least as
// many (System One servers 64 to 128, OpenAI Decisions 400).
const maxQuestions = 64

/** USD per input token for Clef on Workers AI, which bills no output tokens. */
export const clefInputTokenPrice = 0.24e-6

const defaultCloudflareBaseUrl = "https://api.cloudflare.com/client/v4"

// Requests in flight at once across the whole run, as many as one policy sent before policies ran
// concurrently, so a run puts no more load on the model's endpoint than it did.
const maxConcurrentRequests = 8

// One attempt, response body included, may take this long before it counts as a transient failure and is
// retried. Of 247,770 eval requests to Clef, 9 took over 10 seconds and 1 over 60 (the slowest 80).
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

// --- Wire formats -----------------------------------------------------------------------------------

/**
 * The request and response format of a decision endpoint.
 *
 * - `system-one`: the System One API (`POST /v1/systemone`) that Jev introduced and Clef, LiteLLM, LLM
 *   Gateway, Ollama, llama.cpp, SGLang, and most decision-model servers speak. A request has a `state` and
 *   `noul` questions keyed by id; each answer is the probability of yes. Workers AI wraps the response in
 *   `result`, which is read the same way.
 * - `decisions`: OpenAI's Decisions API (`POST /v1/decisions`). A request has an `input` and a list of
 *   `predicate` questions; answers come back as a list, each a probability or a refusal.
 * - `gemini`: Google's Decisions API for Gemini Decision (`POST /v1beta/decisions` on
 *   `generativelanguage.googleapis.com`). A request has an `input` and `noul` questions keyed by id, whose
 *   criteria are `true_description` and `false_description`; the key goes in `x-goog-api-key`. A request
 *   its safety filters block is answered with HTTP 400 instead, which declines every question in it.
 */
export type Format = "system-one" | "decisions" | "gemini"

/** A response, read: each question's probability of yes, or `declined`, by id, and the input tokens it reports. */
interface Reply {
  readonly answers: ReadonlyMap<string, number | "declined">
  readonly inputTokens: number | undefined
}

interface Wire {
  /** The request body up to its first question. */
  readonly head: (model: string, state: string) => string
  /** The request body after its last question. */
  readonly tail: string
  /** One question in the request body, under `id`. */
  readonly entry: (id: string, question: Question) => string
  /** Reads a response body. */
  readonly decode: (body: unknown) => Effect.Effect<Reply, Schema.SchemaError>
  /** The header that carries the API key or token. */
  readonly keyHeader: (key: string) => readonly [name: string, value: string]
  /** Whether an error response (its status and body) declines every question in the request. */
  readonly declinesAll: (status: number, body: string) => boolean
}

const bearer = (key: string) => ["authorization", `Bearer ${key}`] as const
const never = () => false

const Probability = Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 }))
const ReportedUsage = Schema.optional(Schema.Struct({ input_tokens: Schema.Number }))

// `criteria` is passed through as given: the request body and the cache key are its serialization.
const noul = (question: Question) => ({ type: "noul", instructions: question.instructions, criteria: question.criteria })

const SystemOneResponse = Schema.Struct({
  answers: Schema.Record(Schema.String, Schema.Struct({ noul: Probability })),
  usage: ReportedUsage
})

const systemOne: Wire = {
  head: (model, state) => `${JSON.stringify({ model, state }).slice(0, -1)},"questions":{`,
  tail: "}}",
  entry: (id, question) => `${JSON.stringify(id)}:${JSON.stringify(noul(question))}`,
  // Workers AI wraps every model response in `result`; System One servers answer unwrapped.
  decode: (body) =>
    Schema.decodeUnknownEffect(SystemOneResponse)(
      typeof body === "object" && body !== null && "result" in body ? body.result : body
    ).pipe(Effect.map(({ answers, usage }) => ({
      answers: new Map(Object.entries(answers).map(([id, answer]) => [id, answer.noul])),
      inputTokens: usage?.input_tokens
    }))),
  keyHeader: bearer,
  declinesAll: never
}

// A predicate has no criteria, so they are folded into its instructions (as LiteLLM folds a noul question's
// criteria when it sends one to OpenAI). Its probability is that the condition is true.
const predicate = (id: string, question: Question) => ({
  type: "predicate",
  name: id,
  instructions: `${question.instructions}\n\ntrue: ${question.criteria.true}\nfalse: ${question.criteria.false}`
})

const DecisionsResponse = Schema.Struct({
  answers: Schema.Array(Schema.Union([
    Schema.Struct({ type: Schema.Literal("predicate"), name: Schema.String, probability: Probability }),
    Schema.Struct({ type: Schema.Literal("refusal"), name: Schema.String })
  ])),
  usage: ReportedUsage
})

const decisions: Wire = {
  head: (model, state) => `${JSON.stringify({ model, input: state }).slice(0, -1)},"questions":[`,
  tail: "]}",
  entry: (id, question) => JSON.stringify(predicate(id, question)),
  decode: (body) =>
    Schema.decodeUnknownEffect(DecisionsResponse)(body).pipe(Effect.map(({ answers, usage }) => ({
      answers: new Map<string, number | "declined">(
        answers.map((answer) => [answer.name, answer.type === "refusal" ? "declined" : answer.probability])
      ),
      inputTokens: usage?.input_tokens
    }))),
  keyHeader: bearer,
  declinesAll: never
}

// Gemini's noul criteria name what a yes and a no mean `true_description` and `false_description`.
const geminiNoul = (question: Question) => ({
  type: "noul",
  instructions: question.instructions,
  criteria: { true_description: question.criteria.true, false_description: question.criteria.false }
})

const GeminiResponse = Schema.Struct({
  answers: Schema.Record(Schema.String, Schema.Struct({ noul: Probability })),
  usage: Schema.optional(Schema.Struct({ total_input_tokens: Schema.Number }))
})

// The error codes of a request Gemini's input safety filters blocked (HTTP 400).
const GeminiBlocked = Schema.fromJsonString(Schema.Struct({
  error: Schema.Struct({ code: Schema.Literals(["safety", "prohibited_content", "blocklist", "image_safety", "content_blocked"]) })
}))

const gemini: Wire = {
  head: (model, state) => `${JSON.stringify({ model, input: state }).slice(0, -1)},"questions":{`,
  tail: "}}",
  entry: (id, question) => `${JSON.stringify(id)}:${JSON.stringify(geminiNoul(question))}`,
  decode: (body) =>
    Schema.decodeUnknownEffect(GeminiResponse)(body).pipe(Effect.map(({ answers, usage }) => ({
      answers: new Map(Object.entries(answers).map(([id, answer]) => [id, answer.noul])),
      inputTokens: usage?.total_input_tokens
    }))),
  keyHeader: (key) => ["x-goog-api-key", key],
  declinesAll: (status, body) => status === 400 && Option.isSome(Schema.decodeUnknownOption(GeminiBlocked)(body))
}

const wires: Record<Format, Wire> = { "system-one": systemOne, decisions, gemini }

/** Reads a decision endpoint's response body in `format`. */
export const decodeReply = (format: Format, body: unknown) => wires[format].decode(body)

/** The header that carries `key` to an endpoint in `format`: a bearer token, or Gemini's `x-goog-api-key`. */
export const keyHeader = (format: Format, key: string) => wires[format].keyHeader(key)

/**
 * Whether an endpoint in `format` declined every question of a request by answering with this error status
 * and body (a request Gemini's safety filters blocked).
 */
export const declinesAll = (format: Format, status: number, body: string) => wires[format].declinesAll(status, body)

// --- Models and where to reach them -----------------------------------------------------------------

/** A decision model: which one to ask, the format its endpoint speaks, and what is known about it. */
export interface Model {
  /** The wire format of its endpoint. */
  readonly format: Format
  /** Its name in request bodies. */
  readonly model: string
  /** What messages call it: `Clef` for Clef on Workers AI, else `model`. */
  readonly name: string
  /** What its answers are filed under in the answer cache. */
  readonly cacheKey: string
  /** USD per input token, when known. */
  readonly inputTokenPrice: number | undefined
}

/**
 * A decision model and how to reach it: the endpoint requests are POSTed to, and the API key or token, if
 * any (a bearer token, or for Gemini `x-goog-api-key`).
 */
export interface Target extends Model {
  readonly url: string
  readonly token: Redacted.Redacted<string> | undefined
}

/** Clef on Workers AI, the model a run asks unless configured otherwise. */
export const clef: Model = workersAiModel("clef")

function workersAiModel(model: string): Model {
  return {
    format: "system-one",
    model,
    name: model === "clef" ? "Clef" : model,
    // Answers are filed under the model's name alone, as Clef's were before other models: caches still hit.
    cacheKey: model,
    inputTokenPrice: model === "clef" ? clefInputTokenPrice : undefined
  }
}

/** A Cloudflare decision model on Workers AI (`@cf/cloudflare/<model>`), Clef by default. */
export const workersAiTarget = (options: {
  readonly accountId: string
  readonly token: Redacted.Redacted<string>
  readonly model?: string
  readonly baseUrl?: string
}): Target => {
  const model = options.model ?? "clef"
  return {
    ...workersAiModel(model),
    url: `${options.baseUrl ?? defaultCloudflareBaseUrl}/accounts/${options.accountId}/ai/run/@cf/cloudflare/${model}`,
    token: options.token
  }
}

/** Google's Gemini API host, which serves the Gemini Decisions API. */
const geminiHost = "generativelanguage.googleapis.com"

/**
 * The format an endpoint speaks: Gemini Decisions on Google's Gemini API host, OpenAI Decisions when its
 * path ends in `/decisions`, System One otherwise.
 */
const formatOf = (url: string): Format => {
  const { hostname, pathname } = new URL(url)
  if (hostname === geminiHost) return "gemini"
  return pathname.replace(/\/+$/, "").endsWith("/decisions") ? "decisions" : "system-one"
}

const endpointModel = (url: string, model: string): Model => ({
  format: formatOf(url),
  model,
  name: model,
  cacheKey: `${url} ${model}`,
  inputTokenPrice: undefined
})

/**
 * A decision model behind any endpoint: Gemini Decisions on `generativelanguage.googleapis.com` (such as
 * `https://generativelanguage.googleapis.com/v1beta/decisions`), OpenAI Decisions when the URL's path ends
 * in `/decisions` (such as `https://api.openai.com/v1/decisions`), System One otherwise (such as
 * `http://localhost:4000/v1/systemone`).
 */
export const endpointTarget = (options: {
  readonly url: string
  readonly model: string
  readonly token?: Redacted.Redacted<string> | undefined
}): Target => ({ ...endpointModel(options.url, options.model), url: options.url, token: options.token })

// --- Configuration ----------------------------------------------------------------------------------

const configError = (message: string) => new DecisionModelError({ message })

/** An optional variable; set but empty counts as unset. */
const setting = (name: string) =>
  Config.option(Config.String(name)).pipe(
    Effect.map(Option.filter((value) => value !== "")),
    Effect.mapError((error) => configError(`${name}: ${error.message}`))
  )

const isHttpUrl = (value: string) => URL.canParse(value) && ["http:", "https:"].includes(new URL(value).protocol)

/** The `LINT_ANYTHING_` variables: an endpoint with its model and key, or a Cloudflare model on Workers AI. */
const choice = Effect.gen(function*() {
  const endpoint = yield* setting("LINT_ANYTHING_ENDPOINT")
  const model = yield* setting("LINT_ANYTHING_MODEL")
  const apiKey = yield* setting("LINT_ANYTHING_API_KEY")
  if (Option.isSome(endpoint)) {
    if (!isHttpUrl(endpoint.value)) {
      return yield* configError(`LINT_ANYTHING_ENDPOINT must be an http or https URL, such as http://localhost:4000/v1/systemone`)
    }
    if (Option.isNone(model)) {
      return yield* configError(`LINT_ANYTHING_MODEL is not set; LINT_ANYTHING_ENDPOINT needs the name of the model to ask`)
    }
    return { kind: "endpoint", url: endpoint.value, model: model.value, token: Option.getOrUndefined(Option.map(apiKey, Redacted.make)) } as const
  }
  if (Option.isSome(apiKey)) {
    return yield* configError(
      "LINT_ANYTHING_API_KEY is set but LINT_ANYTHING_ENDPOINT is not; set the endpoint the key is for (Clef on Workers AI uses CLOUDFLARE_AUTH_TOKEN)"
    )
  }
  const name = Option.getOrElse(model, () => "clef")
  if (!/^[\w.-]+$/.test(name)) {
    return yield* configError(
      `LINT_ANYTHING_MODEL ${name} is not a Cloudflare model; to ask it, set LINT_ANYTHING_ENDPOINT to the decision endpoint that serves it`
    )
  }
  return { kind: "workers-ai", model: name } as const
})

/**
 * The decision model the environment configures, without what it takes to reach it: Clef unless
 * `LINT_ANYTHING_ENDPOINT` or `LINT_ANYTHING_MODEL` says otherwise. Needs no credentials.
 */
export const configuredModel: Effect.Effect<Model, DecisionModelError> = Effect.map(
  choice,
  (chosen) => (chosen.kind === "endpoint" ? endpointModel(chosen.url, chosen.model) : workersAiModel(chosen.model))
)

/**
 * The decision model the environment configures, and how to reach it.
 *
 * - With `LINT_ANYTHING_ENDPOINT`: that endpoint (Gemini Decisions on `generativelanguage.googleapis.com`,
 *   OpenAI Decisions when its path ends in `/decisions`, System One otherwise), asking `LINT_ANYTHING_MODEL`,
 *   with `LINT_ANYTHING_API_KEY` as the key if set (a bearer token, or for Gemini `x-goog-api-key`).
 * - Without it: `LINT_ANYTHING_MODEL` (default `clef`) on Workers AI, with `CLOUDFLARE_ACCOUNT_ID`,
 *   `CLOUDFLARE_AUTH_TOKEN`, and optionally `CLOUDFLARE_API_BASE_URL`.
 */
export const configuredTarget: Effect.Effect<Target, DecisionModelError> = Effect.gen(function*() {
  const chosen = yield* choice
  if (chosen.kind === "endpoint") return endpointTarget(chosen)
  const required = <A>(name: string, config: Config.Config<A>) =>
    config.pipe(Effect.mapError(() => configError(`${name} is not set; set it in the environment or in .env`)))
  const accountId = yield* required("CLOUDFLARE_ACCOUNT_ID", Config.String("CLOUDFLARE_ACCOUNT_ID"))
  const token = yield* required("CLOUDFLARE_AUTH_TOKEN", Config.Redacted("CLOUDFLARE_AUTH_TOKEN"))
  const baseUrl = yield* Config.String("CLOUDFLARE_API_BASE_URL").pipe(
    Config.withDefault(defaultCloudflareBaseUrl),
    Effect.mapError((error) => configError(`CLOUDFLARE_API_BASE_URL: ${error.message}`))
  )
  return workersAiTarget({ accountId, token, model: chosen.model, baseUrl })
})

// --- Packing ----------------------------------------------------------------------------------------

/** One request: its exact body and what each question id answers. */
export interface Planned<A> {
  readonly body: string
  readonly questions: ReadonlyArray<{ readonly id: string; readonly value: A }>
}

/**
 * Packs one question per value, in order, into as few requests sharing `state` as the question and byte
 * limits allow, laid out for `model`. Question ids are `i0`, `i1`, … within each request. A value too
 * large to send even alone is returned in `oversized`.
 */
const pack = <A>(
  model: Pick<Model, "format" | "model">,
  state: string,
  values: ReadonlyArray<A>,
  question: (value: A) => Question
) => {
  const wire = wires[model.format]
  // The body is assembled from serialized parts so each request's exact size is known while packing.
  const head = wire.head(model.model, state)
  const fixedBytes = Buffer.byteLength(head) + Buffer.byteLength(wire.tail)
  const entry = (value: A, index: number) => {
    const id = `i${index}`
    const text = wire.entry(id, question(value))
    return { id, text, bytes: Buffer.byteLength(text) }
  }
  const requests: Array<Planned<A>> = []
  const oversized: Array<{ readonly value: A; readonly bytes: number }> = []
  let entries: Array<string> = []
  let questions: Array<{ readonly id: string; readonly value: A }> = []
  let bytes = fixedBytes
  const flush = () => {
    if (questions.length > 0) requests.push({ body: `${head}${entries.join(",")}${wire.tail}`, questions })
    entries = []
    questions = []
    bytes = fixedBytes
  }
  for (const value of values) {
    const alone = entry(value, 0)
    if (fixedBytes + alone.bytes > maxRequestBytes) {
      oversized.push({ value, bytes: fixedBytes + alone.bytes })
      continue
    }
    let next = entry(value, questions.length)
    if (questions.length === maxQuestions || bytes + ",".length + next.bytes > maxRequestBytes) {
      flush()
      next = alone
    }
    bytes += (questions.length === 0 ? 0 : ",".length) + next.bytes
    entries.push(next.text)
    questions.push({ id: next.id, value })
  }
  flush()
  return { requests, oversized }
}

/**
 * Plans the requests that ask `questions` under `state`: the state once per request and as many questions
 * as fit, laid out for `model` (default: Clef). Planned questions answer by index into `questions`.
 */
export const planRequests = (state: string, questions: ReadonlyArray<Question>, model: Pick<Model, "format" | "model"> = clef) =>
  pack(model, state, questions.map((_, index) => index), (index) => questions[index]!)

// --- Answer cache -----------------------------------------------------------------------------------

/**
 * Answers kept on disk in one SQLite database, one row per question, keyed by the model's cache key, the
 * request text, and the question (not its id or the other questions in the request), so unchanged questions
 * aren't sent again. Opening it deletes answers older than `cacheMaxAgeMs` at `now`, so they are asked again.
 */
const openAnswerCache = (directory: string, now: number, model: Model) => {
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
  const key = (state: string, question: Question): Uint8Array =>
    new Bun.CryptoHasher("sha256").update(`${model.cacheKey}\0${state}\0${JSON.stringify(noul(question))}`).digest()
  // One transaction per request's answers: a run stopped later keeps every answer it received.
  const insert = db.transaction((state: string, answers: ReadonlyArray<{ readonly question: Question; readonly noul: number }>) => {
    const answered = Date.now()
    for (const { question, noul } of answers) upsert.run(key(state, question), noul, answered)
  })
  const failed = (error: unknown) =>
    new DecisionModelError({ message: `answer cache ${join(directory, cacheFile)}: ${error instanceof Error ? error.message : String(error)}` })
  return {
    /** Each question's cached answer, or `undefined` when it has none. */
    get: (state: string, questions: ReadonlyArray<Question>) =>
      Effect.try({ try: () => questions.map((question) => select.get(key(state, question))?.noul), catch: failed }),
    set: (state: string, answers: ReadonlyArray<{ readonly question: Question; readonly noul: number }>) =>
      Effect.try({ try: () => insert(state, answers), catch: failed }),
    close: () => db.close()
  }
}

// --- Usage ------------------------------------------------------------------------------------------

/** What one source's questions cost in a run. */
export interface Usage {
  /** Requests sent to the model (retries of a request not counted again). */
  readonly requests: number
  /** Answers taken from the cache instead of asked. */
  readonly cached: number
  /** Input tokens the model reported for the requests sent. */
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

// --- The service ------------------------------------------------------------------------------------

/** Says why a request failed in terms a user can act on: the HTTP status and the endpoint's error, a timeout, or the network error. */
const failureMessage = (name: string, error: unknown): Effect.Effect<string> => {
  if (Cause.isTimeoutError(error)) {
    return Effect.succeed(`${name} did not respond within ${attemptTimeout}, after ${attemptRetries} retries`)
  }
  if (HttpClientError.isHttpClientError(error)) {
    const { reason } = error
    if (reason._tag !== "StatusCodeError") {
      const cause = "cause" in reason && reason.cause instanceof Error ? `: ${reason.cause.message}` : ""
      return Effect.succeed(`${name} request failed: ${error.message}${cause}`)
    }
    return reason.response.text.pipe(
      Effect.timeout("5 seconds"),
      Effect.map((text) => text.trim().slice(0, 500)),
      Effect.orElseSucceed(() => ""),
      Effect.map((body) => `${name} responded with HTTP ${reason.response.status}${body === "" ? "" : `: ${body}`}`)
    )
  }
  // A schema error spans lines (each issue with its path); a stopping error is one line.
  const detail = (error instanceof Error ? error.message : String(error)).replace(/\s*\n\s*/g, " ")
  return Effect.succeed(`${name} sent an unexpected response: ${detail}`)
}

export class DecisionModel extends Context.Service<DecisionModel, {
  /** The model asked, and where. */
  readonly target: Target
  /**
   * Asks each of `questions` under the shared `state`; results follow `questions` order, each the probability
   * of yes, or why there is none (`RequestTooLarge`, `Declined`). `source` names who asked, for `stats`.
   */
  ask(
    source: string,
    state: string,
    questions: ReadonlyArray<Question>
  ): Effect.Effect<ReadonlyArray<Result.Result<number, Unanswered>>, DecisionModelError>
  /** What each source's questions cost so far, by source; a source that sent and cached nothing is absent. */
  readonly stats: Effect.Effect<ReadonlyMap<string, Usage>>
}>()("lint-anything/DecisionModel") {
  /**
   * The decision model the environment configures (`configuredTarget`): Clef on Workers AI by default. With
   * `cacheDirectory`, answers are cached in a database there per question across runs, and answers older
   * than `cacheMaxAgeMs` are deleted and asked again.
   */
  static readonly layer = (cacheDirectory?: string) =>
    Layer.effect(DecisionModel, Effect.flatMap(configuredTarget, (target) => make(target, cacheDirectory))).pipe(
      Layer.provide(FetchHttpClient.layer)
    )

  /** `target`, whatever the environment says; answers are cached as with `layer`. */
  static readonly layerFor = (target: Target, cacheDirectory?: string) =>
    Layer.effect(DecisionModel, make(target, cacheDirectory)).pipe(Layer.provide(FetchHttpClient.layer))
}

const make = Effect.fnUntraced(function*(target: Target, cacheDirectory: string | undefined) {
  const wire = wires[target.format]
  const { token } = target
  const client = (yield* HttpClient.HttpClient).pipe(
    HttpClient.mapRequest(flow(
      token === undefined ? (request) => request : HttpClientRequest.setHeader(...wire.keyHeader(Redacted.value(token))),
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
      try: () => openAnswerCache(cacheDirectory, Date.now(), target),
      catch: (error) =>
        new DecisionModelError({
          message: `cannot open the answer cache in ${cacheDirectory}: ${error instanceof Error ? error.message : String(error)}`
        })
    }),
    (cache) => Effect.sync(cache.close)
  )
  const permits = yield* Semaphore.make(maxConcurrentRequests)
  const usage = yield* Ref.make<ReadonlyMap<string, Usage>>(new Map())
  const record = (source: string, added: Partial<Usage>) =>
    Ref.update(usage, (bySource) => new Map(bySource).set(source, sumUsage([bySource.get(source) ?? noUsage, { ...noUsage, ...added }])))

  const tooLarge = (bytes: number) =>
    new RequestTooLarge({
      bytes,
      message: target.name === "Clef"
        ? `request is ${bytes} bytes; Clef would truncate it`
        : `request is ${bytes} bytes, over the ${maxRequestBytes}-byte request limit`
    })
  const declined = new Declined({ message: `${target.name} declined to answer` })

  /** Whether `error` is an error response that declines every question in its request (`wire.declinesAll`). */
  const declinesAll = (error: unknown): Effect.Effect<boolean> => {
    if (!HttpClientError.isHttpClientError(error) || error.reason._tag !== "StatusCodeError") return Effect.succeed(false)
    const { response } = error.reason
    return response.text.pipe(
      Effect.timeout("5 seconds"),
      Effect.map((text) => wire.declinesAll(response.status, text)),
      Effect.orElseSucceed(() => false)
    )
  }

  /** Sends one planned request for `source` and returns each question's answer, keyed like `request.questions`. */
  const send = Effect.fn("DecisionModel.send")(function*<A>(source: string, request: Planned<A>) {
    const reply: Reply = yield* record(source, { requests: 1 }).pipe(
      Effect.andThen(HttpClientRequest.post(target.url).pipe(
        HttpClientRequest.bodyText(request.body, "application/json"),
        client.execute
      )),
      Effect.flatMap((response) => response.json),
      Effect.flatMap(wire.decode),
      permits.withPermit,
      Effect.catch((error) =>
        Effect.flatMap(declinesAll(error), (all): Effect.Effect<Reply, DecisionModelError> =>
          all
            ? Effect.succeed({ answers: new Map(request.questions.map(({ id }) => [id, "declined"])), inputTokens: undefined })
            : Effect.flatMap(failureMessage(target.name, error), (message) => Effect.fail(new DecisionModelError({ message }))))
      )
    )
    yield* record(source, reply.inputTokens === undefined ? { unmetered: 1 } : { inputTokens: reply.inputTokens })
    const answers: Array<{ readonly value: A; readonly answer: number | "declined" }> = []
    for (const { id, value } of request.questions) {
      const answer = reply.answers.get(id)
      if (answer === undefined) {
        return yield* new DecisionModelError({ message: `${target.name} returned no answer for question ${id}` })
      }
      answers.push({ value, answer })
    }
    return answers
  })

  /**
   * Answers each question for `source`: from the cache when it has one, otherwise by sending the misses and
   * caching their answers. Results follow `questions` order.
   */
  const ask = Effect.fn("DecisionModel.ask")(function*(source: string, state: string, questions: ReadonlyArray<Question>) {
    const results: Array<Result.Result<number, Unanswered>> = []
    const misses: Array<number> = []
    const cached = cache === undefined ? [] : yield* cache.get(state, questions)
    questions.forEach((_, index) => {
      const answer = cached[index]
      if (answer === undefined) misses.push(index)
      else results[index] = Result.succeed(answer)
    })
    if (misses.length < questions.length) yield* record(source, { cached: questions.length - misses.length })
    const { requests, oversized } = planRequests(state, misses.map((index) => questions[index]!), target)
    for (const { value, bytes } of oversized) results[misses[value]!] = Result.fail(tooLarge(bytes))
    // `permits` bounds requests in flight across the run. Each request's answers are cached as it
    // returns, so a run that fails later keeps every answer it received. A declined question isn't
    // cached: it is asked again next run.
    yield* Effect.forEach(requests, (request) =>
      send(source, request).pipe(Effect.tap((received) => {
        const answered: Array<{ readonly question: Question; readonly noul: number }> = []
        for (const { value, answer } of received) {
          const index = misses[value]!
          if (answer === "declined") {
            results[index] = Result.fail(declined)
          } else {
            results[index] = Result.succeed(answer)
            answered.push({ question: questions[index]!, noul: answer })
          }
        }
        return cache === undefined ? Effect.void : cache.set(state, answered)
      })), { concurrency: "unbounded", discard: true })
    return results
  })

  return DecisionModel.of({ target, ask, stats: Ref.get(usage) })
})
