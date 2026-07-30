import { expect, request, test, type APIRequestContext } from "@playwright/test";
import { billingModuleUnavailableReason } from "../utils/billing-db";
import { env } from "../utils/env";
import {
  invoicePaid,
  postStripeWebhook,
  signStripePayload,
  subscriptionEvent,
  uniqueStripeId,
} from "../utils/stripe-webhook";

/*
 * Payment API contract suite: every billing endpoint's response shape, its input validation, and
 * its auth gate.
 *
 * SAFE BY CONSTRUCTION against any environment, including one configured with a LIVE Stripe secret
 * key. Nothing here creates or modifies a Stripe object:
 *
 *   - GET /billing, /usage, /history read our own database.
 *   - GET /pricing and /invoices are Stripe READS (prices.retrieve, invoices.list).
 *   - The checkout-session cases all stop inside validation, before resolveStripeCustomerId — which
 *     is the first line in that handler that would write to Stripe (customers.create).
 *   - The webhook cases are all signature REJECTIONS, verified locally with no Stripe call.
 *
 * The two tests that genuinely write to Stripe are gated behind E2E_BILLING_ALLOW_STRIPE_WRITES and
 * skip by default. Plan transitions and limit enforcement live in billing-lifecycle.spec.ts, which
 * drives a disposable workspace instead of this shared one.
 */

const CURRENCIES = ["usd", "inr"];
const COUNTRY_SOURCES = ["override", "edge-header", "ip", "declared", "unknown"];

/** Endpoints that must refuse a caller with no session. /pricing is excluded — it's public. */
const AUTHENTICATED_ENDPOINTS: { method: "get" | "post"; path: string }[] = [
  { method: "get", path: "/api/billing" },
  { method: "get", path: "/api/billing/usage" },
  { method: "get", path: "/api/billing/history" },
  { method: "get", path: "/api/billing/invoices" },
  { method: "post", path: "/api/billing/reconcile" },
  { method: "post", path: "/api/billing/portal-session" },
  { method: "post", path: "/api/billing/checkout-session" },
];

let anon: APIRequestContext;
let unavailableReason: string | null = null;

test.beforeAll(async () => {
  // The default `request` fixture inherits account A's session from playwright.config.ts's
  // storageState; clear it explicitly for a genuinely cookie-less caller. This is also the context
  // the webhook cases use, because Stripe never sends a cookie either.
  anon = await request.newContext({ baseURL: env.apiBaseUrl, storageState: { cookies: [], origins: [] } });
  unavailableReason = await billingModuleUnavailableReason(anon);
});

test.beforeEach(() => {
  test.skip(!!unavailableReason, unavailableReason ?? undefined);
});

test.afterAll(async () => {
  await anon.dispose();
});

function expectIsoDateOrNull(value: unknown) {
  if (value === null) return;
  expect(typeof value).toBe("string");
  expect(Number.isNaN(Date.parse(value as string))).toBeFalsy();
}

/** Asserts the BillingInfo contract plus the invariants that tie its three plan-state flags together. */
function expectBillingInfoContract(info: Record<string, unknown>) {
  expect(["launch", "pro"]).toContain(info.plan);
  expect([null, "monthly", "annual"]).toContain(info.billingInterval);
  expect(typeof info.cancelAtPeriodEnd).toBe("boolean");
  expect(typeof info.inGracePeriod).toBe("boolean");
  expect(typeof info.limitsEnforced).toBe("boolean");
  expectIsoDateOrNull(info.currentPeriodEnd);
  expectIsoDateOrNull(info.paymentFailedAt);
  expectIsoDateOrNull(info.graceEndsAt);

  // A grace window can only be owed to a workspace that has dropped off Pro, and the window is
  // either still open or already enforced — never both, never neither once a deadline exists.
  if (info.inGracePeriod || info.limitsEnforced) {
    expect(info.plan).toBe("launch");
    expect(info.graceEndsAt).not.toBeNull();
  }
  expect(info.inGracePeriod && info.limitsEnforced).toBeFalsy();
  if (info.graceEndsAt && info.plan === "launch") {
    expect(info.inGracePeriod || info.limitsEnforced).toBeTruthy();
  }
}

test.describe("billing info and usage", () => {
  test("GET /api/billing returns the plan card contract with coherent plan-state flags", async ({
    request,
  }) => {
    const res = await request.get("/api/billing");
    expect(res.ok()).toBeTruthy();
    expectBillingInfoContract(await res.json());
  });

  test("GET /api/billing/usage reports the limits actually in force for the plan", async ({ request }) => {
    const res = await request.get("/api/billing/usage");
    expect(res.ok()).toBeTruthy();
    const usage = await res.json();

    expect(["launch", "pro"]).toContain(usage.plan);
    expect(Number.isInteger(usage.projectCount)).toBeTruthy();
    expect(usage.projectCount).toBeGreaterThanOrEqual(0);
    expect(Number.isInteger(usage.storageUsedBytes)).toBeTruthy();
    expect(usage.storageUsedBytes).toBeGreaterThanOrEqual(0);
    expect(typeof usage.inGracePeriod).toBe("boolean");
    expectIsoDateOrNull(usage.graceEndsAt);
    // Someone who needs more room than their plan allows has to have somewhere to go.
    expect(usage.supportContactEmail).toContain("@");

    // The reported ceilings must be the ones the API will actually enforce, otherwise the usage
    // bars promise room that the next request refuses. Launch is 2 projects / 500MB; Pro is
    // unlimited projects (null) / 5GB. A downgraded workspace inside its grace window reports
    // Pro-sized limits, which is why this keys off the effective pair rather than usage.plan.
    const launchLimits = usage.projectLimit === 2 && usage.storageLimitBytes === 500 * 1024 * 1024;
    const proLimits = usage.projectLimit === null && usage.storageLimitBytes === 5 * 1024 * 1024 * 1024;
    expect(launchLimits || proLimits).toBeTruthy();
    if (usage.plan === "pro" || usage.inGracePeriod) expect(proLimits).toBeTruthy();
  });

  test("POST /api/billing/reconcile returns the same contract as GET and doesn't invent a plan", async ({
    request,
  }) => {
    const before = await (await request.get("/api/billing")).json();

    // For a workspace with no Stripe customer this is a pure no-op that returns current state; with
    // one it lists subscriptions (a read). Either way it must never upgrade a workspace that has
    // nothing to upgrade from — the whole point of the self-heal path is to match Stripe, not guess.
    const res = await request.post("/api/billing/reconcile");
    expect(res.ok()).toBeTruthy();
    const after = await res.json();
    expectBillingInfoContract(after);
    expect(after.plan).toBe(before.plan);

    // Idempotent: reconciling twice can't drift.
    const again = await (await request.post("/api/billing/reconcile")).json();
    expect(again.plan).toBe(before.plan);
    expect(again.status).toBe(after.status);
  });
});

test.describe("billing history", () => {
  test("GET /api/billing/history returns timeline entries newest first", async ({ request }) => {
    const res = await request.get("/api/billing/history");
    expect(res.ok()).toBeTruthy();
    const history = await res.json();
    expect(Array.isArray(history)).toBeTruthy();

    for (const entry of history) {
      expect(typeof entry.action).toBe("string");
      expect(typeof entry.summary).toBe("string");
      expect(entry.summary.length).toBeGreaterThan(0);
      expect(typeof entry.detail).toBe("object");
      expectIsoDateOrNull(entry.at);
    }

    const timestamps = history.map((e: { at: string }) => Date.parse(e.at));
    for (let i = 1; i < timestamps.length; i++) {
      expect(timestamps[i - 1]).toBeGreaterThanOrEqual(timestamps[i]);
    }
  });

  test("GET /api/billing/history clamps ?limit and ignores values that aren't a positive number", async ({
    request,
  }) => {
    const one = await request.get("/api/billing/history?limit=1");
    expect(one.ok()).toBeTruthy();
    expect((await one.json()).length).toBeLessThanOrEqual(1);

    // 0, negatives and junk all fall back to the default rather than returning an empty list —
    // a mis-typed query param must not make a workspace's billing history look empty.
    for (const value of ["0", "-5", "abc", ""]) {
      const res = await request.get(`/api/billing/history?limit=${value}`);
      expect(res.ok()).toBeTruthy();
      expect(Array.isArray(await res.json())).toBeTruthy();
    }

    // Upper bound is clamped server-side, so a caller can't ask for the entire audit trail.
    const huge = await request.get("/api/billing/history?limit=100000");
    expect(huge.ok()).toBeTruthy();
    expect((await huge.json()).length).toBeLessThanOrEqual(200);
  });
});

test.describe("invoices", () => {
  test("GET /api/billing/invoices returns settled invoices with working receipt links", async ({
    request,
  }) => {
    const res = await request.get("/api/billing/invoices");
    expect(res.ok()).toBeTruthy();
    const invoices = await res.json();
    expect(Array.isArray(invoices)).toBeTruthy();

    for (const invoice of invoices) {
      expect(typeof invoice.id).toBe("string");
      // Drafts have no stable number or hosted page and aren't money that moved, so they're
      // filtered out — surfacing one would show a customer an invoice they can't open.
      expect(invoice.status).not.toBe("draft");
      expect(Number.isInteger(invoice.amountPaid)).toBeTruthy();
      expect(Number.isInteger(invoice.amountDue)).toBeTruthy();
      expect(invoice.currency).toBe(invoice.currency.toLowerCase());
      expectIsoDateOrNull(invoice.createdAt);
      if (invoice.hostedInvoiceUrl) expect(invoice.hostedInvoiceUrl).toMatch(/^https:\/\//);
      if (invoice.invoicePdf) expect(invoice.invoicePdf).toMatch(/^https:\/\//);
    }
  });
});

test.describe("pricing quotes", () => {
  test("GET /api/billing/pricing quotes a supported currency with coherent availability flags", async ({
    request,
  }) => {
    const res = await request.get("/api/billing/pricing");
    expect(res.ok()).toBeTruthy();
    const pricing = await res.json();

    expect(CURRENCIES).toContain(pricing.currency);
    expect(COUNTRY_SOURCES).toContain(pricing.countrySource);
    expect(typeof pricing.inrAvailable).toBe("boolean");
    expect(typeof pricing.currencyLocked).toBe("boolean");

    // Amounts are Stripe minor units (cents/paise). A float here means someone divided by 100 on
    // the way out, which would quote a hundredth of the real price.
    for (const amount of [pricing.monthlyAmount, pricing.annualAmount]) {
      if (amount === null) continue;
      expect(Number.isInteger(amount)).toBeTruthy();
      expect(amount).toBeGreaterThan(0);
    }

    // The quoted currency is only ever INR because this visitor is genuinely allowed INR, or
    // because a past payment pinned the workspace to it. Anything else means the cheaper India
    // list leaked to someone the server hasn't placed in India.
    if (pricing.currency === "inr") {
      expect(pricing.inrAvailable || pricing.currencyLocked).toBeTruthy();
    }
  });

  test("GET /api/billing/pricing is stable across calls", async ({ request }) => {
    const first = await (await request.get("/api/billing/pricing")).json();
    const second = await (await request.get("/api/billing/pricing")).json();
    // A quote that flips currency between two page loads would show one price and charge another.
    expect(second.currency).toBe(first.currency);
    expect(second.monthlyAmount).toBe(first.monthlyAmount);
    expect(second.annualAmount).toBe(first.annualAmount);
    expect(second.inrAvailable).toBe(first.inrAvailable);
  });

  test("?currency=usd is always honoured", async ({ request }) => {
    const res = await request.get("/api/billing/pricing?currency=usd");
    expect(res.ok()).toBeTruthy();
    const pricing = await res.json();
    // USD needs no eligibility: it's the default list, so asking for it can only be refused by a
    // workspace already locked to INR by a settled invoice (which this smoke workspace never is).
    expect(pricing.currency).toBe("usd");
  });

  test("?currency=inr is either honoured or refused outright, never silently downgraded", async ({
    request,
  }) => {
    const res = await request.get("/api/billing/pricing?currency=inr", { failOnStatusCode: false });

    if (res.ok()) {
      // Detected in India (or an operator override says so): INR is allowed and must actually be
      // quoted, because the amount shown here is the amount checkout will charge.
      const pricing = await res.json();
      expect(pricing.currency).toBe("inr");
      expect(pricing.inrAvailable || pricing.currencyLocked).toBeTruthy();
    } else {
      // Outside India: refused with an explanation, not quietly answered in USD — the INR list is
      // materially cheaper, so this is the anti-abuse gate and it fails closed.
      expect(res.status()).toBe(403);
      expect((await res.json()).error).toContain("India");
    }
  });

  test("an unsupported currency is rejected rather than defaulting to one", async ({ request }) => {
    for (const currency of ["eur", "gbp", "xyz", "us"]) {
      const res = await request.get(`/api/billing/pricing?currency=${currency}`, {
        failOnStatusCode: false,
      });
      // Defaulting a typo would risk quoting — and charging — the wrong currency.
      expect(res.status()).toBe(400);
      expect((await res.json()).error).toContain("currency must be");
    }
  });

  test("currency is matched case- and whitespace-insensitively", async ({ request }) => {
    const canonical = await (await request.get("/api/billing/pricing?currency=usd")).json();
    for (const variant of ["USD", "Usd", "%20usd%20"]) {
      const res = await request.get(`/api/billing/pricing?currency=${variant}`);
      expect(res.ok()).toBeTruthy();
      expect((await res.json()).currency).toBe(canonical.currency);
    }
  });

  test("GET /api/billing/pricing is reachable without a session", async () => {
    // Deliberately public: the pricing modal quotes the plan from the visitor's own location, and
    // there's nothing workspace-specific in the response for a caller with no workspace.
    const res = await anon.get("/api/billing/pricing", { failOnStatusCode: false });
    expect(res.ok()).toBeTruthy();
    const pricing = await res.json();
    expect(CURRENCIES).toContain(pricing.currency);
    expect(pricing.currencyLocked).toBe(false);
  });
});

test.describe("checkout session validation", () => {
  // Every case below is refused by validation BEFORE the handler resolves a Stripe customer, so
  // none of them creates anything in Stripe. That ordering is what makes them safe to run against
  // a live key, and a regression that moved the Stripe call earlier would show up as a new Customer
  // appearing in the dashboard on every test run.

  test("a missing or unsupported interval is refused", async ({ request }) => {
    for (const body of [{}, { interval: "weekly" }, { interval: "" }, { interval: "MONTHLY" }]) {
      const res = await request.post("/api/billing/checkout-session", {
        data: body,
        failOnStatusCode: false,
      });
      expect(res.status()).toBe(400);
      expect((await res.json()).error).toContain("interval must be");
    }
  });

  test("an unsupported currency is refused even with a valid interval", async ({ request }) => {
    const res = await request.post("/api/billing/checkout-session", {
      data: { interval: "monthly", currency: "eur" },
      failOnStatusCode: false,
    });
    expect(res.status()).toBe(400);
    expect((await res.json()).error).toContain("currency must be");
  });

  test("requesting INR from outside India is refused, not quietly charged in USD", async ({
    request,
  }) => {
    const res = await request.post("/api/billing/checkout-session", {
      data: { interval: "monthly", currency: "inr" },
      failOnStatusCode: false,
    });

    if (res.status() === 403) {
      expect((await res.json()).error).toContain("India");
      return;
    }
    // This environment does place the caller in India, so INR is legitimately allowed and the
    // request proceeds past currency resolution into Stripe. Don't let it get that far unless the
    // operator opted into Stripe writes.
    test.skip(
      !env.allowStripeWrites,
      "this environment allows INR, so the request would reach Stripe — covered by the gated checkout test",
    );
    expect(res.ok()).toBeTruthy();
  });
});

test.describe("webhook signature verification", () => {
  // Stripe treats a 5xx as retryable and redelivers for days. A payload that can never verify is
  // permanently undeliverable, so each case below must come back 400 to make Stripe stop and to
  // surface the real cause (almost always the wrong signing secret).

  test("a request with no Stripe-Signature header is refused", async () => {
    const res = await anon.post("/api/billing/webhook", {
      headers: { "content-type": "application/json" },
      data: JSON.stringify({ id: uniqueStripeId("evt"), type: "invoice.paid" }),
      failOnStatusCode: false,
    });
    expect(res.status()).toBe(400);
    expect(String((await res.json()).error)).toMatch(/signature|secret/i);
  });

  test("a malformed signature is refused with 400, never 500", async () => {
    const event = invoicePaid({ organizationId: "00000000-0000-0000-0000-000000000000" });
    const res = await postStripeWebhook(anon, event, { signature: "t=1,v1=not-a-real-signature" });
    expect(res.status()).toBe(400);
  });

  test("a signature computed with the wrong secret is refused", async () => {
    const event = subscriptionEvent("customer.subscription.updated", {
      organizationId: "00000000-0000-0000-0000-000000000000",
      subscriptionId: uniqueStripeId("sub"),
      status: "active",
    });
    const res = await postStripeWebhook(anon, event, { secret: "whsec_this_is_not_the_configured_secret" });
    expect(res.status()).toBe(400);
  });

  test("a correctly signed payload with a stale timestamp is refused", async () => {
    // Stripe's constructEvent enforces a 5-minute tolerance, so a captured-and-replayed body can't
    // be posted back hours later even with its original valid signature.
    const event = invoicePaid({ organizationId: "00000000-0000-0000-0000-000000000000" });
    const res = await postStripeWebhook(anon, event, { timestampSeconds: Math.floor(Date.now() / 1000) - 3600 });
    expect(res.status()).toBe(400);
  });

  test("the signature covers the body, so altering it after signing is refused", async () => {
    const signed = JSON.stringify(invoicePaid({ organizationId: "00000000-0000-0000-0000-000000000000" }));
    const signature = signStripePayload(signed);
    const tampered = signed.replace('"amount_paid":36000', '"amount_paid":1');

    const res = await anon.post("/api/billing/webhook", {
      headers: { "content-type": "application/json", "stripe-signature": signature },
      data: tampered,
      failOnStatusCode: false,
    });
    expect(res.status()).toBe(400);
  });
});

test.describe("authentication", () => {
  test("every workspace-scoped billing endpoint refuses a caller with no session", async () => {
    for (const endpoint of AUTHENTICATED_ENDPOINTS) {
      const res =
        endpoint.method === "get"
          ? await anon.get(endpoint.path, { failOnStatusCode: false })
          : await anon.post(endpoint.path, { data: {}, failOnStatusCode: false });

      // BillingService.requireUser raises a 400 ("Authentication required") rather than a 401. Both
      // are acceptable refusals here; what matters is that no billing data or Stripe redirect is
      // ever handed to an anonymous caller.
      expect([400, 401]).toContain(res.status());
      expect(res.ok()).toBeFalsy();
    }
  });
});

test.describe("Stripe write paths", () => {
  // Opt-in only. A Checkout Session created against a live account creates a real Customer and
  // permanently pins that workspace's billing currency, which is not something a smoke run should
  // do to an environment by default. Enable with E2E_BILLING_ALLOW_STRIPE_WRITES=true against a
  // deployment configured with a Stripe TEST key.
  test.skip(
    !env.allowStripeWrites,
    "writes to Stripe — set E2E_BILLING_ALLOW_STRIPE_WRITES=true against a test-mode Stripe key",
  );

  test("POST /api/billing/checkout-session returns a hosted Stripe Checkout URL", async ({ request }) => {
    const res = await request.post("/api/billing/checkout-session", {
      data: { interval: "annual" },
      failOnStatusCode: false,
    });

    if (res.status() === 409) {
      // Already subscribed: refusing a second checkout is the correct behaviour, since a duplicate
      // subscription would bill this workspace twice.
      expect((await res.json()).error).toContain("already has an active");
      return;
    }

    expect(res.ok()).toBeTruthy();
    const { url } = await res.json();
    expect(new URL(url).hostname).toContain("stripe.com");
  });

  test("POST /api/billing/portal-session returns a hosted Stripe Billing Portal URL", async ({
    request,
  }) => {
    const res = await request.post("/api/billing/portal-session", { failOnStatusCode: false });

    if (res.status() === 400) {
      // No Stripe customer for this workspace yet — the "no billing account" path is asserted
      // properly in billing-lifecycle.spec.ts, where the customer id is known to be null.
      expect((await res.json()).error).toContain("no billing account");
      return;
    }

    expect(res.ok()).toBeTruthy();
    const { url } = await res.json();
    expect(new URL(url).hostname).toContain("stripe.com");
  });
});
