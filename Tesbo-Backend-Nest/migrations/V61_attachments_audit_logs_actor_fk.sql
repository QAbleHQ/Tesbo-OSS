-- Repoint the remaining human-only actor FKs (evidence uploader, audit log actor) at
-- actors(id) so an AI agent can also be the recorded uploader/actor.

ALTER TABLE attachments DROP CONSTRAINT attachments_uploaded_by_fkey;
ALTER TABLE attachments ADD CONSTRAINT attachments_uploaded_by_fkey FOREIGN KEY (uploaded_by) REFERENCES actors(id) ON DELETE SET NULL;

ALTER TABLE audit_logs DROP CONSTRAINT audit_logs_actor_id_fkey;
ALTER TABLE audit_logs ADD CONSTRAINT audit_logs_actor_id_fkey FOREIGN KEY (actor_id) REFERENCES actors(id) ON DELETE SET NULL;
