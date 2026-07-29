import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { LegacyModule } from "../legacy/legacy.module";
import { PlanLimitsModule } from "../plan-limits/plan-limits.module";
import { BillingController } from "./billing.controller";
import { BillingService } from "./billing.service";
import { CountryDetectionService } from "./country-detection.service";
import { StripeClientProvider } from "./stripe-client.provider";

// AuthModule is imported for EmailService (billing lifecycle emails). No cycle: AuthModule pulls in
// only AdminModule, and BillingModule is referenced solely by AppModule.
@Module({
  imports: [LegacyModule, PlanLimitsModule, AuthModule],
  controllers: [BillingController],
  providers: [BillingService, StripeClientProvider, CountryDetectionService]
})
export class BillingModule {}
