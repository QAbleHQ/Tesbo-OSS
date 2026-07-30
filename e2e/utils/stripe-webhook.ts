import { createHmac, randomBytes } from "node:crypto";
import type { APIRequestContext, APIResponse } from "@playwright/test";
import { env } from "./env";

/*
 * Locally signed Stripe webhook events.
 *
 * Stripe signature verification is a plain HMAC-SHA256 over `${timestamp}.${rawBody}` using the
 * endpoint's signing secret — no network call, no Stripe state. So with STRIPE_WEBHOOK_SECRET in
 * hand these helpers can drive the REAL webhook handlers through the entire subscription lifecycle
 * (checkout completed, dunning, cancellation, downgrade, replays) without a single Stripe API call
 * and without creating anything in a Stripe account. That's what makes the most important payment
 * paths testable against a deployment whose secret key may well be live.
 *
 * The payloads below are deliberately minimal: constructEvent only verifies the signature and
 * JSON.parses the body, so each event carries exactly the fields BillingService actually reads.
 * If a handler starts reading a new field, the test that covers it should fail — that's the point.
 */

export interface StripeEvent {
  id: string;
  object: "event";
  type: string;
  created: number;
  data: { object: Record<string, unknown> };
}

/** Unique per call, because stripe_webhook_events.id is a primary key and replays are a feature. */
export function uniqueStripeId(prefix: string): string {
  return `${prefix}_e2e${Date.now().toString(36)}${randomBytes(5).toString("hex")}`;
}

export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

export function unixDaysFromNow(days: number): number {
  return nowSeconds() + Math.round(days * 24 * 60 * 60);
}

/** The `Stripe-Signature` header value for this exact payload. */
export function signStripePayload(
  payload: string,
  options: { secret?: string; timestampSeconds?: number } = {},
): string {
  const secret = options.secret ?? env.stripeWebhookSecret;
  const timestamp = options.timestampSeconds ?? nowSeconds();
  const digest = createHmac("sha256", secret).update(`${timestamp}.${payload}`, "utf8").digest("hex");
  return `t=${timestamp},v1=${digest}`;
}

/**
 * Delivers an event the way Stripe does: raw JSON bytes, an explicit JSON content type (which is
 * what makes the backend stash req.rawBody), and no session cookie.
 *
 * The body is stringified ONCE and both signed and sent, because the signature covers the exact
 * bytes received — letting the HTTP client re-serialise the object would be a coin flip.
 */
export async function postStripeWebhook(
  api: APIRequestContext,
  event: StripeEvent,
  options: { secret?: string; timestampSeconds?: number; signature?: string } = {},
): Promise<APIResponse> {
  const payload = JSON.stringify(event);
  const signature =
    options.signature ??
    signStripePayload(payload, { secret: options.secret, timestampSeconds: options.timestampSeconds });
  return api.post("/api/billing/webhook", {
    headers: { "content-type": "application/json", "stripe-signature": signature },
    data: payload,
    failOnStatusCode: false,
  });
}

function event(type: string, object: Record<string, unknown>): StripeEvent {
  return { id: uniqueStripeId("evt"), object: "event", type, created: nowSeconds(), data: { object } };
}

/** The moment money first changes hands. Carries the organizationId checkout puts in metadata. */
export function checkoutSessionCompleted(params: {
  organizationId: string;
  subscriptionId: string;
  amountTotal?: number;
  currency?: string;
}): StripeEvent {
  return event("checkout.session.completed", {
    id: uniqueStripeId("cs"),
    object: "checkout_session",
    mode: "subscription",
    metadata: { organizationId: params.organizationId },
    subscription: params.subscriptionId,
    amount_total: params.amountTotal ?? 36000,
    currency: params.currency ?? "usd",
  });
}

/**
 * A subscription in whatever state the test needs. `current_period_end` sits on the item (not the
 * subscription) to match the API version BillingService reads, and the price id is what the
 * interval is derived from — pass a configured one or billingInterval stays null.
 */
export function subscriptionEvent(
  type: "customer.subscription.created" | "customer.subscription.updated" | "customer.subscription.deleted",
  params: {
    organizationId: string;
    subscriptionId: string;
    status: string;
    priceId?: string;
    currency?: string;
    currentPeriodEndSeconds?: number | null;
    cancelAtPeriodEnd?: boolean;
  },
): StripeEvent {
  return event(type, {
    id: params.subscriptionId,
    object: "subscription",
    status: params.status,
    cancel_at_period_end: params.cancelAtPeriodEnd ?? false,
    metadata: { organizationId: params.organizationId },
    items: {
      object: "list",
      data: [
        {
          id: uniqueStripeId("si"),
          object: "subscription_item",
          current_period_end: params.currentPeriodEndSeconds ?? unixDaysFromNow(30),
          price: {
            id: params.priceId ?? "",
            object: "price",
            currency: params.currency ?? "usd",
          },
        },
      ],
    },
  });
}

/**
 * A failed subscription invoice. The organizationId is read from
 * `parent.subscription_details.metadata` first — the snapshot Stripe takes at finalization, which
 * is where checkout's metadata lands on current API versions.
 */
export function invoicePaymentFailed(params: {
  organizationId: string;
  amountDue?: number;
  currency?: string;
  hostedInvoiceUrl?: string;
}): StripeEvent {
  return event("invoice.payment_failed", {
    id: uniqueStripeId("in"),
    object: "invoice",
    amount_due: params.amountDue ?? 36000,
    amount_paid: 0,
    currency: params.currency ?? "usd",
    hosted_invoice_url: params.hostedInvoiceUrl ?? "https://invoice.stripe.com/e2e-fake",
    parent: { subscription_details: { metadata: { organizationId: params.organizationId } } },
  });
}

export function invoicePaid(params: {
  organizationId: string;
  amountPaid?: number;
  currency?: string;
  number?: string;
  periodEndSeconds?: number;
}): StripeEvent {
  return event("invoice.paid", {
    id: uniqueStripeId("in"),
    object: "invoice",
    amount_due: params.amountPaid ?? 36000,
    amount_paid: params.amountPaid ?? 36000,
    currency: params.currency ?? "usd",
    number: params.number ?? "E2E-0001",
    hosted_invoice_url: "https://invoice.stripe.com/e2e-fake",
    lines: { object: "list", data: [{ period: { end: params.periodEndSeconds ?? unixDaysFromNow(30) } }] },
    parent: { subscription_details: { metadata: { organizationId: params.organizationId } } },
  });
}

/** An event type the handler has no case for — must still be accepted and acknowledged. */
export function unhandledEvent(): StripeEvent {
  return event("customer.updated", { id: uniqueStripeId("cus"), object: "customer" });
}
