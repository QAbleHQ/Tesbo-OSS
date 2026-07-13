-- Executions: track who recorded each result (human or AI agent) and switch deletes to
-- soft-delete, matching the same treatment given to testcases in V59.

ALTER TABLE executions
  ADD COLUMN executed_by UUID REFERENCES actors(id) ON DELETE SET NULL,
  ADD COLUMN deleted_at TIMESTAMPTZ,
  ADD COLUMN deleted_by UUID REFERENCES actors(id) ON DELETE SET NULL;

-- Repoint assignee_id from users(id) to actors(id) — same reasoning as testcases.owner_id.
ALTER TABLE executions DROP CONSTRAINT executions_assignee_id_fkey;
ALTER TABLE executions ADD CONSTRAINT executions_assignee_id_fkey FOREIGN KEY (assignee_id) REFERENCES actors(id) ON DELETE SET NULL;

CREATE INDEX idx_executions_active ON executions(cycle_item_id) WHERE deleted_at IS NULL;
