-- Bug priority (Basecamp 10226247009 — "bug priority field is missing when added bug from bug page").
--
-- `bugs` has only ever had `severity`. Severity is how bad the defect is; priority is how soon it is
-- worked on, and the two genuinely differ — a cosmetic bug on the signup page can be Low severity and
-- P0 priority. The reporter was looking for the second axis and found only the first.
--
-- P0..P3 rather than severity's Critical/High/Medium/Low: it is the vocabulary `testcases.priority`
-- already uses, and keeping the two scales distinct is what stops "Critical / Critical" rows where
-- nobody can tell which field they are reading.
--
-- Nullable with no default, deliberately: existing bugs get NULL rather than a made-up P2, so
-- "nobody has triaged this yet" stays distinguishable from "someone decided it is P2". The UI shows
-- an em dash for NULL.
--
-- Idempotent throughout — V78 taught this the hard way when a re-run against a database that already
-- had the change failed the whole deploy.

ALTER TABLE bugs ADD COLUMN IF NOT EXISTS priority varchar(8);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'bugs_priority_check' AND conrelid = 'bugs'::regclass
  ) THEN
    ALTER TABLE bugs
      ADD CONSTRAINT bugs_priority_check
      CHECK (priority IS NULL OR priority IN ('P0', 'P1', 'P2', 'P3'));
  END IF;
END
$$;

-- Partial, matching idx_bugs_severity's intent: the queries that filter on priority are always
-- looking for rows that have one.
CREATE INDEX IF NOT EXISTS idx_bugs_priority ON bugs (priority) WHERE priority IS NOT NULL;
