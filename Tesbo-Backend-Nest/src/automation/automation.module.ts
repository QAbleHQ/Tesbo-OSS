import { Module } from "@nestjs/common";
import { LegacyModule } from "../legacy/legacy.module";
import { PlanLimitsModule } from "../plan-limits/plan-limits.module";
import { StorageModule } from "../storage/storage.module";
import { AutomationController } from "./automation.controller";
import { AutomationService } from "./automation.service";

/**
 * Automation ingest (Basecamp 10189985971).
 *
 * No forwardRef needed: this module depends on LegacyModule but nothing in Legacy depends back on
 * it — the ingest is a new surface over the existing cycle/execution services, not a participant
 * in them.
 */
@Module({
  imports: [LegacyModule, PlanLimitsModule, StorageModule],
  controllers: [AutomationController],
  providers: [AutomationService],
  exports: [AutomationService]
})
export class AutomationModule {}
