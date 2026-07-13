-- Chunk + embedding storage for Zyra's semantic knowledge-base retrieval. One row per
-- chunk of a knowledge_documents or knowledge_files row (source_type/source_id — no FK,
-- since a single table can't reference two different parent tables; enforced in app code).
--
-- Partitioned by HASH(project_id) into a FIXED 64 buckets, not one partition per project —
-- this stays bounded as the number of projects/organizations grows (avoids the partition-
-- explosion problem of partition-per-tenant), while a literal `project_id = $1` filter still
-- lets Postgres prune straight to one bucket before touching that bucket's HNSW index.
CREATE TABLE knowledge_document_chunks (
    id                UUID NOT NULL DEFAULT gen_random_uuid(),
    organization_id   UUID NOT NULL,
    project_id        UUID NOT NULL,
    source_type       VARCHAR(16) NOT NULL CHECK (source_type IN ('document', 'file')),
    source_id         UUID NOT NULL,
    chunk_index       INT NOT NULL,
    heading_path      TEXT,
    content           TEXT NOT NULL,
    token_count       INT NOT NULL,
    content_hash      TEXT NOT NULL,
    embedding_model   VARCHAR(128) NOT NULL,
    embedding         vector(1536),
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (id, project_id)
) PARTITION BY HASH (project_id);

DO $$
BEGIN
  FOR i IN 0..63 LOOP
    EXECUTE format(
      'CREATE TABLE knowledge_document_chunks_p%1$s PARTITION OF knowledge_document_chunks FOR VALUES WITH (MODULUS 64, REMAINDER %1$s)',
      i
    );
  END LOOP;
END $$;

-- Propagates automatically to all 64 partitions as a single partitioned index.
CREATE UNIQUE INDEX idx_kdc_unique ON knowledge_document_chunks(project_id, source_type, source_id, chunk_index);
CREATE INDEX idx_kdc_source ON knowledge_document_chunks(project_id, source_type, source_id);
CREATE INDEX idx_kdc_embedding ON knowledge_document_chunks USING hnsw (embedding vector_cosine_ops);
