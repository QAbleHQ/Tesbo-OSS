import { BullModule } from "@nestjs/bullmq";
import { Logger, Module, OnModuleInit } from "@nestjs/common";
import { RagChunkingService } from "./rag-chunking.service";
import { RagEmbeddingProcessor } from "./rag-embedding.processor";
import { RagIngestionService } from "./rag-ingestion.service";
import { RagRetrievalService } from "./rag-retrieval.service";
import { RAG_EMBEDDING_QUEUE } from "./rag.constants";

@Module({
  imports: [BullModule.registerQueue({ name: RAG_EMBEDDING_QUEUE })],
  providers: [RagChunkingService, RagEmbeddingProcessor, RagIngestionService, RagRetrievalService],
  exports: [RagIngestionService, RagRetrievalService]
})
export class RagModule implements OnModuleInit {
  private readonly logger = new Logger(RagModule.name);

  constructor(private readonly ingestion: RagIngestionService) {}

  // Same self-healing idiom as LegacyService.resumeInterruptedZyraChatPlans: a backend
  // restart mid-embedding leaves rows stuck in 'queued'/'processing' with nothing to pick
  // them back up (Redis persistence covers a Redis restart, not a backend crash losing an
  // in-flight job) — sweep once at boot and re-enqueue.
  async onModuleInit(): Promise<void> {
    this.ingestion.resumeInterruptedEmbeddings().catch((err) => {
      this.logger.warn(`Failed to resume interrupted embeddings on startup: ${err instanceof Error ? err.message : err}`);
    });
  }
}
