-- Convenience views over the soft-deleted tables so simple read call sites can switch
-- `FROM testcases` / `FROM executions` to these with a one-word change instead of adding
-- `deleted_at IS NULL` to every query by hand.

CREATE VIEW testcases_active AS SELECT * FROM testcases WHERE deleted_at IS NULL;
CREATE VIEW executions_active AS SELECT * FROM executions WHERE deleted_at IS NULL;
