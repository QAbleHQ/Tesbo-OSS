import { OnWorkerEvent, Processor, WorkerHost } from "@nestjs/bullmq";
import { Logger } from "@nestjs/common";
import { createHash } from "crypto";
import type { Job } from "bullmq";
import { DatabaseService } from "../database/database.service";
import { embedTexts, resolveEmbeddingAllocation } from "./rag-ai-allocation";
import { RagChunkingService } from "./rag-chunking.service";
import { RAG_EMBEDDING_BATCH_SIZE, RAG_EMBEDDING_DIMENSION, RAG_EMBEDDING_QUEUE } from "./rag.constants";
import { EmbeddingJobPayload } from "./rag.types";

// Consumer side of the embedding pipeline. Deliberately resolves its own AI-key allocation
// (via rag-ai-allocation.ts) rather than importing LegacyService, to avoid a circular
// LegacyModule <-> RagModule dependency (LegacyModule needs RagIngestionService/
// RagRetrievalService; this module must not need anything back from LegacyModule).
@Processor(RAG_EMBEDDING_QUEUE)
export class RagEmbeddingProcessor extends WorkerHost {
  private readonly logger = new Logger(RagEmbeddingProcessor.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly chunking: RagChunkingService
  ) {
    super();
  }

  async process(job: Job<EmbeddingJobPayload>): Promise<void> {
    const { projectId, sourceType, sourceId } = job.data;
    const table = sourceType === "document" ? "knowledge_documents" : "knowledge_files";
    const contentColumn = sourceType === "document" ? "content_text" : "extracted_text";

    const sourceRes = await this.db.query<{ id: string; organization_id: string; content: string | null; embedding_content_hash: string | null }>(
      `SELECT id, organization_id, ${contentColumn} AS content, embedding_content_hash FROM ${table} WHERE id = $1 AND project_id = $2 AND is_deleted = false`,
      [sourceId, projectId]
    );
    const source = sourceRes.rows[0];
    // Not found here means soft-deleted (is_deleted=true) or gone since the job was queued —
    // either way there's nothing to embed. Explicitly clear the status rather than leaving it
    // stuck at 'queued' forever (setStatus works fine against a soft-deleted row; it just
    // stays excluded from retrieval via the is_deleted filter regardless of this status).
    if (!source) {
      await this.setStatus(table, sourceId, "unsupported").catch(() => undefined);
      return;
    }

    const content = String(source.content || "").trim();
    if (!content) {
      await this.setStatus(table, sourceId, "unsupported");
      return;
    }

    const { allocation, reason } = await resolveEmbeddingAllocation(this.db, projectId);
    if (!allocation) {
      // Deliberately 'pending', not 'unsupported'. 'unsupported' means *this source* can never
      // be embedded (no extractable text); it is terminal, and resumeInterruptedEmbeddings()
      // never revisits it. A missing workspace key is not a property of the source at all — it
      // is a temporary state of the workspace that ends the moment someone adds a key. Marking
      // it terminal is what left 1,237 documents and 43 files permanently dark once the
      // OpenAI-only allocator started refusing every Anthropic project. Leaving it pending lets
      // the boot-time sweep pick it up for free as soon as a key exists.
      this.logger.warn(`Cannot embed ${sourceType}:${sourceId} — ${reason}`);
      await this.setStatus(table, sourceId, "pending");
      return;
    }

    const contentHash = createHash("sha256").update(content).digest("hex");
    if (contentHash === source.embedding_content_hash) return;

    await this.setStatus(table, sourceId, "processing");

    const chunks = this.chunking.chunk(content);
    if (!chunks.length) {
      await this.setStatus(table, sourceId, "unsupported");
      return;
    }

    const embeddings: number[][] = [];
    for (let i = 0; i < chunks.length; i += RAG_EMBEDDING_BATCH_SIZE) {
      const batch = chunks.slice(i, i + RAG_EMBEDDING_BATCH_SIZE);
      const vectors = await embedTexts(allocation, batch.map((c) => c.content));
      embeddings.push(...vectors);
    }

    await this.db.transaction(async (client) => {
      await client.query("DELETE FROM knowledge_document_chunks WHERE project_id = $1 AND source_type = $2 AND source_id = $3", [
        projectId,
        sourceType,
        sourceId
      ]);
      for (let i = 0; i < chunks.length; i += 1) {
        const chunk = chunks[i];
        const vector = embeddings[i];
        // Width is checked against the platform constant, which is what the column and its
        // HNSW index are declared at — not against whatever the provider happened to return.
        // A mismatch means the model or its `dimensions` handling is misconfigured; skipping
        // is the only safe response, because slicing a non-Matryoshka vector to fit would
        // store something that indexes cleanly and ranks nonsense.
        if (!vector || vector.length !== RAG_EMBEDDING_DIMENSION) {
          this.logger.warn(
            `Discarding chunk ${chunk.chunkIndex} of ${sourceType}:${sourceId} — ${allocation.provider}/${allocation.model} returned ${vector?.length ?? 0} dimensions, expected ${RAG_EMBEDDING_DIMENSION}.`
          );
          continue;
        }
        await client.query(
          `INSERT INTO knowledge_document_chunks
             (organization_id, project_id, source_type, source_id, chunk_index, heading_path, content, token_count, content_hash, embedding_model, embedding)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::vector)`,
          [
            source.organization_id,
            projectId,
            sourceType,
            sourceId,
            chunk.chunkIndex,
            chunk.headingPath,
            chunk.content,
            chunk.tokenCount,
            contentHash,
            allocation.model,
            `[${vector.join(",")}]`
          ]
        );
      }
    });

    await this.db.query(`UPDATE ${table} SET embedding_status = 'ready', embedding_content_hash = $2, updated_at = now() WHERE id = $1`, [
      sourceId,
      contentHash
    ]);
  }

  @OnWorkerEvent("failed")
  async onFailed(job: Job<EmbeddingJobPayload> | undefined): Promise<void> {
    if (!job || job.attemptsMade < (job.opts.attempts || 1)) return;
    const table = job.data.sourceType === "document" ? "knowledge_documents" : "knowledge_files";
    await this.setStatus(table, job.data.sourceId, "failed").catch(() => undefined);
    this.logger.warn(`Embedding job permanently failed for ${job.data.sourceType}:${job.data.sourceId}`);
  }

  private async setStatus(table: string, sourceId: string, status: string): Promise<void> {
    await this.db.query(`UPDATE ${table} SET embedding_status = $2, updated_at = now() WHERE id = $1`, [sourceId, status]);
  }
}
