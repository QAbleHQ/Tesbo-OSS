import { Global, Module } from "@nestjs/common";
import { AppConfigService } from "./app-config.service";
import { EmailDeliveryPolicy } from "./email-delivery.policy";

// EmailDeliveryPolicy lives here rather than beside EmailService in AuthModule because the admin
// health controller reports on it too, and AuthModule already imports AdminModule — the reverse
// edge would be a cycle. This module is @Global, so both sides just inject it.
@Global()
@Module({
  providers: [AppConfigService, EmailDeliveryPolicy],
  exports: [AppConfigService, EmailDeliveryPolicy]
})
export class ConfigModule {}
