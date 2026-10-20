import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test"
import { createStripeClient, PaymentDeclinedError, type StripeClient } from "../../src/billing/stripe-client"

const TEST_API_KEY = "sk_test_fake_key_for_unit_tests"

interface RecordedCall {
  readonly url: string
  readonly init: RequestInit
}

describe("stripe client", () => {
  let calls: Array<RecordedCall>
  let responses: Array<Response>
  let client: StripeClient
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    calls = []
    responses = []
    globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} })
      const next = responses.shift()
      if (next === undefined) throw new Error(`unexpected request to ${String(url)}`)
      return next
    }) as any
    client = createStripeClient({ apiKey: TEST_API_KEY, maxNetworkRetries: 1 })
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  const json = (status: number, body: unknown): Response =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

  it("sends the API key as a bearer token", async () => {
    responses.push(json(200, { id: "cus_123", email: "ada@example.com" }))
    await client.customers.retrieve("cus_123")
    expect(calls).toHaveLength(1)
    expect(new Headers(calls[0]!.init.headers).get("authorization")).toBe(`Bearer ${TEST_API_KEY}`)
  })

  it("form-encodes nested parameters", async () => {
    responses.push(json(200, { id: "pi_1", status: "requires_confirmation" }))
    await client.paymentIntents.create({ amount: 1999, currency: "usd", metadata: { orderId: "ord_9" } })
    const body = new URLSearchParams(String(calls[0]!.init.body))
    expect(body.get("amount")).toBe("1999")
    expect(body.get("metadata[orderId]")).toBe("ord_9")
  })

  it("retries once on a 503 and then succeeds", async () => {
    responses.push(json(503, { error: { type: "api_error" } }), json(200, { id: "cus_123" }))
    const customer = await client.customers.retrieve("cus_123")
    expect(customer.id).toBe("cus_123")
    expect(calls).toHaveLength(2)
  })

  it("maps card declines to PaymentDeclinedError", async () => {
    responses.push(json(402, { error: { type: "card_error", code: "card_declined", decline_code: "insufficient_funds" } }))
    await expect(client.paymentIntents.confirm("pi_1")).rejects.toBeInstanceOf(PaymentDeclinedError)
  })

  it("does not retry card declines", async () => {
    responses.push(json(402, { error: { type: "card_error", code: "card_declined" } }))
    expect(client.paymentIntents.confirm("pi_2")).rejects.toThrow("card_declined")
    expect(calls).toHaveLength(1)
  })

  // TODO(https://github.com/acme/payments/issues/1184): cover idempotency key reuse across retries
  // once the client exposes the generated key.
  it("sends an idempotency key on POST requests", async () => {
    responses.push(json(200, { id: "re_1" }))
    await client.refunds.create({ payment_intent: "pi_1", amount: 500 })
    const key = new Headers(calls[0]!.init.headers).get("idempotency-key")
    expect(key).toMatch(/^[0-9a-f-]{36}$/)
  })
})
