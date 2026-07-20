-- Tracks embedding pipeline progress per knowledge source, mirroring the existing
-- extraction_status convention on knowledge_files (V51). 'unsupported' means the project's
-- allocated AI key can't produce embeddings (e.g. Anthropic-only) — Zyra falls back to the
-- existing keyword/full-text knowledgeSnapshot() path for that project rather than failing.
ALTER TABLE knowledge_documents
  ADD COLUMN embedding_status VARCHAR(16) NOT NULL DEFAULT 'pending'
    CHECK (embedding_status IN ('pending', 'queued', 'processing', 'ready', 'failed', 'unsupported')),
  ADD COLUMN embedding_content_hash TEXT;

ALTER TABLE knowledge_files
  ADD COLUMN embedding_status VARCHAR(16) NOT NULL DEFAULT 'pending'
    CHECK (embedding_status IN ('pending', 'queued', 'processing', 'ready', 'failed', 'unsupported')),
  ADD COLUMN embedding_content_hash TEXT;
