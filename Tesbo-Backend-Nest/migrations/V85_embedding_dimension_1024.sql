-- Semantic retrieval has never produced a row in production: knowledge_document_chunks is
-- empty everywhere. The cause was rag-ai-allocation.ts refusing any provider except OpenAI,
-- while every allocated key in the product is Anthropic — which has no embeddings endpoint.
--
-- Fixing the allocator (see rag-ai-allocation.ts) opens the door to embeddings-capable
-- providers other than OpenAI. Those providers do not agree on a vector width:
--
--   text-embedding-3-small (OpenAI)   1536 native, reducible via the `dimensions` param
--   gemini-embedding-001 (Google)     configurable output dimensionality
--   mistral-embed (Mistral)           1024 native, not reducible
--   mxbai-embed-large / bge-m3        1024 native (self-hosted, a later step)
--
-- pgvector cannot index mixed widths in one column, so the platform has to pick one. 1024 is
-- the only width every candidate can produce: the two that are natively 1024 cannot be
-- widened, while the two that are natively larger support native reduction down to it.
-- Staying at 1536 would permanently exclude Mistral and every self-hosted open model.
--
-- This is a free change *today* and only today: the table has no rows, so there is nothing to
-- re-embed and no backfill. The moment the first document is indexed, this migration becomes
-- a re-embed of the entire corpus. Hence the guard below rather than a silent ALTER.

DO $$
DECLARE
  chunk_count BIGINT;
BEGIN
  SELECT count(*) INTO chunk_count FROM knowledge_document_chunks;
  IF chunk_count > 0 THEN
    RAISE EXCEPTION
      'V85 refuses to run: knowledge_document_chunks holds % row(s). Changing the vector width would silently discard them. Re-embed deliberately instead: truncate the table, run this migration, then reset embedding_status to reindex.',
      chunk_count;
  END IF;
END $$;

-- The HNSW index is bound to the column's declared width, so it cannot survive the ALTER.
-- Both are declared on the partitioned parent and propagate to all 64 partitions.
DROP INDEX IF EXISTS idx_kdc_embedding;

ALTER TABLE knowledge_document_chunks
  ALTER COLUMN embedding TYPE vector(1024);

CREATE INDEX IF NOT EXISTS idx_kdc_embedding
  ON knowledge_document_chunks USING hnsw (embedding vector_cosine_ops);

-- Every existing source was marked 'unsupported' by rag-embedding.processor.ts when the
-- allocator returned null — that status is how the outage physically recorded itself.
-- resumeInterruptedEmbeddings() only re-enqueues pending/queued/processing, so without this
-- reset the allocator fix would apply to new uploads only and the existing corpus would stay
-- dark forever. Reset to 'pending' so the boot-time sweep picks them up.
--
-- 'unsupported' is also the honest status for a source with no extractable text. Re-queuing
-- those costs one no-op pass through the processor, which marks them unsupported again and
-- makes no API call — cheaper than trying to distinguish the two cases retroactively.
UPDATE knowledge_documents
   SET embedding_status = 'pending'
 WHERE embedding_status = 'unsupported'
   AND is_deleted = false;

UPDATE knowledge_files
   SET embedding_status = 'pending'
 WHERE embedding_status = 'unsupported'
   AND is_deleted = false;
