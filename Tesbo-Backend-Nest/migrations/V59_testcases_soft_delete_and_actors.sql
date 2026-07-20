-- Test cases: track who created/updated/deleted each row (human or AI agent), and switch
-- deletes from hard DELETE to soft-delete so a removed test case remains auditable.

ALTER TABLE testcases
  ADD COLUMN created_by UUID REFERENCES actors(id) ON DELETE SET NULL,
  ADD COLUMN updated_by UUID REFERENCES actors(id) ON DELETE SET NULL,
  ADD COLUMN deleted_at TIMESTAMPTZ,
  ADD COLUMN deleted_by UUID REFERENCES actors(id) ON DELETE SET NULL;

-- Best-effort backfill: real creator was never tracked historically, owner_id is the
-- closest proxy for existing rows.
UPDATE testcases SET created_by = owner_id, updated_by = owner_id WHERE owner_id IS NOT NULL;

-- Repoint owner_id from users(id) to actors(id). Every stored value is already backfilled
-- into actors (V58), so no data changes — this only widens what the column can point at.
ALTER TABLE testcases DROP CONSTRAINT testcases_owner_id_fkey;
ALTER TABLE testcases ADD CONSTRAINT testcases_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES actors(id) ON DELETE SET NULL;

CREATE INDEX idx_testcases_active ON testcases(project_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_testcases_deleted_by ON testcases(deleted_by);
