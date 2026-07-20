
ALTER TABLE testcases ADD COLUMN IF NOT EXISTS linear_issue_key VARCHAR(64);
ALTER TABLE testcases ADD COLUMN IF NOT EXISTS linear_url VARCHAR(512);
CREATE INDEX IF NOT EXISTS idx_testcases_linear_issue_key ON testcases (linear_issue_key) WHERE linear_issue_key IS NOT NULL;

ALTER TABLE ai_generation_requests ADD COLUMN IF NOT EXISTS linear_issue_keys JSONB DEFAULT '[]'::jsonb;
