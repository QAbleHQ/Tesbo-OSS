import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { PlanLimitsService } from "./plan-limits.service";

// AuthModule provides EmailService, used for the storage-threshold and grace-period-ended
// notifications. No cycle: AuthModule imports only AdminModule, which imports nothing.
@Module({
  imports: [AuthModule],
  providers: [PlanLimitsService],
  exports: [PlanLimitsService]
})
export class PlanLimitsModule {}
