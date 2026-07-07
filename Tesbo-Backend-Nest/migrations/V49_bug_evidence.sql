-- Lets a bug point at an existing BetterBugs session as an alternative to attaching files
-- directly (file evidence itself reuses the existing generic `attachments` table via
-- entity_type = 'bug', no new table needed there).
ALTER TABLE bugs ADD COLUMN betterbugs_url VARCHAR(1024);
