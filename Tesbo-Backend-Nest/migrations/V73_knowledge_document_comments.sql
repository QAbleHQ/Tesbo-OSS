-- Document comments, replacing V72's per-ticket "Notes" sibling document.
--
-- V72 gave every synced ticket a second, human-owned document because the mirror itself is
-- overwritten on each sync and therefore read-only. A comment thread is the better home for that
-- input: it lives on the document being discussed (rather than beside it), it survives the body
-- being rewritten because it is stored separately from the body, and it works the way people
-- already expect from Google Docs — select a passage, comment on it, reply, resolve.
--
-- This also means "read-only" now only describes the *body*. Anyone with project access can
-- comment on a synced document.

CREATE TABLE knowledge_document_comments (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id   UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    project_id        UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    document_id       UUID NOT NULL REFERENCES knowledge_documents(id) ON DELETE CASCADE,
    -- NULL for a thread root; set for a reply. Threads are one level deep, like Google Docs —
    -- enforced in the service, since a CHECK can't see the parent row.
    parent_comment_id UUID REFERENCES knowledge_document_comments(id) ON DELETE CASCADE,
    author_id         UUID REFERENCES users(id) ON DELETE SET NULL,
    body              TEXT NOT NULL,
    -- The anchor is the quoted selection plus its offsets into content_text at the time of
    -- commenting. anchor_text is what re-anchoring actually matches on; the offsets are only a
    -- hint for picking the right occurrence. A sync that rewrites the body around an unchanged
    -- quote keeps the anchor working; one that deletes the quote leaves the comment orphaned
    -- (still shown, just no longer tied to a passage) rather than destroying it.
    anchor_text       TEXT,
    anchor_start      INTEGER,
    anchor_end        INTEGER,
    is_resolved       BOOLEAN NOT NULL DEFAULT false,
    resolved_by       UUID REFERENCES users(id) ON DELETE SET NULL,
    resolved_at       TIMESTAMPTZ,
    is_deleted        BOOLEAN NOT NULL DEFAULT false,
    deleted_at        TIMESTAMPTZ,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT knowledge_document_comments_body_not_blank CHECK (length(btrim(body)) > 0),
    -- A reply belongs to its thread's anchor; it never carries one of its own.
    CONSTRAINT knowledge_document_comments_reply_shape
      CHECK (parent_comment_id IS NULL OR (anchor_text IS NULL AND anchor_start IS NULL AND anchor_end IS NULL)),
    -- Resolution is a thread-level action, so only roots may be resolved.
    CONSTRAINT knowledge_document_comments_resolve_shape
      CHECK (parent_comment_id IS NULL OR is_resolved = false)
);

-- Serves the per-document thread fetch (the only read path that matters).
CREATE INDEX idx_kb_doc_comments_document ON knowledge_document_comments(document_id, created_at)
  WHERE is_deleted = false;
CREATE INDEX idx_kb_doc_comments_parent ON knowledge_document_comments(parent_comment_id)
  WHERE is_deleted = false;

-- ── Retire V72's Notes documents ──
-- Two cases, so nobody loses writing:
--   * Never edited (updated_at still equals created_at) — the untouched skeleton V72 generated.
--     Soft-deleted; it carried no human content.
--   * Edited — someone wrote in it. Kept, but detached from the integration so it survives as an
--     ordinary Knowledge Base document that sync no longer manages or reconciles.
UPDATE knowledge_documents
SET is_deleted = true, deleted_at = now(), updated_at = now()
WHERE source_role = 'notes' AND is_deleted = false AND updated_at = created_at;

UPDATE knowledge_documents
SET source_provider = NULL, source_external_id = NULL, source_role = NULL, source_url = NULL, updated_at = now()
WHERE source_role = 'notes' AND is_deleted = false;

-- source_role is left in place: with 'notes' retired it is always 'mirror' for provider-owned
-- documents, and it remains part of idx_knowledge_documents_source (V72), which is what scopes a
-- mirror to one row per project.
COMMENT ON COLUMN knowledge_documents.source_role IS
  '''mirror'' = provider-owned body, rewritten by every sync and read-only in the editor. NULL for ordinary documents. (V72''s ''notes'' role was retired in V73 in favour of knowledge_document_comments.)';
