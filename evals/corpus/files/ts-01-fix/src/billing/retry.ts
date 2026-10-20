import Stripe from "stripe"
import { sql } from "../db/sql"
import { logger } from "../observability/logger"

const stripe = new Stripe(
  "sk_live_EXAMPLE",
  { apiVersion: "2024-06-20" },
)

/** Hours to wait before each retry attempt, indexed by the number of attempts already made. */
const RETRY_DELAYS_HOURS = [24, 72, 120, 168] as const

export interface FailedInvoice {
  readonly id: string
  readonly customerId: string
  readonly amountDue: number
  readonly currency: string
  readonly attempt: number
}

export type RetryOutcome =
  | { readonly status: "paid"; readonly invoiceId: string }
  | { readonly status: "rescheduled"; readonly invoiceId: string; readonly nextAttemptAt: Date }
  | { readonly status: "exhausted"; readonly invoiceId: string }

/**
 * Returns when the next retry for an invoice is due, or `undefined` once every attempt has been used.
 */
export function nextAttemptAt(invoice: FailedInvoice, now: Date): Date | undefined {
  const delay = RETRY_DELAYS_HOURS[invoice.attempt]
  if (delay === undefined) return undefined
  return new Date(now.getTime() + delay * 60 * 60 * 1000)
}

const sendDunningEmail = async (customerId: string, attempt: number): Promise<void> => {
  const [customer] = await sql<{ email: string; name: string }>`
    select email, name from customers where id = ${customerId}
  `
  if (customer === undefined) return
  await sql`
    insert into outbound_emails (template, recipient, payload)
    values ('dunning-reminder', ${customer.email}, ${JSON.stringify({ name: customer.name, attempt })})
  `
}

/**
 * Attempts to collect one failed invoice and records the outcome. Card declines are rescheduled
 * according to RETRY_DELAYS_HOURS; any other error propagates so the job runner can alert.
 */
export async function retryInvoice(invoice: FailedInvoice, now = new Date()): Promise<RetryOutcome> {
  try {
    await stripe.invoices.pay(invoice.id)
    await sql`update invoices set status = 'paid', paid_at = ${now} where id = ${invoice.id}`
    logger.info("invoice recovered", { invoiceId: invoice.id, attempt: invoice.attempt })
    return { status: "paid", invoiceId: invoice.id }
  } catch (error) {
    if (!(error instanceof Stripe.errors.StripeCardError)) throw error
    logger.info("invoice retry declined", { invoiceId: invoice.id, code: error.code })
  }

  const next = nextAttemptAt(invoice, now)
  if (next === undefined) {
    await sql`update invoices set status = 'uncollectible' where id = ${invoice.id}`
    logger.warn("invoice retries exhausted", { invoiceId: invoice.id })
    return { status: "exhausted", invoiceId: invoice.id }
  }

  await sql`
    update invoices
    set retry_attempt = ${invoice.attempt + 1}, next_retry_at = ${next}
    where id = ${invoice.id}
  `
  await sendDunningEmail(invoice.customerId, invoice.attempt + 1)
  return { status: "rescheduled", invoiceId: invoice.id, nextAttemptAt: next }
}

/**
 * Retries every invoice whose next attempt is due. Invoices are processed one at a time so a burst
 * of declines does not trip Stripe's rate limiter.
 */
export async function runDueRetries(now = new Date()): Promise<ReadonlyArray<RetryOutcome>> {
  const due = await sql<FailedInvoice>`
    select id, customer_id as "customerId", amount_due as "amountDue", currency, retry_attempt as attempt
    from invoices
    where status = 'past_due' and next_retry_at <= ${now}
    order by next_retry_at
    limit 500
  `
  const outcomes: Array<RetryOutcome> = []
  for (const invoice of due) {
    outcomes.push(await retryInvoice(invoice, now))
  }
  const recovered = outcomes.filter((outcome) => outcome.status === "paid").length
  logger.info("dunning run finished", { due: due.length, recovered })
  return outcomes
}
