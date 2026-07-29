import { BullModule } from "@nestjs/bullmq";
import { Logger, Module, OnModuleInit } from "@nestjs/common";
import { RagModule } from "../rag/rag.module";
import { IntegrationSyncClient } from "./integration-sync.client";
import { IntegrationSyncDecisions } from "./integration-sync-decisions";
import { IntegrationSyncDocumentBuilder } from "./integration-sync-document.builder";
import { IntegrationSyncProcessor } from "./integration-sync.processor";
import { IntegrationSyncService } from "./integration-sync.service";
import { INTEGRATION_SYNC_QUEUE } from "./integration-sync.constants";

/**
 * Ticket-tracker -> Knowledge Base sync pipeline.
 *
 * Imports RagModule (to enqueue embeddings for the documents it writes) and is itself imported by
 * LegacyModule. The dependency arrow only ever points this way: nothing here may import
 * LegacyModule, which is why the module carries its own provider client (integration-sync.client)
 * and AI allocation (integration-sync-decisions) instead of reusing LegacyService's.
 */
@Module({
  imports: [BullModule.registerQueue({ name: INTEGRATION_SYNC_QUEUE }), RagModule],
  providers: [IntegrationSyncService, IntegrationSyncClient, IntegrationSyncDocumentBuilder, IntegrationSyncDecisions, IntegrationSyncProcessor],
  exports: [IntegrationSyncService]
})
export class IntegrationSyncModule implements OnModuleInit {
  private readonly logger = new Logger(IntegrationSyncModule.name);

  constructor(private readonly sync: IntegrationSyncService) {}

  async onModuleInit(): Promise<void> {
    this.sync.resumeInterruptedRuns().catch((err) => {
      this.logger.warn(`Failed to resume interrupted sync runs on startup: ${err instanceof Error ? err.message : err}`);
    });
  }
}
