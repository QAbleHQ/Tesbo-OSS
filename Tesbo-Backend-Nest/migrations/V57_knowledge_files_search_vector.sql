-- knowledge_files has never had a full-text index (only knowledge_documents does, V45) —
-- so uploaded files were invisible to keyword/full-text search, only reachable once embedded.
-- Adds the same search_vector + GIN index + trigger pattern used for knowledge_documents.
ALTER TABLE knowledge_files ADD COLUMN search_vector TSVECTOR;

CREATE INDEX idx_knowledge_files_search ON knowledge_files USING GIN(search_vector);

CREATE OR REPLACE FUNCTION knowledge_files_search_vector_trigger() RETURNS trigger AS $$
BEGIN
  NEW.search_vector := setweight(to_tsvector('english', coalesce(NEW.original_file_name, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(NEW.extracted_text, '')), 'B');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER knowledge_files_search_vector_update
  BEFORE INSERT OR UPDATE ON knowledge_files
  FOR EACH ROW EXECUTE PROCEDURE knowledge_files_search_vector_trigger();

-- Backfill existing rows (trigger only fires on future inserts/updates).
UPDATE knowledge_files SET updated_at = updated_at;
