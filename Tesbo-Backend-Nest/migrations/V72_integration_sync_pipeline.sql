-- Integration -> Knowledge Base sync pipeline v2.
--
-- Four changes, all in service of the same goal: make a Jira/Linear sync a tracked,
-- resumable background job whose output is a self-describing Knowledge Base document.
--   1. Exactly one mapped remote project (Jira project / Linear team) per Tesbo project.
--   2. Ticket comments + an AI-distilled decision summary cached alongside each ticket.
--   3. Mirrored KB documents carry provider/actor attribution and are read-only, with a
--      sibling editable "Notes" document per ticket (source_role distinguishes the two).
--   4. integration_sync_runs backs the live progress UI.

-- ── 1. One enabled remote-project mapping per Tesbo project ──
-- Keep the oldest enabled mapping per project, disable the rest (never delete: the tickets
-- and KB documents those mappings already produced stay valid and referenced).
UPDATE jira_project_mappings m
SET enabled = false
WHERE m.enabled = true
  AND m.id <> (
    SELECT keep.id FROM jira_project_mappings keep
    WHERE keep.project_id = m.project_id AND keep.enabled = true
    ORDER BY keep.created_at ASC, keep.id ASC
    LIMIT 1
  );

UPDATE linear_project_mappings m
SET enabled = false
WHERE m.enabled = true
  AND m.id <> (
    SELECT keep.id FROM linear_project_mappings keep
    WHERE keep.project_id = m.project_id AND keep.enabled = true
    ORDER BY keep.created_at ASC, keep.id ASC
    LIMIT 1
  );

CREATE UNIQUE INDEX idx_jira_project_mappings_one_per_project
  ON jira_project_mappings(project_id) WHERE enabled = true;
CREATE UNIQUE INDEX idx_linear_project_mappings_one_per_project
  ON linear_project_mappings(project_id) WHERE enabled = true;

-- ── 2. Cached comments + decision summary per ticket ──
-- comments_hash gates re-composition of the KB document; decision_summary_hash gates the
-- (paid) AI summarization call, so an unchanged discussion is never re-summarized.
ALTER TABLE jira_tickets
  ADD COLUMN comments_json           JSONB,
  ADD COLUMN comments_count          INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN comments_hash           VARCHAR(64),
  ADD COLUMN decision_summary        TEXT,
  ADD COLUMN decision_summary_hash   VARCHAR(64);

ALTER TABLE linear_tickets
  ADD COLUMN comments_json           JSONB,
  ADD COLUMN comments_count          INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN comments_hash           VARCHAR(64),
  ADD COLUMN decision_summary        TEXT,
  ADD COLUMN decision_summary_hash   VARCHAR(64);

-- ── 3. KB document attribution, read-only flag, and mirror/notes roles ──
ALTER TABLE knowledge_documents
  ADD COLUMN source_role      VARCHAR(32),
  ADD COLUMN source_synced_by UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN source_synced_at TIMESTAMPTZ,
  ADD COLUMN is_read_only     BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN knowledge_documents.source_role IS
  '''mirror'' = provider-owned, overwritten every sync, read-only in the editor. ''notes'' = human-owned sibling doc for the same ticket, never touched by sync.';

-- Everything mirrored before this migration is a provider-owned mirror, and becomes
-- read-only from here on.
UPDATE knowledge_documents
SET source_role = 'mirror', is_read_only = true, source_synced_at = updated_at
WHERE source_provider IS NOT NULL;

-- V45's unique index omitted project_id, so a single Jira issue could only ever be mirrored
-- into ONE Tesbo project install-wide: a second project mapped to the same Jira project
-- silently UPDATEd the first project's document (the ON CONFLICT DO UPDATE never touched
-- project_id/folder_id) and got nothing of its own. Scope the constraint per project, and
-- per role so a ticket's mirror and notes documents can coexist.
DROP INDEX IF EXISTS idx_knowledge_documents_source;
CREATE UNIQUE INDEX idx_knowledge_documents_source
  ON knowledge_documents(project_id, source_provider, source_external_id, source_role)
  WHERE source_provider IS NOT NULL AND is_deleted = false;

-- ── 4. Sync run tracking (drives the progress UI) ──
CREATE TABLE integration_sync_runs (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id     UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    project_id          UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    provider            VARCHAR(32) NOT NULL,
    connection_id       UUID REFERENCES integration_connections(id) ON DELETE SET NULL,
    remote_project_key  VARCHAR(64),
    -- queued -> running -> succeeded | partial (some tickets failed) | failed
    status              VARCHAR(24) NOT NULL DEFAULT 'queued',
    -- Human-facing sub-step, surfaced verbatim in the UI.
    stage               VARCHAR(48) NOT NULL DEFAULT 'queued',
    triggered_by        UUID REFERENCES users(id) ON DELETE SET NULL,
    total_tickets       INTEGER NOT NULL DEFAULT 0,
    processed_tickets   INTEGER NOT NULL DEFAULT 0,
    failed_tickets      INTEGER NOT NULL DEFAULT 0,
    documents_created   INTEGER NOT NULL DEFAULT 0,
    documents_updated   INTEGER NOT NULL DEFAULT 0,
    comments_synced     INTEGER NOT NULL DEFAULT 0,
    decision_summaries  INTEGER NOT NULL DEFAULT 0,
    error               TEXT,
    started_at          TIMESTAMPTZ,
    finished_at         TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT integration_sync_runs_status_check
      CHECK (status IN ('queued', 'running', 'succeeded', 'partial', 'failed'))
);

-- Serves the "latest run for this project+provider" poll the UI does while syncing.
CREATE INDEX idx_integration_sync_runs_lookup
  ON integration_sync_runs(project_id, provider, created_at DESC);

-- At most one in-flight run per project+provider: a second Sync click while one is still
-- going returns the existing run rather than double-fetching the whole backlog.
CREATE UNIQUE INDEX idx_integration_sync_runs_active
  ON integration_sync_runs(project_id, provider) WHERE status IN ('queued', 'running');
