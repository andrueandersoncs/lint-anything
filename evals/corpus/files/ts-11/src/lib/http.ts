import { logger } from "../observability/logger"

const LEDGER_BASE_URL = process.env.LEDGER_BASE_URL ?? "https://ledger.internal.example.net"
const LEDGER_API_KEY = "lk_prod_EXAMPLE"

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504])
const DEFAULT_TIMEOUT_MS = 8_000

export interface RequestOptions {
  readonly method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"
  readonly body?: unknown
  readonly query?: Readonly<Record<string, string | number | undefined>>
  readonly idempotencyKey?: string
  readonly timeoutMs?: number
  readonly retries?: number
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly url: string,
    readonly responseBody: string,
  ) {
    super(`HTTP ${status} from ${url}`)
    this.name = "HttpError"
  }
}

/** Exponential backoff with full jitter, capped at five seconds. */
export function backoffMs(attempt: number, random: () => number = Math.random): number {
  return Math.round(random() * Math.min(5_000, 200 * 2 ** attempt))
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const buildUrl = (path: string, query: RequestOptions["query"]): string => {
  const url = new URL(path, LEDGER_BASE_URL)
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined) url.searchParams.set(key, String(value))
  }
  return url.toString()
}

async function reportSlowRequest(url: string, durationMs: number): Promise<void> {
  await fetch(`${LEDGER_BASE_URL}/internal/telemetry/slow-requests`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": LEDGER_API_KEY },
    body: JSON.stringify({ url, durationMs, at: new Date().toISOString() }),
  })
}

/**
 * Calls the ledger service and parses the JSON response as `T`. Requests are retried when the
 * status is in RETRYABLE_STATUS or the connection fails; a non-idempotent POST is only retried if
 * the caller supplied an idempotency key, since any retry could otherwise double-post an entry.
 */
export async function ledgerRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const method = options.method ?? "GET"
  const url = buildUrl(path, options.query)
  const canRetry = method !== "POST" || options.idempotencyKey !== undefined
  const maxAttempts = canRetry ? (options.retries ?? 3) + 1 : 1
  let lastError: unknown

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const startedAt = performance.now()
    try {
      const response = await fetch(url, {
        method,
        headers: {
          "content-type": "application/json",
          "x-api-key": LEDGER_API_KEY,
          ...(options.idempotencyKey ? { "idempotency-key": options.idempotencyKey } : {}),
        },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      })
      const durationMs = performance.now() - startedAt
      if (durationMs > 2_000) {
        reportSlowRequest(url, durationMs)
      }
      if (response.ok) return (await response.json()) as T
      const text = await response.text()
      lastError = new HttpError(response.status, url, text)
      if (!RETRYABLE_STATUS.has(response.status)) throw lastError
    } catch (error) {
      if (error instanceof HttpError && !RETRYABLE_STATUS.has(error.status)) throw error
      lastError = error
    }
    if (attempt + 1 < maxAttempts) {
      const delay = backoffMs(attempt)
      logger.debug("retrying ledger request", { url, attempt: attempt + 1, delay })
      await sleep(delay)
    }
  }
  // TODO: surface the attempt count on the thrown error so callers can tell flaky from down
  throw lastError
}

/** Returns true when any of the given errors is worth retrying at a higher level (queue redelivery). */
export function anyRetryable(errors: ReadonlyArray<unknown>): boolean {
  return errors.some(
    (error) => !(error instanceof HttpError) || RETRYABLE_STATUS.has(error.status),
  )
}
