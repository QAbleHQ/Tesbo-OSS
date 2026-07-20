-- Make audit_logs tamper-evident. Two layers, because a trigger alone does not stop a
-- table OWNER (or a superuser) from disabling/dropping the trigger itself:
--
-- 1. A BEFORE UPDATE/DELETE/TRUNCATE trigger that rejects any mutation, for every role.
-- 2. A dedicated `tesbo_app` role that does NOT own audit_logs and has UPDATE/DELETE/
--    TRUNCATE revoked on it, so it cannot alter/disable/drop the trigger either.
--    The running application should connect as `tesbo_app` going forward; the migration
--    runner keeps using the existing owning/admin role. This is a deployment/env-var
--    change (DATABASE_USER/DATABASE_PASSWORD for the app process), not a code change.
--
-- Every existing write path to audit_logs (AuditService.log(), logProjectActivity()) only
-- ever INSERTs, so none of this affects existing behavior.

CREATE OR REPLACE FUNCTION audit_logs_prevent_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_logs is append-only: % is not permitted', TG_OP
    USING ERRCODE = 'restrict_violation';
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_logs_immutable
  BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE PROCEDURE audit_logs_prevent_mutation();

CREATE TRIGGER audit_logs_no_truncate
  BEFORE TRUNCATE ON audit_logs
  FOR EACH STATEMENT EXECUTE PROCEDURE audit_logs_prevent_mutation();

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tesbo_app') THEN
    -- No usable password here on purpose: set the real credential out-of-band via
    -- `ALTER ROLE tesbo_app WITH PASSWORD '...'` from a secrets manager / ops step,
    -- never committed to a migration file.
    CREATE ROLE tesbo_app LOGIN;
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO tesbo_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO tesbo_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO tesbo_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO tesbo_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO tesbo_app;

REVOKE UPDATE, DELETE, TRUNCATE ON audit_logs FROM tesbo_app;
REVOKE UPDATE, DELETE, TRUNCATE ON audit_logs FROM PUBLIC;
