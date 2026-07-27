import { BadGatewayException, BadRequestException, ForbiddenException, Injectable, ServiceUnavailableException } from "@nestjs/common";
import Stripe from "stripe";
import { AppConfigService } from "../config/app-config.service";
import { DatabaseService } from "../database/database.service";
import { LegacyService } from "../legacy/legacy.service";
import { PlanLimitsService, PlanUsageSummary } from "../plan-limits/plan-limits.service";
import { StripeClientProvider } from "./stripe-client.provider";

export type BillingInterval = "monthly" | "annual";
type Currency = "usd" | "inr";

export interface BillingInfo {
  plan: "launch" | "pro";
  billingInterval: BillingInterval | null;
  status: string | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
}

export interface BillingPricing {
  currency: Currency;
  monthlyAmount: number | null;
  annualAmount: number | null;
}

// Subscription statuses that mean the workspace no longer has an active Pro subscription
// (as opposed to e.g. "past_due", where Stripe is still retrying payment and Pro access
// is kept during the grace period).
const ENDED_SUBSCRIPTION_STATUSES = new Set(["canceled", "unpaid", "incomplete_expired"]);

@Injectable()
export class BillingService {
  constructor(
    private readonly db: DatabaseService,
    private readonly config: AppConfigService,
    private readonly stripeClient: StripeClientProvider,
    private readonly legacy: LegacyService,
    private readonly planLimits: PlanLimitsService
  ) {}

  private requireUser(userId?: string | null): string {
    if (!userId) throw new BadRequestException({ error: "Authentication required" });
    return userId;
  }

  private requireOwner(role: string): void {
    if (this.legacy.normalizeRole(role) !== "owner") {
      throw new ForbiddenException({ error: "Only the workspace owner can manage billing" });
    }
  }

  // Stripe SDK errors are plain Error subclasses, not NestJS HttpExceptions, so left
  // uncaught they all surface to the client as a generic "Internal server error" —
  // this turns them into a clear, appropriately-coded response instead.
  private async callStripe<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      if (error instanceof Stripe.errors.StripeConnectionError) {
        throw new ServiceUnavailableException({ error: "Couldn't reach Stripe right now. Please try again in a moment." });
      }
      if (error instanceof Stripe.errors.StripeError) {
        throw new BadGatewayException({ error: `Stripe request failed: ${error.message}` });
      }
      throw error;
    }
  }

  async getBillingInfo(userId: string | null | undefined): Promise<BillingInfo> {
    const uid = this.requireUser(userId);
    const workspace = await this.legacy.workspace(uid);
    const res = await this.db.query(
      `SELECT plan, billing_interval, subscription_status, current_period_end, cancel_at_period_end
       FROM organizations WHERE id = $1`,
      [workspace.id]
    );
    const row = res.rows[0];
    return {
      plan: row?.plan === "pro" ? "pro" : "launch",
      billingInterval: row?.billing_interval ?? null,
      status: row?.subscription_status ?? null,
      currentPeriodEnd: row?.current_period_end ?? null,
      cancelAtPeriodEnd: row?.cancel_at_period_end ?? false
    };
  }

  async getUsageSummary(userId: string | null | undefined): Promise<PlanUsageSummary> {
    const uid = this.requireUser(userId);
    const workspace = await this.legacy.workspace(uid);
    return this.planLimits.getUsageSummary(workspace.id);
  }

  // RBI rules block Indian-issued cards from paying a non-INR amount to an India-registered
  // merchant, so a buyer detected as being in India is quoted and charged in INR instead of
  // USD. Both this method and createCheckoutSession call resolvePriceId with the same
  // detected currency so the amount shown always matches the amount charged.
  async getPricing(ip: string | undefined): Promise<BillingPricing> {
    const currency = await this.resolveCurrency(ip);
    const monthly = this.resolvePriceId("monthly", currency);
    const annual = this.resolvePriceId("annual", currency);

    const [monthlyPrice, annualPrice] = await Promise.all([
      monthly.priceId ? this.callStripe(() => this.stripeClient.client.prices.retrieve(monthly.priceId)) : null,
      annual.priceId ? this.callStripe(() => this.stripeClient.client.prices.retrieve(annual.priceId)) : null
    ]);

    return {
      currency: (monthlyPrice?.currency ?? annualPrice?.currency ?? "usd") as Currency,
      monthlyAmount: monthlyPrice?.unit_amount ?? null,
      annualAmount: annualPrice?.unit_amount ?? null
    };
  }

  async createCheckoutSession(userId: string | null | undefined, interval: BillingInterval, ip: string | undefined): Promise<{ url: string }> {
    const uid = this.requireUser(userId);
    const workspace = await this.legacy.workspace(uid);
    this.requireOwner(workspace.role);

    if (interval !== "monthly" && interval !== "annual") {
      throw new BadRequestException({ error: "interval must be 'monthly' or 'annual'" });
    }
    const currency = await this.resolveCurrency(ip);
    const { priceId } = this.resolvePriceId(interval, currency);
    if (!priceId) throw new BadRequestException({ error: "Stripe is not configured for this plan yet" });

    const customerId = await this.resolveStripeCustomerId(workspace.id, workspace.name);

    const session = await this.callStripe(() =>
      this.stripeClient.client.checkout.sessions.create({
        mode: "subscription",
        customer: customerId,
        line_items: [{ price: priceId, quantity: 1 }],
        success_url: `${this.config.frontendUrl}/settings?tab=billing&checkout=success`,
        cancel_url: `${this.config.frontendUrl}/settings?tab=billing&checkout=cancelled`,
        metadata: { organizationId: workspace.id },
        subscription_data: { metadata: { organizationId: workspace.id } }
      })
    );

    if (!session.url) throw new BadRequestException({ error: "Stripe did not return a checkout URL" });
    return { url: session.url };
  }

  async createPortalSession(userId: string | null | undefined): Promise<{ url: string }> {
    const uid = this.requireUser(userId);
    const workspace = await this.legacy.workspace(uid);
    this.requireOwner(workspace.role);

    const res = await this.db.query<{ stripe_customer_id: string | null }>(
      "SELECT stripe_customer_id FROM organizations WHERE id = $1",
      [workspace.id]
    );
    const customerId = res.rows[0]?.stripe_customer_id;
    if (!customerId) throw new BadRequestException({ error: "This workspace has no billing account yet" });

    const session = await this.callStripe(() =>
      this.stripeClient.client.billingPortal.sessions.create({
        customer: customerId,
        return_url: `${this.config.frontendUrl}/settings?tab=billing`
      })
    );
    return { url: session.url };
  }

  async constructWebhookEvent(rawBody: Buffer | undefined, signature: string | undefined): Promise<Stripe.Event> {
    if (!rawBody || !signature) throw new BadRequestException({ error: "Missing Stripe signature" });
    if (!this.config.stripeWebhookSecret) throw new BadRequestException({ error: "Stripe webhook secret is not configured" });
    return this.stripeClient.client.webhooks.constructEvent(rawBody, signature, this.config.stripeWebhookSecret);
  }

  async handleWebhookEvent(event: Stripe.Event): Promise<void> {
    // Stripe retries webhook deliveries; record the event id first so a re-delivery of an
    // already-processed event is a no-op instead of applying the update twice.
    const inserted = await this.db.query("INSERT INTO stripe_webhook_events (id, type) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING id", [
      event.id,
      event.type
    ]);
    if (inserted.rows.length === 0) return;

    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object as Stripe.Checkout.Session;
        const organizationId = session.metadata?.organizationId;
        const subscriptionId = typeof session.subscription === "string" ? session.subscription : session.subscription?.id;
        if (organizationId && subscriptionId) {
          await this.db.query(
            `UPDATE organizations SET plan = 'pro', stripe_subscription_id = $1, updated_at = now() WHERE id = $2`,
            [subscriptionId, organizationId]
          );
        }
        break;
      }
      case "customer.subscription.created":
      case "customer.subscription.updated":
      case "customer.subscription.deleted": {
        await this.applySubscriptionState(event.data.object as Stripe.Subscription);
        break;
      }
      default:
        break;
    }
  }

  // Picks the Price ID for an interval, preferring the INR price when the buyer is in India
  // and one is configured, otherwise falling back to USD — so checkout never breaks even if
  // an INR price hasn't been set up for a given interval yet.
  private resolvePriceId(interval: BillingInterval, currency: Currency): { priceId: string; currency: Currency } {
    if (currency === "inr") {
      const inrId = interval === "monthly" ? this.config.stripePriceIdProMonthlyInr : this.config.stripePriceIdProAnnualInr;
      if (inrId) return { priceId: inrId, currency: "inr" };
    }
    const usdId = interval === "monthly" ? this.config.stripePriceIdProMonthly : this.config.stripePriceIdProAnnual;
    return { priceId: usdId, currency: "usd" };
  }

  private async resolveCurrency(ip: string | undefined): Promise<Currency> {
    const country = await this.detectCountry(ip);
    return country === "IN" ? "inr" : "usd";
  }

  // Best-effort IP geolocation via a free, keyless lookup — never blocks or fails checkout:
  // any error, timeout, or unrecognized response just falls back to USD (the safe default
  // this app used before India-specific pricing existed).
  //
  // ip-api.com, not ipapi.co: ipapi.co puts unauthenticated/server-side requests behind a
  // Cloudflare JS challenge (confirmed by hand — it returns an HTML challenge page instead
  // of a country code for a plain server-to-server fetch), which would make detection
  // silently always fail. ip-api.com's free tier answers directly with JSON; the tradeoff
  // is HTTP-only (no HTTPS) on that tier, acceptable here since this is a same-datacenter
  // outbound call carrying only an IP address and a country code, not user secrets.
  private async detectCountry(ip: string | undefined): Promise<string | null> {
    if (!ip || this.isPrivateIp(ip)) return null;
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 2000);
      const res = await fetch(`http://ip-api.com/json/${encodeURIComponent(ip)}?fields=countryCode`, { signal: controller.signal });
      clearTimeout(timeout);
      if (!res.ok) return null;
      const body = (await res.json()) as { countryCode?: string };
      const code = body.countryCode?.trim().toUpperCase() ?? "";
      return /^[A-Z]{2}$/.test(code) ? code : null;
    } catch {
      return null;
    }
  }

  private isPrivateIp(ip: string): boolean {
    const v = ip.replace(/^::ffff:/, "");
    return v === "127.0.0.1" || v === "::1" || v.startsWith("10.") || v.startsWith("192.168.") || /^172\.(1[6-9]|2\d|3[01])\./.test(v);
  }

  private async resolveStripeCustomerId(organizationId: string, organizationName: string): Promise<string> {
    const existing = await this.db.query<{ stripe_customer_id: string | null }>(
      "SELECT stripe_customer_id FROM organizations WHERE id = $1",
      [organizationId]
    );
    const current = existing.rows[0]?.stripe_customer_id;
    if (current) return current;

    const customer = await this.callStripe(() =>
      this.stripeClient.client.customers.create({
        name: organizationName,
        metadata: { organizationId }
      })
    );
    await this.db.query("UPDATE organizations SET stripe_customer_id = $1, updated_at = now() WHERE id = $2", [
      customer.id,
      organizationId
    ]);
    return customer.id;
  }

  private async applySubscriptionState(subscription: Stripe.Subscription): Promise<void> {
    const organizationId = subscription.metadata?.organizationId;
    if (!organizationId) return;

    const priceId = subscription.items.data[0]?.price?.id ?? "";
    const monthlyPriceIds = new Set([this.config.stripePriceIdProMonthly, this.config.stripePriceIdProMonthlyInr]);
    const annualPriceIds = new Set([this.config.stripePriceIdProAnnual, this.config.stripePriceIdProAnnualInr]);
    const billingInterval: BillingInterval | null = monthlyPriceIds.has(priceId)
      ? "monthly"
      : annualPriceIds.has(priceId)
        ? "annual"
        : null;
    const periodEndSeconds = subscription.items.data[0]?.current_period_end;
    const plan = ENDED_SUBSCRIPTION_STATUSES.has(subscription.status) ? "launch" : "pro";

    await this.db.query(
      `UPDATE organizations
       SET plan = $1,
           billing_interval = COALESCE($2, billing_interval),
           stripe_subscription_id = $3,
           subscription_status = $4,
           current_period_end = $5,
           cancel_at_period_end = $6,
           updated_at = now()
       WHERE id = $7`,
      [
        plan,
        billingInterval,
        subscription.id,
        subscription.status,
        periodEndSeconds ? new Date(periodEndSeconds * 1000).toISOString() : null,
        subscription.cancel_at_period_end ?? false,
        organizationId
      ]
    );
  }
}
