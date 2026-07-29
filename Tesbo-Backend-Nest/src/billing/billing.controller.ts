import { BadRequestException, Body, Controller, Get, Post, Query, Req } from "@nestjs/common";
import { AuthenticatedRequest } from "../common/request.types";
import { BillingInterval, BillingService } from "./billing.service";

@Controller("/api/billing")
export class BillingController {
  constructor(private readonly billing: BillingService) {}

  @Get()
  getBillingInfo(@Req() req: AuthenticatedRequest) {
    return this.billing.getBillingInfo(req.userId);
  }

  @Get("/usage")
  getUsageSummary(@Req() req: AuthenticatedRequest) {
    return this.billing.getUsageSummary(req.userId);
  }

  // Plan changes, payments, and cancellations for this workspace, newest first.
  @Get("/history")
  getBillingHistory(@Req() req: AuthenticatedRequest, @Query("limit") limit?: string) {
    const parsed = Number(limit);
    return this.billing.getBillingHistory(req.userId, Number.isFinite(parsed) && parsed > 0 ? parsed : undefined);
  }

  // Past invoices, read live from Stripe, with links to the hosted receipt and PDF.
  @Get("/invoices")
  getInvoices(@Req() req: AuthenticatedRequest) {
    return this.billing.getInvoices(req.userId);
  }

  // ?currency=inr|usd states a preference; the server still decides whether it's allowed (INR
  // requires the request to be detected as coming from India). Omit it for pure auto-detection.
  @Get("/pricing")
  getPricing(@Req() req: AuthenticatedRequest, @Query("currency") currency?: string) {
    return this.billing.getPricing(req.userId, req, currency);
  }

  @Post("/checkout-session")
  createCheckoutSession(@Req() req: AuthenticatedRequest, @Body() body: { interval?: BillingInterval; currency?: string }) {
    return this.billing.createCheckoutSession(req.userId, body?.interval as BillingInterval, req, body?.currency);
  }

  // Called when Stripe redirects back from checkout: pulls subscription state straight from Stripe
  // so the upgrade applies even if the webhook is late, dropped, or not configured yet.
  @Post("/reconcile")
  reconcile(@Req() req: AuthenticatedRequest) {
    return this.billing.reconcileFromStripe(req.userId);
  }

  @Post("/portal-session")
  createPortalSession(@Req() req: AuthenticatedRequest) {
    return this.billing.createPortalSession(req.userId);
  }

  @Post("/webhook")
  async handleWebhook(@Req() req: AuthenticatedRequest) {
    const signature = req.headers["stripe-signature"];
    if (Array.isArray(signature)) throw new BadRequestException({ error: "Invalid Stripe signature header" });
    const event = await this.billing.constructWebhookEvent(req.rawBody, signature);
    await this.billing.handleWebhookEvent(event);
    return { received: true };
  }
}
