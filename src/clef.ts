import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { Config, Context, Effect, flow, Layer, Ref, Result, Runtime, Schedule, Schema } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http"
import type { Item } from "./item.ts"
import type { Policy } from "./policy.ts"
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

/** The request text and one policy's question, for judging an excerpt (or whole file). */
const fileState = (file: SourceFile) => `${guidance}\n\npath: ${file.path}\n\nfile:\n${file.source}`
const fileQuestion = (policy: Policy) => ({ type: "noul", instructions: `Rule:\n${policy.source}`, criteria })

/**
 * Plans the requests that judge one excerpt (or whole file) against `policies`: the text once per
 * request and one question per policy.
 */
export const planRequests = (model: Model, file: SourceFile, policies: ReadonlyArray<Policy>) =>
  pack(model, fileState(file), policies, (policy, taken) => serialize(questionId(policy, taken), fileQuestion(policy)))

// Selector items: the eval suite's item sweep (evals/items.ts, see README) chose this shape. The rule goes
// in the state once and each item is one question; one request per item scored worse and cost 2.5×.
const itemGuidance = "Each question shows one item with its location and any context. Decide whether that item " +
  "contains at least one violation of the rule below.\nReturn a calibrated probability that the answer is yes."

export const itemCriteria = {
  true: "The item contains at least one complete violation of the rule.",
  false: "The item follows the rule, or the rule governs nothing in it."
}

/** An item as the judge reads it: where it is, each non-empty evidence field under its name, then the item. */
export const renderItem = (item: Item) =>
  [
    `location: ${item.path ?? item.id}${item.lines === undefined ? "" : ` (lines ${item.lines[0]}-${item.lines[1]})`}`,
    ...item.evidence.flatMap(([name, value]) => (value === "" ? [] : [`${name}:\n${value}`])),
    `item:\n${item.text}`
  ].join("\n\n")

/** The request text and one item's question, for judging a selector's items against a policy. */
const itemState = (policy: Policy) => `${itemGuidance}\n\nRule:\n${policy.source}`
const itemQuestion = (item: Item) => ({ type: "noul", instructions: renderItem(item), criteria: itemCriteria })

/**
 * Plans the requests that judge a selector's `items` against `policy`: the rule once per request and one
 * question per item. Questions answer items by index into `items`.
 */
export const planItemRequests = (model: Model, policy: Policy, items: ReadonlyArray<Item>) =>
  pack(model, itemState(policy), items.map((_, index) => index), (index, taken) => serialize(`i${taken.size}`, itemQuestion(items[index]!)))

// `lint-anything ask`: a yes/no question about each item, the question in the state once and each item
// one question, as for judging items against a rule.
const askGuidance = "Each question shows one item with its location and any context. Answer the question below " +
  "about that item.\nReturn a calibrated probability that the answer is yes."
const askCriteria = { true: "Yes, for this item.", false: "No, for this item." }
const askState = (question: string) => `${askGuidance}\n\nQuestion:\n${question}`
const askQuestion = (item: Item) => ({ type: "noul", instructions: renderItem(item), criteria: askCriteria })

/** Plans the requests that ask `question` about each of `items`. Questions answer items by index. */
export const planAskRequests = (model: Model, question: string, items: ReadonlyArray<Item>) =>
  pack(model, askState(question), items.map((_, index) => index), (index, taken) => serialize(`i${taken.size}`, askQuestion(items[index]!)))

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
  /** The probability that the answer to yes/no `question` is yes, for each of `items`, in order. */
  ask(
    question: string,
    items: ReadonlyArray<Item>
  ): Effect.Effect<ReadonlyArray<Result.Result<number, RequestTooLarge>>, ClefError>
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

        const judge = Effect.fn("Clef.judge")(function*(file: SourceFile, policies: ReadonlyArray<Policy>) {
          // Each policy keeps its highest score across excerpts; it is too large only if no excerpt could send it.
          const scores = new Map<Policy, number>()
          const tooLarge = new Map<Policy, number>()
          for (const excerpt of excerpts(file, excerptBytes)) {
            const { answers, oversized } = yield* answer(
              fileState(excerpt), policies, fileQuestion, (misses) => planRequests(model, excerpt, misses), 1)
            for (const { value: policy, bytes } of oversized) tooLarge.set(policy, Math.max(bytes, tooLarge.get(policy) ?? 0))
            for (const { value: policy, noul } of answers) scores.set(policy, Math.max(noul, scores.get(policy) ?? 0))
          }
          const results: Array<Result.Result<Judgment, RequestTooLarge>> = []
          for (const policy of policies) {
            const violates = scores.get(policy)
            const bytes = tooLarge.get(policy)
            if (violates !== undefined) results.push(Result.succeed({ violates }))
            else if (bytes !== undefined) results.push(Result.fail(new RequestTooLarge({ bytes })))
            // Every policy is answered, cached, or in `oversized` for every excerpt.
            else return yield* Effect.die(new Error(`no judgment for ${policy.name}`))
          }
          return results
        })

        /** Answers one question per item, sharing `state`; results follow `items` order. */
        const each = Effect.fn("Clef.each")(function*(
          state: string,
          items: ReadonlyArray<Item>,
          question: (item: Item) => object,
          plan: (subset: ReadonlyArray<Item>) => ReturnType<typeof planItemRequests>
        ) {
          const { answers, oversized } = yield* answer(
            state,
            items.map((_, index) => index),
            (index) => question(items[index]!),
            (misses) => {
              const planned = plan(misses.map((index) => items[index]!))
              return {
                requests: planned.requests.map(({ body, questions }) => ({ body, questions: questions.map(({ id, value }) => ({ id, value: misses[value]! })) })),
                oversized: planned.oversized.map(({ value, bytes }) => ({ value: misses[value]!, bytes }))
              }
            },
            8
          )
          const results: Array<Result.Result<number, RequestTooLarge>> = []
          for (const { value: index, bytes } of oversized) results[index] = Result.fail(new RequestTooLarge({ bytes }))
          for (const { value: index, noul } of answers) results[index] = Result.succeed(noul)
          return results
        })

        const judgeItems = (policy: Policy, items: ReadonlyArray<Item>) =>
          each(itemState(policy), items, itemQuestion, (subset) => planItemRequests(model, policy, subset)).pipe(
            Effect.map((results) => results.map(Result.map((violates): Judgment => ({ violates }))))
          )

        const ask = (question: string, items: ReadonlyArray<Item>) =>
          each(askState(question), items, askQuestion, (subset) => planAskRequests(model, question, subset))

        return Clef.of({ judge, judgeItems, ask, stats: Ref.get(counts) })
      })
    ).pipe(Layer.provide(FetchHttpClient.layer))
}
