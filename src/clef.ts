import { Config, Context, Effect, flow, Layer, Result, Runtime, Schedule, Schema } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http"
import type { Policy } from "./policy.ts"
import type { SourceFile } from "./source.ts"

export type Model = "clef" | "clef-flash"

/** Probability that the file violates a policy. */
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

const questionEntry = (policy: Policy, taken: ReadonlySet<string>) => {
  const id = questionId(policy, taken)
  const text = `${JSON.stringify(id)}:${
    JSON.stringify({ type: "noul", instructions: `Rule:\n${policy.source}`, criteria })
  }`
  return { id, text, bytes: Buffer.byteLength(text) }
}

/** One Clef request: its exact body and the policy each question id answers. */
export interface PlannedRequest {
  readonly body: string
  readonly questions: ReadonlyArray<{ readonly id: string; readonly policy: Policy }>
}

/**
 * Plans the requests that judge one excerpt (or whole file) against `policies`. Each request carries the
 * text once and one question per policy; policies are packed in order into as few requests as Clef's
 * 64-question limit and the model's byte limit allow. A policy too large to send even alone is returned
 * in `oversized`.
 */
export const planRequests = (model: Model, file: SourceFile, policies: ReadonlyArray<Policy>) => {
  const state = `${guidance}\n\npath: ${file.path}\n\nfile:\n${file.source}`
  // The body is assembled from serialized parts so each request's exact size is known while packing.
  const head = `${JSON.stringify({ model, state }).slice(0, -1)},"questions":{`
  const tail = "}}"
  const fixedBytes = Buffer.byteLength(head) + tail.length
  const limit = maxRequestBytes[model]
  const requests: Array<PlannedRequest> = []
  const oversized: Array<{ readonly policy: Policy; readonly bytes: number }> = []
  let entries: Array<string> = []
  let questions: Array<{ readonly id: string; readonly policy: Policy }> = []
  let taken = new Set<string>()
  let bytes = fixedBytes
  const flush = () => {
    if (questions.length > 0) requests.push({ body: `${head}${entries.join(",")}${tail}`, questions })
    entries = []
    questions = []
    taken = new Set()
    bytes = fixedBytes
  }
  for (const policy of policies) {
    const alone = questionEntry(policy, new Set())
    if (fixedBytes + alone.bytes > limit) {
      oversized.push({ policy, bytes: fixedBytes + alone.bytes })
      continue
    }
    let next = questionEntry(policy, taken)
    if (questions.length === maxQuestions || bytes + ",".length + next.bytes > limit) {
      flush()
      next = alone
    }
    bytes += (questions.length === 0 ? 0 : ",".length) + next.bytes
    entries.push(next.text)
    questions.push({ id: next.id, policy })
    taken.add(next.id)
  }
  flush()
  return { requests, oversized }
}

export class Clef extends Context.Service<Clef, {
  /** Judges `file` against every policy, excerpt by excerpt; results follow `policies` order. */
  judge(
    file: SourceFile,
    policies: ReadonlyArray<Policy>
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

        const judge = Effect.fn("Clef.judge")(function*(file: SourceFile, policies: ReadonlyArray<Policy>) {
          // Each policy keeps its highest score across excerpts; it is too large only if no excerpt could send it.
          const scores = new Map<Policy, number>()
          const tooLarge = new Map<Policy, number>()
          for (const excerpt of excerpts(file, excerptBytes)) {
            const { requests, oversized } = planRequests(model, excerpt, policies)
            for (const { policy, bytes } of oversized) tooLarge.set(policy, Math.max(bytes, tooLarge.get(policy) ?? 0))
            for (const request of requests) {
              const { result } = yield* HttpClientRequest.post(`/${model}`).pipe(
                HttpClientRequest.bodyText(request.body, "application/json"),
                client.execute,
                Effect.flatMap(HttpClientResponse.schemaBodyJson(ClefResponse)),
                Effect.mapError((cause) => new ClefError({ cause }))
              )
              for (const { id, policy } of request.questions) {
                const answer = result.answers[id]
                if (answer === undefined) {
                  return yield* new ClefError({ cause: new Error(`Clef returned no answer for ${id}`) })
                }
                scores.set(policy, Math.max(answer.noul, scores.get(policy) ?? 0))
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

        return Clef.of({ judge })
      })
    ).pipe(Layer.provide(FetchHttpClient.layer))
}
