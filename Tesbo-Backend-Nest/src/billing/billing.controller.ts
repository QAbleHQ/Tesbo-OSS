import { BadRequestException, Body, Controller, Get, Post, Req } from "@nestjs/common";
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

  @Get("/pricing")
  getPricing(@Req() req: AuthenticatedRequest) {
    return this.billing.getPricing(req.ip);
  }

  @Post("/checkout-session")
  createCheckoutSession(@Req() req: AuthenticatedRequest, @Body() body: { interval?: BillingInterval }) {
    return this.billing.createCheckoutSession(req.userId, body?.interval as BillingInterval, req.ip);
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
