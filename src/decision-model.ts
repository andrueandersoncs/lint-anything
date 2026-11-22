import { Database } from "bun:sqlite"
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { Cause, Config, Context, Effect, flow, Layer, Option, Redacted, Ref, Result, Runtime, Schedule, Schema, Semaphore } from "effect"
import { FetchHttpClient, HttpClient, HttpClientError, HttpClientRequest } from "effect/http"
import { maxImageBytes, maxMediaBytes, mediaBase64, type MediaKind, mediaKinds, mediaNoun, type Medium, readMedium } from "./media.ts"

/**
 * One yes/no question: `instructions` is what the decision model judges, and `criteria` say what a yes
 * (`true`) and a no (`false`) mean. The model answers with the probability of yes. `media` lists image,
 * audio, and video files the model is shown with it, by path from the current directory (types by
 * extension, `media.ts`); a request shows its media for every question in it, so only questions with the
 * same media share one.
 */
export interface Question {
  readonly instructions: string
  readonly criteria: { readonly true: string; readonly false: string }
  readonly media?: ReadonlyArray<string>
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
 *   `result`, which is read the same way. Media go before the state as data URLs, in `images`, `audio`,
 *   and `videos`, as Clef, clef-omni, and LiteLLM take them.
 * - `decisions`: OpenAI's Decisions API (`POST /v1/decisions`). A request has an `input` and a list of
 *   `predicate` questions; answers come back as a list, each a probability or a refusal. With images, the
 *   input is one user message: an `input_image` part per image, then the state as `input_text`. It takes
 *   no audio or video.
 * - `gemini`: Google's Decisions API for Gemini Decision (`POST /v1beta/decisions` on
 *   `generativelanguage.googleapis.com`). A request has an `input` and `noul` questions keyed by id, whose
 *   criteria are `true_description` and `false_description`; the key goes in `x-goog-api-key`. A request
 *   its safety filters block is answered with HTTP 400 instead, which declines every question in it. With
 *   media, the input is a list of content blocks: an `image`, `audio`, or `video` block per file, in base64,
 *   then the state as `text`.
 */
export type Format = "system-one" | "decisions" | "gemini"

/** A media file of a request, read and encoded for its body. */
interface Encoded extends Medium {
  readonly base64: string
}

const dataUrl = (medium: Encoded) => `data:${medium.type};base64,${medium.base64}`

/** A response, read: each question's probability of yes, or `declined`, by id, and the input tokens it reports. */
interface Reply {
  readonly answers: ReadonlyMap<string, number | "declined">
  readonly inputTokens: number | undefined
}

interface Wire {
  /** The request body up to its first question, with its media. */
  readonly head: (model: string, state: string, media: ReadonlyArray<Encoded>) => string
  /** The kinds of media a request in this format can carry. */
  readonly takes: ReadonlyArray<MediaKind>
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

// Clef's and clef-omni's names for the lists of each kind of media; a list with no files is left out.
const systemOneMedia = (media: ReadonlyArray<Encoded>) => {
  const of = (kind: MediaKind) => media.filter((medium) => medium.kind === kind).map(dataUrl)
  const [images, audio, videos] = [of("image"), of("audio"), of("video")]
  return {
    ...(images.length === 0 ? {} : { images }),
    ...(audio.length === 0 ? {} : { audio }),
    ...(videos.length === 0 ? {} : { videos })
  }
}

const systemOne: Wire = {
  head: (model, state, media) => `${JSON.stringify({ model, ...systemOneMedia(media), state }).slice(0, -1)},"questions":{`,
  takes: mediaKinds,
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

const decisionsInput = (state: string, media: ReadonlyArray<Encoded>) =>
  media.length === 0 ? state : [{
    role: "user",
    content: [
      ...media.map((medium) => ({ type: "input_image", image_url: dataUrl(medium) })),
      { type: "input_text", text: state }
    ]
  }]

const decisions: Wire = {
  head: (model, state, media) => `${JSON.stringify({ model, input: decisionsInput(state, media) }).slice(0, -1)},"questions":[`,
  takes: ["image"],
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

const geminiInput = (state: string, media: ReadonlyArray<Encoded>) =>
  media.length === 0 ? state : [
    ...media.map((medium) => ({ type: medium.kind, data: medium.base64, mime_type: medium.type })),
    { type: "text", text: state }
  ]

const gemini: Wire = {
  head: (model, state, media) => `${JSON.stringify({ model, input: geminiInput(state, media) }).slice(0, -1)},"questions":{`,
  takes: mediaKinds,
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
  /**
   * The kinds of media it takes, when known; otherwise any its format can carry is sent, and the endpoint
   * says whether it takes them.
   */
  readonly media?: ReadonlyArray<MediaKind> | undefined
}

/**
 * A decision model and how to reach it: the endpoint requests are POSTed to, and the API key or token, if
 * any (a bearer token, or for Gemini `x-goog-api-key`).
 */
export interface Target extends Model {
  readonly url: string
  readonly token: Redacted.Redacted<string> | undefined
}

// What Cloudflare's decision models take besides text: clef-omni reads images, audio, and video; Clef and
// Clef-flash read images.
const workersAiMedia: Record<string, ReadonlyArray<MediaKind>> = {
  clef: ["image"],
  "clef-flash": ["image"],
  "clef-omni": mediaKinds
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
    inputTokenPrice: model === "clef" ? clefInputTokenPrice : undefined,
    media: workersAiMedia[model]
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

// A model behind a System One endpoint may take any media or none, so its endpoint decides; OpenAI's and
// Gemini's Decisions APIs take what their format can carry.
const endpointModel = (url: string, model: string): Model => ({
  format: formatOf(url),
  model,
  name: model,
  cacheKey: `${url} ${model}`,
  inputTokenPrice: undefined,
  media: undefined
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

type Choice =
  | { readonly kind: "endpoint"; readonly url: string; readonly model: string; readonly token: Redacted.Redacted<string> | undefined }
  | { readonly kind: "workers-ai"; readonly model: string }

/** Optional secondary model (`LINT_ANYTHING_SECONDARY_*`) for cross-family cascading on uncertain items. */
const secondaryChoice: Effect.Effect<Option.Option<Choice>, DecisionModelError> = Effect.gen(function*() {
  const endpoint = yield* setting("LINT_ANYTHING_SECONDARY_ENDPOINT")
  const model = yield* setting("LINT_ANYTHING_SECONDARY_MODEL")
  const apiKey = yield* setting("LINT_ANYTHING_SECONDARY_API_KEY")
  if (Option.isSome(endpoint)) {
    if (!isHttpUrl(endpoint.value)) {
      return yield* configError(
        `LINT_ANYTHING_SECONDARY_ENDPOINT must be an http or https URL, such as http://localhost:4000/v1/systemone`
      )
    }
    if (Option.isNone(model)) {
      return yield* configError(
        `LINT_ANYTHING_SECONDARY_MODEL is not set; LINT_ANYTHING_SECONDARY_ENDPOINT needs the name of the model to ask`
      )
    }
    return Option.some<Choice>({
      kind: "endpoint",
      url: endpoint.value,
      model: model.value,
      token: Option.getOrUndefined(Option.map(apiKey, Redacted.make))
    })
  }
  if (Option.isSome(apiKey)) {
    return yield* configError(
      "LINT_ANYTHING_SECONDARY_API_KEY is set but LINT_ANYTHING_SECONDARY_ENDPOINT is not; set the endpoint the key is for (Clef on Workers AI uses CLOUDFLARE_AUTH_TOKEN)"
    )
  }
  if (Option.isNone(model)) return Option.none()
  const name = model.value
  if (!/^[\w.-]+$/.test(name)) {
    return yield* configError(
      `LINT_ANYTHING_SECONDARY_MODEL ${name} is not a Cloudflare model; to ask it, set LINT_ANYTHING_SECONDARY_ENDPOINT to the decision endpoint that serves it`
    )
  }
  return Option.some<Choice>({ kind: "workers-ai", model: name })
})

const resolveWorkersAi = (model: string): Effect.Effect<Target, DecisionModelError> =>
  Effect.gen(function*() {
    const required = <A>(name: string, config: Config.Config<A>) =>
      config.pipe(Effect.mapError(() => configError(`${name} is not set; set it in the environment or in .env`)))
    const accountId = yield* required("CLOUDFLARE_ACCOUNT_ID", Config.String("CLOUDFLARE_ACCOUNT_ID"))
    const token = yield* required("CLOUDFLARE_AUTH_TOKEN", Config.Redacted("CLOUDFLARE_AUTH_TOKEN"))
    const baseUrl = yield* Config.String("CLOUDFLARE_API_BASE_URL").pipe(
      Config.withDefault(defaultCloudflareBaseUrl),
      Effect.mapError((error) => configError(`CLOUDFLARE_API_BASE_URL: ${error.message}`))
    )
    return workersAiTarget({ accountId, token, model, baseUrl })
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
  return yield* resolveWorkersAi(chosen.model)
})

/**
 * The optional secondary decision model the environment configures for cascading (`LINT_ANYTHING_SECONDARY_ENDPOINT`,
 * `LINT_ANYTHING_SECONDARY_MODEL`, `LINT_ANYTHING_SECONDARY_API_KEY`). Returns `Option.none()` when unset.
 * Setting `LINT_ANYTHING_SECONDARY_MODEL` alone (for example `clef`) asks that Cloudflare model on Workers AI.
 */
export const configuredSecondaryTarget: Effect.Effect<Option.Option<Target>, DecisionModelError> = Effect.gen(function*() {
  const chosen = yield* secondaryChoice
  if (Option.isNone(chosen)) return Option.none()
  if (chosen.value.kind === "endpoint") return Option.some(endpointTarget(chosen.value))
  return Option.some(yield* resolveWorkersAi(chosen.value.model))
})

// --- Packing ----------------------------------------------------------------------------------------

/**
 * One request: its exact body, the media its questions show (by path), and what each question id answers.
 * The body of a request with media leaves them out; they are read, and put where its format takes them,
 * when it is sent.
 */
export interface Planned<A> {
  readonly body: string
  readonly media: ReadonlyArray<string>
  readonly questions: ReadonlyArray<{ readonly id: string; readonly value: A }>
}

/**
 * Packs one question per value, in order, into as few requests sharing `state` and `media` as the question
 * and byte limits allow, laid out for `model`. Question ids are `i0`, `i1`, … within each request. A value
 * too large to send even alone is returned in `oversized`. The byte limit is on the text: media are
 * limited apart (`media.ts`).
 */
const pack = <A>(
  model: Pick<Model, "format" | "model">,
  state: string,
  media: ReadonlyArray<string>,
  values: ReadonlyArray<A>,
  question: (value: A) => Question
) => {
  const wire = wires[model.format]
  // The body is assembled from serialized parts so each request's exact size is known while packing.
  const head = wire.head(model.model, state, [])
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
    if (questions.length > 0) requests.push({ body: `${head}${entries.join(",")}${wire.tail}`, media, questions })
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
 * as fit, laid out for `model` (default: Clef). A request shows its media for every question in it, so
 * questions share one only with questions showing the same media; groups are planned in order of their
 * first question. Planned questions answer by index into `questions`.
 */
export const planRequests = (state: string, questions: ReadonlyArray<Question>, model: Pick<Model, "format" | "model"> = clef) => {
  const groups = new Map<string, Array<number>>()
  questions.forEach((question, index) => {
    const key = JSON.stringify(question.media ?? [])
    const group = groups.get(key)
    if (group === undefined) groups.set(key, [index])
    else group.push(index)
  })
  const requests: Array<Planned<number>> = []
  const oversized: Array<{ readonly value: number; readonly bytes: number }> = []
  for (const indexes of groups.values()) {
    const media = questions[indexes[0]!]!.media ?? []
    const planned = pack(model, state, media, indexes, (index) => questions[index]!)
    requests.push(...planned.requests)
    oversized.push(...planned.oversized)
  }
  return { requests, oversized }
}

/** `body`, planned without media, with `media` encoded where `model`'s format takes them. */
const withMedia = (model: Pick<Model, "format" | "model">, state: string, body: string, media: ReadonlyArray<Encoded>) => {
  const head = wires[model.format].head
  return `${head(model.model, state, media)}${body.slice(head(model.model, state, []).length)}`
}

// --- Answer cache -----------------------------------------------------------------------------------

/** What a question's media add to its cache key: each file's type and contents, in order; empty without media. */
const mediaPrint = (media: ReadonlyArray<Medium>) => media.map((medium) => `${medium.type} ${medium.digest}`).join("\0")

/** A question's answer, to cache, with its media's `mediaPrint`. */
interface Answered {
  readonly question: Question
  readonly print: string
  readonly noul: number
}

/**
 * Answers kept on disk in one SQLite database, one row per question, keyed by the model's cache key, the
 * request text, the question (not its id or the other questions in the request), and the contents of its
 * media (`mediaPrint`), so unchanged questions aren't sent again. Opening it deletes answers older than
 * `cacheMaxAgeMs` at `now`, so they are asked again.
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
  // A question without media keys as it did before media, so caches from then still hit.
  const key = (state: string, question: Question, print: string): Uint8Array =>
    new Bun.CryptoHasher("sha256").update(
      `${model.cacheKey}\0${state}\0${JSON.stringify(noul(question))}${print === "" ? "" : `\0${print}`}`
    ).digest()
  // One transaction per request's answers: a run stopped later keeps every answer it received.
  const insert = db.transaction((state: string, answers: ReadonlyArray<Answered>) => {
    const answered = Date.now()
    for (const { question, print, noul } of answers) upsert.run(key(state, question, print), noul, answered)
  })
  const failed = (error: unknown) =>
    new DecisionModelError({ message: `answer cache ${join(directory, cacheFile)}: ${error instanceof Error ? error.message : String(error)}` })
  return {
    /** Each question's cached answer, or `undefined` when it has none; `prints` are their media's, in order. */
    get: (state: string, questions: ReadonlyArray<Question>, prints: ReadonlyArray<string>) =>
      Effect.try({ try: () => questions.map((question, index) => select.get(key(state, question, prints[index]!))?.noul), catch: failed }),
    set: (state: string, answers: ReadonlyArray<Answered>) => Effect.try({ try: () => insert(state, answers), catch: failed }),
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

/** Extracts Google API JSON `"retryDelay": "Xs"` when a 429 response lacks a `Retry-After` header. */
const jsonRetryDelayMs = (text: string): number | undefined => {
  const match = /"retryDelay":\s*"(\d+(?:\.\d+)?)s"/.exec(text)
  return match === null ? undefined : Math.ceil(Number(match[1]) * 1000)
}

/** Configuration for cascading two decision models: a fast primary and a secondary tiebreaker. */
export interface CascadeOptions {
  /** Primary probabilities below `low` are accepted directly without calling `secondary` (default: 0.10). */
  readonly low?: number
  /** Primary probabilities above `high` are accepted directly without calling `secondary` (default: 0.90). */
  readonly high?: number
  /** Combines primary and secondary probabilities for items sent to both (default: arithmetic mean). */
  readonly combine?: (primary: number, secondary: number) => number
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
   * The decision model the environment configures (`configuredTarget`): Clef on Workers AI by default, or
   * a cross-family cascade when `LINT_ANYTHING_SECONDARY_*` (`configuredSecondaryTarget`) is also set.
   * With `cacheDirectory`, answers are cached in a database there per question across runs, and answers
   * older than `cacheMaxAgeMs` are deleted and asked again.
   */
  static readonly layer = (cacheDirectory?: string) =>
    Layer.effect(
      DecisionModel,
      Effect.gen(function*() {
        const primary = yield* configuredTarget
        const secondary = yield* configuredSecondaryTarget
        if (Option.isNone(secondary)) return yield* make(primary, cacheDirectory)
        if (secondary.value.cacheKey === primary.cacheKey) {
          return yield* configError(
            `secondary decision model (${secondary.value.name}) is the same as the primary model; use a different model for cascading`
          )
        }
        return yield* makeCascade(primary, secondary.value, cacheDirectory)
      })
    ).pipe(Layer.provide(FetchHttpClient.layer))

  /** `target`, whatever the environment says; answers are cached as with `layer`. */
  static readonly layerFor = (target: Target, cacheDirectory?: string) =>
    Layer.effect(DecisionModel, make(target, cacheDirectory)).pipe(Layer.provide(FetchHttpClient.layer))

  /**
   * Cross-family cascade: asks `primary` first, and asks `secondary` only for questions whose primary
   * probability lands in `[low, high]`, combining both probabilities with `combine` (default: mean).
   * Combines `stats` from both models.
   */
  static readonly cascadeLayer = (
    primary: Target,
    secondary: Target,
    cacheDirectory?: string,
    options?: CascadeOptions
  ) =>
    Layer.effect(DecisionModel, makeCascade(primary, secondary, cacheDirectory, options)).pipe(
      Layer.provide(FetchHttpClient.layer)
    )
}

const makeCascade = Effect.fnUntraced(function*(
  primaryTarget: Target,
  secondaryTarget: Target,
  cacheDirectory: string | undefined,
  options?: CascadeOptions
) {
  const low = options?.low ?? 0.10
  const high = options?.high ?? 0.90
  const combine = options?.combine ?? ((a: number, b: number) => (a + b) / 2)
  const primary = yield* make(primaryTarget, cacheDirectory)
  const secondary = yield* make(secondaryTarget, cacheDirectory)
  return DecisionModel.of({
    target: {
      ...primary.target,
      name: `${primary.target.name}+${secondary.target.name}`,
      cacheKey: `${primary.target.cacheKey}+${secondary.target.cacheKey}`,
      inputTokenPrice: undefined
    },
    ask: Effect.fn("DecisionModel.cascade.ask")(function*(source, state, questions) {
      const first = [...(yield* primary.ask(source, state, questions))]
      const escalate: Array<number> = []
      first.forEach((result, index) => {
        if (Result.isSuccess(result) && result.success >= low && result.success <= high) {
          escalate.push(index)
        }
      })
      if (escalate.length === 0) return first
      const second = yield* secondary.ask(source, state, escalate.map((index) => questions[index]!))
      escalate.forEach((origIndex, subIndex) => {
        const a = first[origIndex]!
        const b = second[subIndex]!
        if (Result.isSuccess(a) && Result.isSuccess(b)) {
          first[origIndex] = Result.succeed(combine(a.success, b.success))
        }
      })
      return first
    }),
    stats: Effect.map(Effect.all([primary.stats, secondary.stats]), ([a, b]) => {
      const merged = new Map<string, Usage>(a)
      for (const [source, usage] of b) {
        merged.set(source, sumUsage([merged.get(source) ?? noUsage, usage]))
      }
      return merged
    })
  })
})

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
    // times out, and is retried, like a stalled response. When a 429 carries Google's JSON `retryDelay`
    // without a `Retry-After` header, wait it out so the next attempt respects the quota window.
    HttpClient.transformResponse(flow(
      Effect.tap((response) => response.text),
      Effect.timeout(attemptTimeout),
      Effect.tapError((error) => {
        if (!HttpClientError.isHttpClientError(error) || error.reason._tag !== "StatusCodeError") return Effect.void
        const { response } = error.reason
        if (response.status !== 429 || response.headers["retry-after"] !== undefined) return Effect.void
        return response.text.pipe(
          Effect.timeout("5 seconds"),
          Effect.flatMap((text) => {
            const delayMs = jsonRetryDelayMs(text)
            return delayMs !== undefined && delayMs > 0 ? Effect.sleep(delayMs) : Effect.void
          }),
          Effect.orElseSucceed(() => undefined)
        )
      })
    )),
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

  /** Reads each media file the questions show, once, to key the cache by its contents. */
  const readMedia = (questions: ReadonlyArray<Question>) =>
    Effect.forEach(
      [...new Set(questions.flatMap((question) => question.media ?? []))],
      (path) =>
        Effect.tryPromise({
          try: () => readMedium(path),
          catch: (error) =>
            new DecisionModelError({ message: `cannot read media ${path}: ${error instanceof Error ? error.message : String(error)}` })
        })
    ).pipe(Effect.map((media) => new Map(media.map((medium) => [medium.path, medium]))))

  // The kinds of media the model takes: what it is known to take, else any its format can carry.
  const takes = (kind: MediaKind) => wire.takes.includes(kind) && (target.media?.includes(kind) ?? true)
  const taken = ["text", ...mediaKinds.filter(takes).map((kind) => mediaNoun[kind])]
  const takenList = taken.length <= 2 ? taken.join(" and ") : `${taken.slice(0, -1).join(", ")}, and ${taken.at(-1)}`
  const notTaken = (medium: Medium) =>
    new DecisionModelError({ message: `${target.name} takes ${takenList}, not ${mediaNoun[medium.kind]}: ${medium.path}` })

  /** Why a question's media are too large to send, if they are: an image, or all of them together. */
  const mediaTooLarge = (media: ReadonlyArray<Medium>) => {
    const image = media.find((medium) => medium.kind === "image" && medium.bytes > maxImageBytes)
    if (image !== undefined) {
      return new RequestTooLarge({
        bytes: image.bytes,
        message: `image ${image.path} is ${image.bytes} bytes, over the ${maxImageBytes}-byte image limit`
      })
    }
    const bytes = media.reduce((sum, medium) => sum + medium.bytes, 0)
    return bytes > maxMediaBytes
      ? new RequestTooLarge({ bytes, message: `media are ${bytes} bytes, over the ${maxMediaBytes}-byte media limit` })
      : undefined
  }

  /** `request`'s body, its media read and encoded into it. */
  const bodyOf = <A>(state: string, request: Planned<A>, media: ReadonlyMap<string, Medium>) =>
    request.media.length === 0 ? Effect.succeed(request.body) : Effect.tryPromise({
      try: async () => {
        const encoded = await Promise.all(request.media.map(async (path) => {
          const medium = media.get(path)!
          return { ...medium, base64: await mediaBase64(medium) }
        }))
        return withMedia(target, state, request.body, encoded)
      },
      catch: (error) => new DecisionModelError({ message: `cannot read media: ${error instanceof Error ? error.message : String(error)}` })
    })

  /**
   * Sends one planned request under `state` for `source` and returns each question's answer, keyed like
   * `request.questions`. Its media are read while it holds a permit, so at most as many requests' media
   * are in memory as requests are in flight.
   */
  const send = Effect.fn("DecisionModel.send")(function*<A>(
    source: string,
    state: string,
    request: Planned<A>,
    media: ReadonlyMap<string, Medium>
  ) {
    const post = (body: string) =>
      HttpClientRequest.post(target.url).pipe(
        HttpClientRequest.bodyText(body, "application/json"),
        client.execute,
        Effect.flatMap((response) => response.json),
        Effect.flatMap(wire.decode),
        Effect.catch((error) =>
          Effect.flatMap(declinesAll(error), (all): Effect.Effect<Reply, DecisionModelError> =>
            all
              ? Effect.succeed({ answers: new Map(request.questions.map(({ id }) => [id, "declined"])), inputTokens: undefined })
              : Effect.flatMap(failureMessage(target.name, error), (message) => Effect.fail(new DecisionModelError({ message }))))
        )
      )
    const reply: Reply = yield* record(source, { requests: 1 }).pipe(
      Effect.andThen(bodyOf(state, request, media)),
      Effect.flatMap(post),
      permits.withPermit
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
    const media = yield* readMedia(questions)
    const mediaOf = (question: Question) => (question.media ?? []).map((path) => media.get(path)!)
    const prints = questions.map((question) => mediaPrint(mediaOf(question)))
    const results: Array<Result.Result<number, Unanswered>> = []
    const misses: Array<number> = []
    const cached = cache === undefined ? [] : yield* cache.get(state, questions, prints)
    questions.forEach((_, index) => {
      const answer = cached[index]
      if (answer === undefined) misses.push(index)
      else results[index] = Result.succeed(answer)
    })
    if (misses.length < questions.length) yield* record(source, { cached: questions.length - misses.length })
    // Media the model can't take stop the run before anything is sent; media too large to send leave
    // their question unanswered.
    const sendable: Array<number> = []
    for (const index of misses) {
      const shown = mediaOf(questions[index]!)
      const untaken = shown.find((medium) => !takes(medium.kind))
      if (untaken !== undefined) return yield* notTaken(untaken)
      const tooMuch = mediaTooLarge(shown)
      if (tooMuch === undefined) sendable.push(index)
      else results[index] = Result.fail(tooMuch)
    }
    // Deduplicate identical misses within this call so repeated items aren't asked twice in one batch.
    const uniqueSendable: Array<number> = []
    const duplicates = new Map<number, Array<number>>()
    const byFingerprint = new Map<string, number>()
    for (const index of sendable) {
      const fingerprint = `${JSON.stringify(noul(questions[index]!))}\0${prints[index]!}`
      const leader = byFingerprint.get(fingerprint)
      if (leader === undefined) {
        const slot = uniqueSendable.length
        byFingerprint.set(fingerprint, slot)
        uniqueSendable.push(index)
        duplicates.set(slot, [index])
      } else {
        duplicates.get(leader)!.push(index)
      }
    }
    // Joint-attention System One models (such as Clef) lose substantial accuracy on 1-item warm-cache
    // requests (evals/warm-pad.ts: -0.116 Item AUROC). When a warm cache leaves only 1-4 text misses,
    // pad the batch up to 5 questions with small already-cached siblings from the same policy and discard
    // the siblings' new answers so cached verdicts stay frozen while misses keep packed-batch accuracy.
    const minWarmBatch = 5
    const paddingIndices: Array<number> = []
    if (
      target.format === "system-one" &&
      uniqueSendable.length > 0 &&
      uniqueSendable.length < minWarmBatch &&
      uniqueSendable.every((index) => (questions[index]!.media?.length ?? 0) === 0)
    ) {
      const siblingPool: Array<number> = []
      for (let i = 0; i < questions.length; i++) {
        if (cached[i] !== undefined && (questions[i]!.media?.length ?? 0) === 0 && questions[i]!.instructions.length <= 4_000) {
          siblingPool.push(i)
        }
      }
      const needed = minWarmBatch - uniqueSendable.length
      if (siblingPool.length > 0) {
        const step = Math.max(1, Math.floor(siblingPool.length / needed))
        for (let i = 0; i < siblingPool.length && paddingIndices.length < needed; i += step) {
          paddingIndices.push(siblingPool[i]!)
        }
      }
    }
    let paddingOffset = paddingIndices.length
    let planned = planRequests(
      state,
      [...paddingIndices.map((index) => questions[index]!), ...uniqueSendable.map((index) => questions[index]!)],
      target
    )
    // Only keep sibling padding when it fits inside one request alongside the misses; never add an extra request.
    if (paddingOffset > 0 && planned.requests.length > 1) {
      paddingOffset = 0
      planned = planRequests(state, uniqueSendable.map((index) => questions[index]!), target)
    }
    const { requests, oversized } = planned
    for (const { value, bytes } of oversized) {
      if (value < paddingOffset) continue
      const failure = Result.fail(tooLarge(bytes))
      for (const index of duplicates.get(value - paddingOffset)!) results[index] = failure
    }
    // `permits` bounds requests in flight across the run. Each request's answers are cached as it
    // returns, so a run that fails later keeps every answer it received. A declined question isn't
    // cached: it is asked again next run.
    yield* Effect.forEach(requests, (request) =>
      send(source, state, request, media).pipe(Effect.tap((received) => {
        const answered: Array<Answered> = []
        for (const { value, answer } of received) {
          if (value < paddingOffset) continue
          const targets = duplicates.get(value - paddingOffset)!
          const leader = targets[0]!
          if (answer === "declined") {
            const failure = Result.fail(declined)
            for (const index of targets) results[index] = failure
          } else {
            const success = Result.succeed(answer)
            for (const index of targets) results[index] = success
            answered.push({ question: questions[leader]!, print: prints[leader]!, noul: answer })
          }
        }
        return cache === undefined || answered.length === 0 ? Effect.void : cache.set(state, answered)
      })), { concurrency: "unbounded", discard: true })
    return results
  })

  return DecisionModel.of({ target, ask, stats: Ref.get(usage) })
})
