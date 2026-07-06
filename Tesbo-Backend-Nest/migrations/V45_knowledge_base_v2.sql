-- Project Knowledge Base V1: hierarchical folders -> documents / files, replacing the
-- flat knowledge_base_items table (left in place, unused, for rollback safety).

CREATE TABLE knowledge_folders (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id   UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    project_id        UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    parent_folder_id  UUID REFERENCES knowledge_folders(id) ON DELETE CASCADE,
    name              VARCHAR(255) NOT NULL,
    description       TEXT,
    is_root           BOOLEAN NOT NULL DEFAULT false,
    created_by        UUID REFERENCES users(id) ON DELETE SET NULL,
    updated_by        UUID REFERENCES users(id) ON DELETE SET NULL,
    is_deleted        BOOLEAN NOT NULL DEFAULT false,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at        TIMESTAMPTZ
);

CREATE INDEX idx_knowledge_folders_project ON knowledge_folders(project_id);
CREATE INDEX idx_knowledge_folders_parent  ON knowledge_folders(parent_folder_id);
-- Exactly one non-deleted root folder per project.
CREATE UNIQUE INDEX idx_knowledge_folders_one_root ON knowledge_folders(project_id) WHERE is_root = true AND is_deleted = false;
-- Folder names unique among (non-deleted) siblings. The root folder has no parent and is unique per project already.
CREATE UNIQUE INDEX idx_knowledge_folders_unique_name ON knowledge_folders(project_id, parent_folder_id, name)
  WHERE is_deleted = false AND parent_folder_id IS NOT NULL;

CREATE TABLE knowledge_documents (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id     UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    project_id          UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    folder_id           UUID NOT NULL REFERENCES knowledge_folders(id) ON DELETE CASCADE,
    title               VARCHAR(512) NOT NULL,
    content_json        JSONB,
    content_html        TEXT,
    content_text        TEXT,
    document_type       VARCHAR(32) NOT NULL DEFAULT 'general'
                          CHECK (document_type IN ('general', 'requirement_note', 'test_data_note', 'api_note', 'release_note', 'ai_memory')),
    status              VARCHAR(16) NOT NULL DEFAULT 'draft',
    is_ai_generated     BOOLEAN NOT NULL DEFAULT false,
    -- Populated when this document mirrors an external item (Jira today; Linear/etc. later).
    source_provider     VARCHAR(32),
    source_external_id  VARCHAR(255),
    source_url          TEXT,
    created_by          UUID REFERENCES users(id) ON DELETE SET NULL,
    updated_by          UUID REFERENCES users(id) ON DELETE SET NULL,
    reviewed_by         UUID REFERENCES users(id) ON DELETE SET NULL,
    reviewed_at         TIMESTAMPTZ,
    is_deleted          BOOLEAN NOT NULL DEFAULT false,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at          TIMESTAMPTZ,
    search_vector       TSVECTOR
);

CREATE INDEX idx_knowledge_documents_project ON knowledge_documents(project_id);
CREATE INDEX idx_knowledge_documents_folder  ON knowledge_documents(folder_id);
CREATE INDEX idx_knowledge_documents_search  ON knowledge_documents USING GIN(search_vector);
CREATE UNIQUE INDEX idx_knowledge_documents_source ON knowledge_documents(source_provider, source_external_id)
  WHERE source_provider IS NOT NULL;

CREATE OR REPLACE FUNCTION knowledge_documents_search_vector_trigger() RETURNS trigger AS $$
BEGIN
  NEW.search_vector := setweight(to_tsvector('english', coalesce(NEW.title, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(NEW.content_text, '')), 'B');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER knowledge_documents_search_vector_update
  BEFORE INSERT OR UPDATE ON knowledge_documents
  FOR EACH ROW EXECUTE PROCEDURE knowledge_documents_search_vector_trigger();

CREATE TABLE knowledge_files (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id     UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    project_id          UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    folder_id           UUID NOT NULL REFERENCES knowledge_folders(id) ON DELETE CASCADE,
    file_name           VARCHAR(512) NOT NULL,
    original_file_name  VARCHAR(512) NOT NULL,
    mime_type           VARCHAR(256),
    file_extension      VARCHAR(16),
    file_size           BIGINT,
    storage_key         TEXT,
    uploaded_by         UUID REFERENCES users(id) ON DELETE SET NULL,
    is_deleted          BOOLEAN NOT NULL DEFAULT false,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at          TIMESTAMPTZ
);

CREATE INDEX idx_knowledge_files_project ON knowledge_files(project_id);
CREATE INDEX idx_knowledge_files_folder  ON knowledge_files(folder_id);

CREATE TABLE knowledge_document_versions (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    document_id     UUID NOT NULL REFERENCES knowledge_documents(id) ON DELETE CASCADE,
    version_number  INT NOT NULL,
    title           VARCHAR(512) NOT NULL,
    content_json    JSONB,
    content_html    TEXT,
    content_text    TEXT,
    created_by      UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_knowledge_document_versions_document ON knowledge_document_versions(document_id);

-- Seed the root "Knowledge base" folder + the 6 default sub-folders for every existing project.
-- (New projects get these from application code at creation time; this is a one-time backfill.)
DO $$
DECLARE
  proj RECORD;
  root_id UUID;
  default_names TEXT[] := ARRAY['Requirements', 'Test Data', 'Screenshots & Evidence', 'API Notes', 'Release Notes', 'AI Memory'];
  default_descriptions TEXT[] := ARRAY[
    'Product requirements, user stories, acceptance notes, and business rules.',
    'Sample users, input data, CSVs, data conditions, and boundary values.',
    'Screenshots, recordings, execution proof, and UI references.',
    'Endpoints, payloads, Postman exports, and API behavior notes.',
    'Build notes, release changes, and release risk notes.',
    'AI-generated project understanding and memory files.'
  ];
  i INT;
BEGIN
  FOR proj IN SELECT id, organization_id FROM projects LOOP
    SELECT id INTO root_id FROM knowledge_folders WHERE project_id = proj.id AND is_root = true LIMIT 1;
    IF root_id IS NULL THEN
      INSERT INTO knowledge_folders (organization_id, project_id, parent_folder_id, name, is_root)
      VALUES (proj.organization_id, proj.id, NULL, 'Knowledge base', true)
      RETURNING id INTO root_id;

      FOR i IN 1 .. array_length(default_names, 1) LOOP
        INSERT INTO knowledge_folders (organization_id, project_id, parent_folder_id, name, description)
        VALUES (proj.organization_id, proj.id, root_id, default_names[i], default_descriptions[i]);
      END LOOP;
    END IF;
  END LOOP;
END $$;

-- Migrate existing flat knowledge_base_items into the new schema, placed directly in each
-- project's root folder (their original context/grouping is unknown).
INSERT INTO knowledge_documents (organization_id, project_id, folder_id, title, content_text, content_html, document_type, status, created_by, created_at, updated_at)
SELECT p.organization_id, kbi.project_id, kf.id, kbi.title, kbi.content,
       CASE WHEN kbi.content IS NOT NULL
         THEN '<pre>' || replace(replace(replace(kbi.content, '&', '&amp;'), '<', '&lt;'), '>', '&gt;') || '</pre>'
         ELSE NULL
       END,
       'general', 'published', kbi.created_by, kbi.created_at, kbi.updated_at
FROM knowledge_base_items kbi
JOIN projects p ON p.id = kbi.project_id
JOIN knowledge_folders kf ON kf.project_id = kbi.project_id AND kf.is_root = true
WHERE kbi.item_type = 'note';

INSERT INTO knowledge_files (organization_id, project_id, folder_id, file_name, original_file_name, mime_type, file_extension, file_size, storage_key, uploaded_by, created_at, updated_at)
SELECT p.organization_id, kbi.project_id, kf.id,
       coalesce(kbi.file_name, kbi.title), coalesce(kbi.file_name, kbi.title), kbi.file_content_type,
       CASE WHEN kbi.file_name ~ '\.' THEN lower(regexp_replace(kbi.file_name, '^.*\.', '')) ELSE NULL END,
       kbi.file_size, kbi.storage_path, kbi.created_by, kbi.created_at, kbi.updated_at
FROM knowledge_base_items kbi
JOIN projects p ON p.id = kbi.project_id
JOIN knowledge_folders kf ON kf.project_id = kbi.project_id AND kf.is_root = true
WHERE kbi.item_type = 'file';
