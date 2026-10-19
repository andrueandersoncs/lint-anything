import { Config, Context, Effect, flow, Layer, Runtime, Schedule, Schema } from "effect"
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

// Clef's context is 65,536 tokens; one token is at least one byte, so this never truncates.
const maxRequestBytes = 64_000

const violation =
  "Decide whether `file`, read in light of `path`, contains at least one violation of the appended rule.\n" +
  "Use only the rule, path, and shown file. First check that the rule applies to this file and the content at issue. For each concrete candidate, test every required condition, qualifier, exception, scope limit, and explicit reporting direction. Answer yes only if one candidate meets the complete violation test.\n" +
  "Do not invent unseen uses, definitions, control flow, runtime behavior, or intent. Names, imports, types, comments, patterns, and absent evidence establish a fact only when the rule makes them decisive. If a necessary fact is merely possible or depends on unseen content, answer no.\n" +
  "Distinguish code from commentary and examples when relevant. Apply exemptions to each candidate independently. One complete violation is enough; compliant content elsewhere does not cancel it. Return a calibrated probability that the answer is yes.\n\nRule:\n"

const Noul = Schema.Struct({
  noul: Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 }))
})

// Workers AI wraps every model response in `result`.
const ClefResponse = Schema.Struct({
  result: Schema.Struct({
    answers: Schema.Struct({ violates: Noul })
  })
})

const requestBody = (model: Model, file: SourceFile, policy: Policy) =>
  JSON.stringify({
    model,
    state: { path: file.path, file: file.source },
    questions: {
      violates: { type: "noul", instructions: violation + policy.source }
    }
  })

export class Clef extends Context.Service<Clef, {
  judge(file: SourceFile, policy: Policy): Effect.Effect<Judgment, ClefError | RequestTooLarge>
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

        const judge = Effect.fn("Clef.judge")(function*(file: SourceFile, policy: Policy) {
          const body = requestBody(model, file, policy)
          const bytes = Buffer.byteLength(body)
          if (bytes > maxRequestBytes) {
            return yield* new RequestTooLarge({ bytes })
          }
          const { result } = yield* HttpClientRequest.post(`/${model}`).pipe(
            HttpClientRequest.bodyText(body, "application/json"),
            client.execute,
            Effect.flatMap(HttpClientResponse.schemaBodyJson(ClefResponse)),
            Effect.mapError((cause) => new ClefError({ cause }))
          )
          return { violates: result.answers.violates.noul }
        })

        return Clef.of({ judge })
      })
    ).pipe(Layer.provide(FetchHttpClient.layer))
}
