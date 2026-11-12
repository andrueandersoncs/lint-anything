import { Effect, Redacted, Result } from "effect"
import { configuredModel, configuredTarget, declinesAll, decodeReply, keyHeader, type Model } from "../src/decision-model.ts"

/** One reply: each question's probability of yes, or `declined`, by question id. */
export interface Reply {
  readonly answers: ReadonlyMap<string, number | "declined">
  /** Input tokens the model reported for the original request; 0 when it reported none. */
  readonly inputTokens: number
  /** Round-trip time of the original (uncached) request. */
  readonly ms: number
  readonly cached: boolean
}

/**
 * The decision model the evals ask: the one the CLI would, from the same variables (Clef on Workers AI
 * unless `LINT_ANYTHING_ENDPOINT` or `LINT_ANYTHING_MODEL` says otherwise). Bodies are planned for it, and
 * its replies are cached apart from other models'.
 */
export const model: Model = Effect.runSync(configuredModel)
// Credentials are needed only to send: replies already cached are read without them.
const target = Effect.runSync(Effect.result(configuredTarget))

const cacheDirectory = `${import.meta.dir}/.cache`
const attempts = 6
// A rate-limited request (429) is retried this many more times, after the wait the response asks for, so a
// sweep can run at a quota's pace (Gemini's free tier allows 50,000 input tokens a minute).
const rateLimitedAttempts = 30

/** A response that retrying cannot change. */
class Rejected extends Error {}

/** How long a rate-limited response asks to wait: its `Retry-After` header, or a Google error's `retryDelay`. */
const retryDelayMs = (response: Response, text: string): number | undefined => {
  const header = Number(response.headers.get("retry-after"))
  if (header > 0) return header * 1000
  const match = /"retryDelay":\s*"(\d+(?:\.\d+)?)s"/.exec(text)
  return match === null ? undefined : Number(match[1]) * 1000
}

/** The question ids in a request body: System One and Gemini key questions by id, OpenAI Decisions names them. */
const questionIds = (body: string): Array<string> => {
  const { questions } = JSON.parse(body) as { readonly questions: Record<string, unknown> | ReadonlyArray<{ readonly name: string }> }
  return Array.isArray(questions) ? questions.map(({ name }) => name) : Object.keys(questions)
}

/** A sent request's outcome as cached: the response body, its time, and whether it declined every question. */
interface Sent {
  readonly json: unknown
  readonly ms: number
  readonly declined?: true
}

/**
 * Sends requests to the decision model with bounded concurrency and caches replies by the model's cache key
 * and exact body (for Clef, its name: the keys replies were cached under before other models). A decision
 * model is deterministic for a given body, so a cached reply stands in for a fresh one.
 */
export const makeClient = (concurrency: number) => {
  let active = 0
  const waiting: Array<() => void> = []
  const acquire = async () => {
    if (active >= concurrency) await new Promise<void>((resolve) => waiting.push(resolve))
    active++
  }
  const release = () => {
    active--
    waiting.shift()?.()
  }

  const send = async (body: string): Promise<Sent> => {
    if (Result.isFailure(target)) throw new Error(target.failure.message)
    const { url, token } = target.success
    const headers: Record<string, string> = { "content-type": "application/json" }
    if (token !== undefined) {
      const [name, value] = keyHeader(model.format, Redacted.value(token))
      headers[name] = value
    }
    let rateLimited = 0
    for (let attempt = 1; ; attempt++) {
      const started = performance.now()
      let retryable: string
      let wait: number | undefined
      try {
        const response = await fetch(url, { method: "POST", headers, body })
        const text = await response.text()
        const ms = performance.now() - started
        if (response.ok) return { json: JSON.parse(text), ms }
        if (declinesAll(model.format, response.status, text)) return { json: JSON.parse(text), ms, declined: true }
        // 4006: the account's daily Workers AI allocation is spent; retrying cannot help.
        if ((response.status !== 429 && response.status < 500) || text.includes('"code":4006')) {
          throw new Rejected(`${model.name} ${response.status}: ${text.slice(0, 500)}`)
        }
        retryable = `${response.status}: ${text.slice(0, 300)}`
        if (response.status === 429 && rateLimited < rateLimitedAttempts) {
          rateLimited++
          attempt--
          wait = retryDelayMs(response, text) ?? 5_000 * rateLimited
        }
      } catch (error) {
        if (error instanceof Rejected) throw error
        retryable = String(error)
      }
      if (attempt === attempts) throw new Error(`${model.name} failed after ${attempts} attempts: ${retryable}`)
      await Bun.sleep(wait ?? 500 * 2 ** attempt)
    }
  }

  return async (body: string): Promise<Reply> => {
    const key = new Bun.CryptoHasher("sha256").update(model.cacheKey).update("\0").update(body).digest("hex")
    const cacheFile = Bun.file(`${cacheDirectory}/${key.slice(0, 2)}/${key}.json`)
    if (await cacheFile.exists()) return reply(body, await cacheFile.json(), true)
    await acquire()
    try {
      const sent = await send(body)
      await Bun.write(cacheFile, JSON.stringify(sent))
      return reply(body, sent, false)
    } finally {
      release()
    }
  }
}

const reply = (body: string, { json, ms, declined }: Sent, cached: boolean): Reply => {
  // A request whose every question was declined (Gemini's safety filters) reports no tokens.
  if (declined === true) return { answers: new Map(questionIds(body).map((id) => [id, "declined"])), inputTokens: 0, ms, cached }
  const decoded = Effect.runSync(Effect.result(decodeReply(model.format, json)))
  if (Result.isFailure(decoded)) {
    throw new Error(`unexpected ${model.name} reply: ${JSON.stringify(json).slice(0, 500)}`)
  }
  return { answers: decoded.success.answers, inputTokens: decoded.success.inputTokens ?? 0, ms, cached }
}
