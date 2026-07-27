import { Module } from "@nestjs/common";
import { PlanLimitsService } from "./plan-limits.service";

@Module({
  providers: [PlanLimitsService],
  exports: [PlanLimitsService]
})
export class PlanLimitsModule {}
