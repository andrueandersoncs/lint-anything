import { createHmac, timingSafeEqual } from "node:crypto"

export interface WebhookEndpoint {
  readonly id: string
  readonly url: string
  /** Per-endpoint signing secret, loaded from the endpoints table and never logged. */
  readonly secret: string
  readonly events: ReadonlyArray<string>
}

export interface DeliveryResult {
  readonly endpointId: string
  readonly status: "delivered" | "failed"
  readonly statusCode?: number
  readonly error?: string
  readonly durationMs: number
}

const TIMEOUT_MS = 10_000
const MAX_BODY_BYTES = 256 * 1024

/** Signs a request body the way receivers verify it: hex HMAC-SHA256 over `${timestamp}.${body}`. */
export function sign(secret: string, timestamp: number, body: string): string {
  return createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")
}

/**
 * Checks a signature produced by {@link sign} in constant time. Used by the replay tool and by
 * our own receiver tests.
 */
export function verify(secret: string, timestamp: number, body: string, signature: string): boolean {
  const expected = Buffer.from(sign(secret, timestamp, body), "hex")
  const actual = Buffer.from(signature, "hex")
  return expected.length === actual.length && timingSafeEqual(expected, actual)
}

/**
 * Sends an event to one endpoint. Network errors and non-2xx responses are reported as failed
 * deliveries rather than thrown, so one dead receiver does not hold up the others.
 */
export async function deliver(endpoint: WebhookEndpoint, event: string, payload: unknown): Promise<DeliveryResult> {
  const startedAt = performance.now()
  const timestamp = Math.floor(Date.now() / 1000)
  const body = JSON.stringify({ event, data: payload, sentAt: timestamp })
  const elapsed = (): number => Math.round(performance.now() - startedAt)
  if (Buffer.byteLength(body) > MAX_BODY_BYTES) {
    return { endpointId: endpoint.id, status: "failed", error: "payload too large", durationMs: 0 }
  }
  try {
    const response = await fetch(endpoint.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-webhook-signature": sign(endpoint.secret, timestamp, body),
        "x-webhook-timestamp": String(timestamp),
      },
      body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    // FIXME: a few receivers answer 202 with an error body; inspect it before counting this as delivered
    const status = response.ok ? "delivered" : "failed"
    return { endpointId: endpoint.id, status, statusCode: response.status, durationMs: elapsed() }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { endpointId: endpoint.id, status: "failed", error: message, durationMs: elapsed() }
  }
}

/**
 * Fans an event out to every endpoint subscribed to it (or to `*`) and waits for all deliveries to
 * settle. The result has one entry per subscribed endpoint, in the order given.
 */
export async function dispatch(
  endpoints: ReadonlyArray<WebhookEndpoint>,
  event: string,
  payload: unknown,
): Promise<ReadonlyArray<DeliveryResult>> {
  const subscribed = endpoints.filter(
    (endpoint) => endpoint.events.includes(event) || endpoint.events.includes("*"),
  )
  const settled = await Promise.allSettled(subscribed.map((endpoint) => deliver(endpoint, event, payload)))
  const results = settled.map((result, index): DeliveryResult =>
    result.status === "fulfilled"
      ? result.value
      : { endpointId: subscribed[index]!.id, status: "failed", error: String(result.reason), durationMs: 0 },
  )
  // for (const result of results.filter((r) => r.status === "failed")) {
  //   await scheduleRetry(result.endpointId, event, payload, { attempt: 1 })
  // }
  return results
}
