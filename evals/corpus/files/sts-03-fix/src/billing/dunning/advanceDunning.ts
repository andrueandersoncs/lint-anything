import type { Clock } from "../../shared/clock";
import type { Mailer } from "../../notifications/mailer";
import type { InvoiceRepository, OpenInvoice } from "../invoices/invoiceRepository";
import type { BillingSubscription, SubscriptionRepository } from "../subscriptions/subscriptionRepository";
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

type DunningStep =
  | { readonly kind: "escalate" }
  | { readonly kind: "cancel" }
  | {
      readonly kind: "retry";
      readonly retryAt: Date;
      readonly suspendAccess: boolean;
      readonly notifyCustomer: boolean;
    };

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
  const step = decideDunningStep(invoice, subscription, deps.clock.now());
  await applyDunningStep(deps, invoice, subscription, step);
}

function decideDunningStep(invoice: OpenInvoice, subscription: BillingSubscription, now: Date): DunningStep {
  if (invoice.chargeAttempts >= MAX_CHARGE_ATTEMPTS) {
    // Contract customers pay by bank transfer on their own terms; an account
    // manager follows up instead of us cutting them off automatically.
    return subscription.contract === "invoiced" ? { kind: "escalate" } : { kind: "cancel" };
  }
  const graceExpired = daysBetween(invoice.firstFailedAt, now) > GRACE_PERIOD_DAYS;
  return {
    kind: "retry",
    retryAt: addHours(now, retryDelayHours(invoice.chargeAttempts)),
    suspendAccess: graceExpired && subscription.status === "active",
    notifyCustomer: invoice.chargeAttempts === 1,
  };
}

async function applyDunningStep(
  deps: DunningDependencies,
  invoice: OpenInvoice,
  subscription: BillingSubscription,
  step: DunningStep,
): Promise<void> {
  switch (step.kind) {
    case "escalate":
      await deps.mailer.send(subscription.accountManagerEmail, "dunning-escalation", {
        invoiceId: invoice.id,
        customerName: subscription.customerName,
      });
      return;
    case "cancel":
      await deps.subscriptions.setStatus(subscription.id, "canceled");
      await deps.invoices.markUncollectible(invoice.id);
      await deps.mailer.send(subscription.billingEmail, "subscription-canceled", {
        invoiceId: invoice.id,
      });
      return;
    case "retry":
      if (step.suspendAccess) {
        await deps.subscriptions.setStatus(subscription.id, "suspended");
        await deps.mailer.send(subscription.billingEmail, "subscription-suspended", {
          invoiceId: invoice.id,
        });
      }
      await deps.retries.schedule({ invoiceId: invoice.id, runAt: step.retryAt });
      if (step.notifyCustomer) {
        await deps.mailer.send(subscription.billingEmail, "payment-failed", {
          invoiceId: invoice.id,
          retryAt: step.retryAt.toISOString(),
        });
      }
      return;
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
