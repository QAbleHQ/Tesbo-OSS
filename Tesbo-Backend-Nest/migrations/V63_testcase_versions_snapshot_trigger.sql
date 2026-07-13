-- Reactivate testcase_versions (defined in V2, never written to): snapshot the pre-change
-- row before every update, including soft-deletes (which are just an UPDATE that sets
-- deleted_at). This gives full historical content, not just a computed diff.

ALTER TABLE testcase_versions
  ADD COLUMN changed_by UUID REFERENCES actors(id) ON DELETE SET NULL,
  ADD COLUMN change_type VARCHAR(16) NOT NULL DEFAULT 'update' CHECK (change_type IN ('update', 'delete'));

CREATE OR REPLACE FUNCTION testcases_snapshot_before_update() RETURNS trigger AS $$
DECLARE
  next_version INT;
BEGIN
  -- Skip no-op saves (e.g. a PATCH that only touches updated_at/search_vector) so history
  -- isn't spammed with saves that didn't actually change anything meaningful.
  IF (to_jsonb(NEW) - 'updated_at' - 'search_vector') IS NOT DISTINCT FROM (to_jsonb(OLD) - 'updated_at' - 'search_vector') THEN
    RETURN NEW;
  END IF;

  SELECT COALESCE(MAX(version), 0) + 1 INTO next_version FROM testcase_versions WHERE testcase_id = OLD.id;

  INSERT INTO testcase_versions (testcase_id, version, snapshot, changed_by, change_type, created_at)
  VALUES (
    OLD.id,
    next_version,
    to_jsonb(OLD),
    NEW.updated_by,
    CASE WHEN NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL THEN 'delete' ELSE 'update' END,
    now()
  );

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER testcases_snapshot_before_update
  BEFORE UPDATE ON testcases
  FOR EACH ROW EXECUTE PROCEDURE testcases_snapshot_before_update();
