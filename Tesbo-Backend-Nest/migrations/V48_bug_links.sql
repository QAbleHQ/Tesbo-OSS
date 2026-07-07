-- Many-to-many linking between a bug and the test cases/runs it affects, so a single
-- defect can be traced across every failing execution it caused (RTM/backtrace reporting).
-- The legacy bugs.execution_id/testcase_id/cycle_id columns stay as a first-link convenience
-- (populated at creation for back-compat); bug_links is now the source of truth for reads.

ALTER TABLE bugs
  ADD COLUMN integration_provider   VARCHAR(16),
  ADD COLUMN integration_issue_key  VARCHAR(64);

CREATE TABLE bug_links (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    bug_id       UUID NOT NULL REFERENCES bugs(id) ON DELETE CASCADE,
    testcase_id  UUID REFERENCES testcases(id) ON DELETE CASCADE,
    cycle_id     UUID REFERENCES cycles(id) ON DELETE SET NULL,
    execution_id UUID REFERENCES executions(id) ON DELETE SET NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (bug_id, testcase_id, cycle_id)
);

CREATE INDEX idx_bug_links_bug ON bug_links(bug_id);
CREATE INDEX idx_bug_links_testcase ON bug_links(testcase_id) WHERE testcase_id IS NOT NULL;
CREATE INDEX idx_bug_links_cycle ON bug_links(cycle_id) WHERE cycle_id IS NOT NULL;

INSERT INTO bug_links (bug_id, testcase_id, cycle_id, execution_id)
SELECT id, testcase_id, cycle_id, execution_id
FROM bugs
WHERE testcase_id IS NOT NULL;
