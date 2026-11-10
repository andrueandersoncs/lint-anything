import { Effect, Redacted, Result } from "effect"
import { configuredModel, configuredTarget, decodeReply, type Model } from "../src/decision-model.ts"

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

/** A response that retrying cannot change. */
class Rejected extends Error {}

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

  const send = async (body: string): Promise<{ json: unknown; ms: number }> => {
    if (Result.isFailure(target)) throw new Error(target.failure.message)
    const { url, token } = target.success
    for (let attempt = 1; ; attempt++) {
      const started = performance.now()
      let retryable: string
      try {
        const response = await fetch(url, {
          method: "POST",
          headers: {
            ...(token === undefined ? {} : { authorization: `Bearer ${Redacted.value(token)}` }),
            "content-type": "application/json"
          },
          body
        })
        const text = await response.text()
        const ms = performance.now() - started
        if (response.ok) return { json: JSON.parse(text), ms }
        // 4006: the account's daily Workers AI allocation is spent; retrying cannot help.
        if ((response.status !== 429 && response.status < 500) || text.includes('"code":4006')) {
          throw new Rejected(`${model.name} ${response.status}: ${text.slice(0, 500)}`)
        }
        retryable = `${response.status}`
      } catch (error) {
        if (error instanceof Rejected) throw error
        retryable = String(error)
      }
      if (attempt === attempts) throw new Error(`${model.name} failed after ${attempts} attempts: ${retryable}`)
      await Bun.sleep(500 * 2 ** attempt)
    }
  }

  return async (body: string): Promise<Reply> => {
    const key = new Bun.CryptoHasher("sha256").update(model.cacheKey).update("\0").update(body).digest("hex")
    const cacheFile = Bun.file(`${cacheDirectory}/${key.slice(0, 2)}/${key}.json`)
    if (await cacheFile.exists()) {
      const { json, ms } = await cacheFile.json()
      return reply(json, ms, true)
    }
    await acquire()
    try {
      const { json, ms } = await send(body)
      await Bun.write(cacheFile, JSON.stringify({ json, ms }))
      return reply(json, ms, false)
    } finally {
      release()
    }
  }
}

const reply = (json: unknown, ms: number, cached: boolean): Reply => {
  const decoded = Effect.runSync(Effect.result(decodeReply(model.format, json)))
  if (Result.isFailure(decoded)) {
    throw new Error(`unexpected ${model.name} reply: ${JSON.stringify(json).slice(0, 500)}`)
  }
  return { answers: decoded.success.answers, inputTokens: decoded.success.inputTokens ?? 0, ms, cached }
}
