import { Module } from "@nestjs/common";
import { LegacyModule } from "../legacy/legacy.module";
import { PlanLimitsModule } from "../plan-limits/plan-limits.module";
import { BillingController } from "./billing.controller";
import { BillingService } from "./billing.service";
import { StripeClientProvider } from "./stripe-client.provider";

@Module({
  imports: [LegacyModule, PlanLimitsModule],
  controllers: [BillingController],
  providers: [BillingService, StripeClientProvider]
})
export class BillingModule {}
