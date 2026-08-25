-- Automation Integration — Test Execution API (Basecamp 10189985971, slice 1).
--
-- An automated run is a `cycles` row and each automated result is an `executions` row: the
-- ingest deliberately does NOT introduce a parallel run/result model. `cycle_items` is already
-- UNIQUE (cycle_id, testcase_id) and `executions` is already UNIQUE (cycle_item_id), so the
-- card's "upsert on (run_id, case_id), never duplicate on a CI retry" is enforced by the schema
-- rather than by application code. Everything below is the metadata those two tables were
-- missing, not a new place to put results.
--
-- NOT touched, on purpose: `automation_runs`, `automation_jobs` and `execution_automation_reports`
-- (V22-V25, V30). Those model Tesbo *executing* a customer's tests from a worker queue --
-- `script`, `start_url`, `worker_id`, `shard_index`, `execution_provider` -- which is the inverse
-- of this feature, where the customer's framework runs the tests and reports results in. No
-- TypeScript references any of the three. They are left alone rather than repurposed so neither
-- feature inherits the other's assumptions.

-- --------------------------------------------------------------------------------------------
-- cycles: mark a run as automated and record where it came from
-- --------------------------------------------------------------------------------------------

ALTER TABLE cycles
  ADD COLUMN source        VARCHAR(16)  NOT NULL DEFAULT 'manual',
  ADD COLUMN triggered_by  VARCHAR(32),
  ADD COLUMN commit_sha    VARCHAR(64),
  ADD COLUMN branch_name   VARCHAR(255),
  ADD COLUMN build_url     VARCHAR(1024),
  ADD COLUMN closed_at     TIMESTAMPTZ,
  ADD COLUMN close_status  VARCHAR(16),
  ADD COLUMN last_result_at TIMESTAMPTZ;

-- 'manual' is the existing 328 rows and every run a person creates in the UI. The default keeps
-- this migration a metadata-only change on those rows.
ALTER TABLE cycles
  ADD CONSTRAINT cycles_source_check CHECK (source IN ('manual', 'automation'));

-- Bounded rather than free text so a typo in a CI config is refused at the API boundary instead
-- of becoming a new value nobody can group or filter by. 'other' is the escape hatch.
/*
 * How an automated run ended, NULL while it is still open.
 *
 * Deliberately not a fourth value in cycles.status. That column's vocabulary is exactly
 * Planning / In Progress / Completed, and the runs list filters, sorts and counts on all three
 * (STATUS_SORT_ORDER in cycles/page.tsx). Adding 'Incomplete' there would silently drop
 * abandoned runs out of every existing filter. A closed run is 'Completed' either way; this says
 * whether it got there by closing itself or by being swept up after its process died.
 */
ALTER TABLE cycles
  ADD CONSTRAINT cycles_close_status_check CHECK (
    close_status IS NULL OR close_status IN ('completed', 'incomplete')
  );

ALTER TABLE cycles
  ADD CONSTRAINT cycles_triggered_by_check CHECK (
    triggered_by IS NULL OR triggered_by IN (
      'local', 'github-actions', 'jenkins', 'gitlab-ci', 'circleci',
      'azure-pipelines', 'bitbucket-pipelines', 'other'
    )
  );

/*
 * external_id (added unused in V28) becomes the CI idempotency key: a workflow re-run that
 * presents the same key resolves to the run it already created instead of opening a second one.
 * A partial index because the column is NULL on all 328 existing rows and stays NULL for every
 * manually created run -- only automation supplies one, and only automation needs it unique.
 */
CREATE UNIQUE INDEX idx_cycles_project_external_id
  ON cycles (project_id, external_id)
  WHERE external_id IS NOT NULL;

-- Drives the stale-run sweeper (a later slice) and the "still running" indicator: a run whose
-- last result arrived hours ago and which never got a close call is abandoned, not in progress.
CREATE INDEX idx_cycles_open_automation
  ON cycles (last_result_at)
  WHERE source = 'automation' AND closed_at IS NULL;

COMMENT ON COLUMN cycles.source IS
  'manual = created by a person in the UI/API; automation = created by a framework SDK through the automation ingest.';
COMMENT ON COLUMN cycles.external_id IS
  'Caller-supplied idempotency key, unique per project. Automation sends a stable CI identifier (e.g. the GitHub Actions run id) so a workflow re-run reuses its run instead of creating a duplicate.';
COMMENT ON COLUMN cycles.close_status IS
  'completed = the SDK closed the run itself; incomplete = it never did and the run was closed for it. NULL while open.';
COMMENT ON COLUMN cycles.last_result_at IS
  'Stamped on every result submission. With closed_at IS NULL this is what identifies a run whose process died before it could close itself.';

-- --------------------------------------------------------------------------------------------
-- executions: the per-result facts an automated report carries and a manual one does not
-- --------------------------------------------------------------------------------------------

ALTER TABLE executions
  ADD COLUMN duration_ms   INTEGER,
  ADD COLUMN retry_count   INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN error_message TEXT,
  ADD COLUMN error_stack   TEXT,
  ADD COLUMN reported_by   VARCHAR(16) NOT NULL DEFAULT 'human';

ALTER TABLE executions
  ADD CONSTRAINT executions_duration_ms_check CHECK (duration_ms IS NULL OR duration_ms >= 0),
  ADD CONSTRAINT executions_retry_count_check CHECK (retry_count >= 0),
  ADD CONSTRAINT executions_reported_by_check CHECK (reported_by IN ('human', 'automation'));

COMMENT ON COLUMN executions.retry_count IS
  'Attempts before the recorded one. The card asks for latest-attempt-wins with the retry count kept for visibility: a case that passes on attempt 3 reads Passed with retry_count = 2, which is what distinguishes it from a case that passed first time.';
COMMENT ON COLUMN executions.error_message IS
  'Automation failure reason. Distinct from actual_result, which is a human tester''s prose and stays theirs -- an SDK overwriting it would destroy notes a person typed.';
COMMENT ON COLUMN executions.reported_by IS
  'Which channel last wrote this result. Lets the run screen label automated rows without joining through cycles, and keeps a human''s later correction of an automated result visible as such.';

/*
 * NOTE: `executions_active` (V64) is `CREATE VIEW ... SELECT * FROM executions`, and Postgres
 * freezes a view's column list at creation time -- the five columns above are NOT visible
 * through it. That is fine today: its only caller is a status COUNT aggregate
 * (legacy.service.ts, projectDashboard). Any call site that needs the new columns must read
 * `executions` directly with `deleted_at IS NULL`, or the view has to be recreated.
 */

-- --------------------------------------------------------------------------------------------
-- attachments: what kind of evidence a file is
-- --------------------------------------------------------------------------------------------

/*
 * Evidence stays in the generic `attachments` table (entity_type = 'execution') rather than
 * getting its own: that table already carries project scope, the storage key, the byte size the
 * plan meter bills against, and an actor FK, and both existing evidence paths (bug and
 * execution) already use it.
 *
 * What it could not express is what a file IS. A screenshot renders inline, a trace is a
 * download for Playwright's trace viewer, a log opens as text -- and content_type cannot tell a
 * trace .zip from any other .zip. NULL means a human upload through the existing UI, which is
 * unclassified by design; the ingest always sets it.
 */
ALTER TABLE attachments
  ADD COLUMN evidence_kind VARCHAR(16);

ALTER TABLE attachments
  ADD CONSTRAINT attachments_evidence_kind_check CHECK (
    evidence_kind IS NULL OR evidence_kind IN ('screenshot', 'video', 'trace', 'log')
  );

-- The evidence viewer reads one execution's files and groups them by kind; without this it is a
-- full scan of every attachment in the workspace per result rendered.
CREATE INDEX idx_attachments_evidence
  ON attachments (entity_type, entity_id, evidence_kind)
  WHERE entity_type = 'execution';

-- --------------------------------------------------------------------------------------------
-- The machine actor
-- --------------------------------------------------------------------------------------------

/*
 * Same shape as the Zyra seed (V58) and the MCP seed (V65): inserting the agent fires the
 * agents_actor_sync trigger, which materialises the matching `actors` row with the same id, so
 * executions.executed_by and attachments.uploaded_by can point at it.
 *
 * Distinct from 'tesbo-mcp' on purpose. Both are API-token clients, but "a CI pipeline recorded
 * this result" and "an AI client recorded this result" are different provenance, and the run
 * screen and audit history should not have to guess which one wrote a row.
 */
INSERT INTO agents (slug, display_name, description)
VALUES (
  'tesbo-automation',
  'Tesbo Automation',
  'Machine actor for test results reported by a framework SDK through the automation ingest (Playwright, pytest, JUnit/TestNG)'
)
ON CONFLICT (slug) DO NOTHING;
