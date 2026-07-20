
ALTER TABLE bugs ADD COLUMN IF NOT EXISTS severity VARCHAR(16) NOT NULL DEFAULT 'Medium';
ALTER TABLE bugs ADD CONSTRAINT bugs_severity_check CHECK (severity IN ('Critical', 'High', 'Medium', 'Low'));
CREATE INDEX IF NOT EXISTS idx_bugs_severity ON bugs (severity);
