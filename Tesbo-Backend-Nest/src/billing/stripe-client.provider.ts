import { Injectable } from "@nestjs/common";
import Stripe from "stripe";
import { AppConfigService } from "../config/app-config.service";

@Injectable()
export class StripeClientProvider {
  readonly client: Stripe;

  constructor(config: AppConfigService) {
    this.client = new Stripe(config.stripeSecretKey || "sk_test_not_configured");
  }
}
