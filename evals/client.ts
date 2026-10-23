import { model } from "../src/clef.ts"

/** One answer as Clef returns it; `noul` for yes/no questions, `probabilities` for choices. */
export interface Answer {
  readonly type: string
  readonly noul?: number
  readonly probabilities?: Readonly<Record<string, number>>
}

export interface ClefReply {
  readonly answers: Readonly<Record<string, Answer>>
  readonly inputTokens: number
  /** Round-trip time of the original (uncached) request. */
  readonly ms: number
  readonly cached: boolean
}

const cacheDirectory = `${import.meta.dir}/.cache`
const attempts = 6

/**
 * Sends Clef requests with bounded concurrency and caches replies by model and exact body. Clef is
 * deterministic for a given body, so a cached reply stands in for a fresh one.
 */
export const makeClient = (concurrency: number) => {
  const accountId = Bun.env.CLOUDFLARE_ACCOUNT_ID
  const token = Bun.env.CLOUDFLARE_AUTH_TOKEN
  const baseUrl = Bun.env.CLOUDFLARE_API_BASE_URL ?? "https://api.cloudflare.com/client/v4"
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

  const send = async (body: string): Promise<{ json: any; ms: number }> => {
    if (accountId === undefined || token === undefined) {
      throw new Error("set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_AUTH_TOKEN")
    }
    for (let attempt = 1; ; attempt++) {
      const started = performance.now()
      let retryable: string
      try {
        const response = await fetch(`${baseUrl}/accounts/${accountId}/ai/run/@cf/cloudflare/${model}`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body
        })
        const text = await response.text()
        const ms = performance.now() - started
        if (response.ok) return { json: JSON.parse(text), ms }
        // 4006: the account's daily Workers AI allocation is spent; retrying cannot help.
        if ((response.status !== 429 && response.status < 500) || text.includes('"code":4006')) {
          throw new Error(`Clef ${response.status}: ${text.slice(0, 500)}`)
        }
        retryable = `${response.status}`
      } catch (error) {
        if (error instanceof Error && error.message.startsWith("Clef ")) throw error
        retryable = String(error)
      }
      if (attempt === attempts) throw new Error(`Clef failed after ${attempts} attempts: ${retryable}`)
      await Bun.sleep(500 * 2 ** attempt)
    }
  }

  return async (body: string): Promise<ClefReply> => {
    const key = new Bun.CryptoHasher("sha256").update(model).update("\0").update(body).digest("hex")
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

const reply = (json: any, ms: number, cached: boolean): ClefReply => {
  const answers = json?.result?.answers
  const inputTokens = json?.result?.usage?.input_tokens
  if (typeof answers !== "object" || answers === null || typeof inputTokens !== "number") {
    throw new Error(`unexpected Clef reply: ${JSON.stringify(json).slice(0, 500)}`)
  }
  return { answers, inputTokens, ms, cached }
}
