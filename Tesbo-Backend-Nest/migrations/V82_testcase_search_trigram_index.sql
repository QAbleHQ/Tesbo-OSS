-- Make the repository search index-assisted.
--
-- listTestCases matches with lower(col) LIKE '%term%'. The existing GIN index on search_vector
-- cannot serve that (it answers tsquery, not substrings), so every search fell back to a full
-- scan of the project's test cases. Switching the query to full-text would drop mid-word
-- matches that users rely on ("logi" finding "login"), so index the LIKE pattern itself with
-- trigrams instead and leave the query semantics alone.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS idx_testcases_title_trgm ON testcases USING GIN (lower(title) gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_testcases_external_id_trgm ON testcases USING GIN (lower(external_id) gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_testcases_description_trgm
  ON testcases USING GIN (lower(coalesce(description, '')) gin_trgm_ops);
