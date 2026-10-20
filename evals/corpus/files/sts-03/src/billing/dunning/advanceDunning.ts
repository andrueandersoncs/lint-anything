import type { Clock } from "../../shared/clock";
import type { Mailer } from "../../notifications/mailer";
import type { InvoiceRepository } from "../invoices/invoiceRepository";
import type { SubscriptionRepository } from "../subscriptions/subscriptionRepository";
import type { ChargeRetryQueue } from "./chargeRetryQueue";

export interface DunningDependencies {
  readonly invoices: InvoiceRepository;
  readonly subscriptions: SubscriptionRepository;
  readonly retries: ChargeRetryQueue;
  readonly mailer: Mailer;
  readonly clock: Clock;
}

/** After this many failed charges we stop retrying and cancel. */
const MAX_CHARGE_ATTEMPTS = 4;
/** Days after the first failure that the customer keeps full access. */
const GRACE_PERIOD_DAYS = 14;
/** Wait before the 2nd, 3rd and 4th attempts; card networks discourage same-day retries. */
const RETRY_DELAYS_HOURS = [24, 72, 120] as const;

const MS_PER_HOUR = 60 * 60 * 1000;
const MS_PER_DAY = 24 * MS_PER_HOUR;

/**
 * Runs one dunning step for an invoice whose latest charge attempt was declined:
 * schedules the next retry, suspends access once the grace period has run out,
 * and cancels the subscription when retries are exhausted.
 */
export async function advanceDunning(deps: DunningDependencies, invoiceId: string): Promise<void> {
  const invoice = await deps.invoices.findOpen(invoiceId);
  if (invoice === undefined) {
    return;
  }
  const subscription = await deps.subscriptions.get(invoice.subscriptionId);
  const now = deps.clock.now();

  if (invoice.chargeAttempts >= MAX_CHARGE_ATTEMPTS) {
    if (subscription.contract === "invoiced") {
      // Contract customers pay by bank transfer on their own terms; an account
      // manager follows up instead of us cutting them off automatically.
      await deps.mailer.send(subscription.accountManagerEmail, "dunning-escalation", {
        invoiceId: invoice.id,
        customerName: subscription.customerName,
      });
      return;
    }
    await deps.subscriptions.setStatus(subscription.id, "canceled");
    await deps.invoices.markUncollectible(invoice.id);
    await deps.mailer.send(subscription.billingEmail, "subscription-canceled", {
      invoiceId: invoice.id,
    });
    return;
  }

  const graceExpired = daysBetween(invoice.firstFailedAt, now) > GRACE_PERIOD_DAYS;
  if (graceExpired && subscription.status === "active") {
    await deps.subscriptions.setStatus(subscription.id, "suspended");
    await deps.mailer.send(subscription.billingEmail, "subscription-suspended", {
      invoiceId: invoice.id,
    });
  }

  const retryAt = addHours(now, retryDelayHours(invoice.chargeAttempts));
  await deps.retries.schedule({ invoiceId: invoice.id, runAt: retryAt });

  if (invoice.chargeAttempts === 1) {
    await deps.mailer.send(subscription.billingEmail, "payment-failed", {
      invoiceId: invoice.id,
      retryAt: retryAt.toISOString(),
    });
  }
}

function retryDelayHours(chargeAttempts: number): number {
  const index = Math.min(chargeAttempts, RETRY_DELAYS_HOURS.length) - 1;
  return RETRY_DELAYS_HOURS[index];
}

function daysBetween(from: Date, to: Date): number {
  return (to.getTime() - from.getTime()) / MS_PER_DAY;
}

function addHours(date: Date, hours: number): Date {
  return new Date(date.getTime() + hours * MS_PER_HOUR);
}
