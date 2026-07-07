
-- Generic, organization-scoped OAuth connection + config for app integrations (Jira, Linear, ...).
-- Replaces the per-project jira_connections/jira_oauth_config tables: a workspace connects an
-- app once, and existing per-project tables (jira_project_mappings/jira_tickets) now point at the
-- shared connection instead of a project-specific one.
CREATE TABLE integration_connections (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id  UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    provider         VARCHAR(32) NOT NULL,
    external_id      VARCHAR(256),
    site_url         VARCHAR(1024) NOT NULL,
    access_token     TEXT NOT NULL,
    refresh_token    TEXT NOT NULL DEFAULT '',
    token_expires_at TIMESTAMPTZ NOT NULL,
    connected_by     UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (organization_id, provider)
);

CREATE TABLE integration_oauth_configs (
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    provider        VARCHAR(32) NOT NULL,
    client_id       TEXT NOT NULL,
    client_secret   TEXT NOT NULL,
    redirect_uri    TEXT NOT NULL,
    updated_by      UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (organization_id, provider)
);

-- Linear ticket-tracker tables, mirroring the shape of jira_project_mappings/jira_tickets
-- (Linear's unit of work is a "team" rather than a "project").
CREATE TABLE linear_project_mappings (
    id                         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    integration_connection_id UUID NOT NULL REFERENCES integration_connections(id) ON DELETE CASCADE,
    project_id                 UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    linear_team_id             VARCHAR(128) NOT NULL,
    linear_team_key            VARCHAR(64) NOT NULL,
    linear_team_name           VARCHAR(512) NOT NULL,
    enabled                    BOOLEAN NOT NULL DEFAULT true,
    created_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (integration_connection_id, linear_team_id, project_id)
);

CREATE INDEX idx_linear_project_mappings_project ON linear_project_mappings(project_id);

CREATE TABLE linear_tickets (
    id                         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id                 UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    integration_connection_id UUID NOT NULL REFERENCES integration_connections(id) ON DELETE CASCADE,
    linear_issue_id            VARCHAR(128) NOT NULL,
    linear_issue_key           VARCHAR(64) NOT NULL,
    summary                    VARCHAR(1024) NOT NULL,
    description                TEXT,
    issue_type                 VARCHAR(128),
    status                     VARCHAR(128),
    priority                   VARCHAR(64),
    assignee                   VARCHAR(256),
    reporter                   VARCHAR(256),
    labels                     TEXT,
    linear_created_at          TIMESTAMPTZ,
    linear_updated_at          TIMESTAMPTZ,
    linear_url                 VARCHAR(1024),
    synced_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (integration_connection_id, linear_issue_id)
);

CREATE INDEX idx_linear_tickets_project ON linear_tickets(project_id);
CREATE INDEX idx_linear_tickets_connection ON linear_tickets(integration_connection_id);
CREATE INDEX idx_linear_tickets_key ON linear_tickets(linear_issue_key);

-- Migrate existing Jira connections/config up to organization scope. An organization that had
-- multiple projects each with their own Jira connection collapses onto a single connection
-- (the most recently updated one survives) — this is expected: Jira now connects once per workspace.
INSERT INTO integration_connections (organization_id, provider, external_id, site_url, access_token, refresh_token, token_expires_at, connected_by, created_at, updated_at)
SELECT DISTINCT ON (p.organization_id)
    p.organization_id, 'jira', jc.cloud_id, jc.site_url, jc.access_token, jc.refresh_token, jc.token_expires_at, jc.connected_by, jc.created_at, jc.updated_at
FROM jira_connections jc
JOIN projects p ON p.id = jc.project_id
ORDER BY p.organization_id, jc.updated_at DESC;

INSERT INTO integration_oauth_configs (organization_id, provider, client_id, client_secret, redirect_uri, updated_by, created_at, updated_at)
SELECT DISTINCT ON (p.organization_id)
    p.organization_id, 'jira', joc.client_id, joc.client_secret, joc.redirect_uri, joc.updated_by, joc.created_at, joc.updated_at
FROM jira_oauth_config joc
JOIN projects p ON p.id = joc.project_id
ORDER BY p.organization_id, joc.updated_at DESC;

-- Re-point jira_project_mappings/jira_tickets at the surviving organization-level connection.
CREATE TEMP TABLE _jira_connection_map AS
SELECT jc.id AS old_id, ic.id AS new_id
FROM jira_connections jc
JOIN projects p ON p.id = jc.project_id
JOIN integration_connections ic ON ic.organization_id = p.organization_id AND ic.provider = 'jira';

-- Drop the old per-connection FK/unique constraints *before* repointing jira_connection_id below:
-- collapsing several projects' connections onto one shared connection can otherwise violate the
-- old (jira_connection_id, jira_project_id) / (jira_connection_id, jira_issue_id) uniqueness.
DO $$
DECLARE conname text;
BEGIN
  SELECT tc.constraint_name INTO conname
  FROM information_schema.table_constraints tc
  JOIN information_schema.key_column_usage kcu ON kcu.constraint_name = tc.constraint_name AND kcu.table_name = tc.table_name
  WHERE tc.table_name = 'jira_project_mappings' AND tc.constraint_type = 'FOREIGN KEY' AND kcu.column_name = 'jira_connection_id';
  EXECUTE format('ALTER TABLE jira_project_mappings DROP CONSTRAINT %I', conname);

  SELECT tc.constraint_name INTO conname
  FROM information_schema.table_constraints tc
  JOIN information_schema.key_column_usage kcu ON kcu.constraint_name = tc.constraint_name AND kcu.table_name = tc.table_name
  WHERE tc.table_name = 'jira_project_mappings' AND tc.constraint_type = 'UNIQUE' AND kcu.column_name = 'jira_connection_id';
  EXECUTE format('ALTER TABLE jira_project_mappings DROP CONSTRAINT %I', conname);

  SELECT tc.constraint_name INTO conname
  FROM information_schema.table_constraints tc
  JOIN information_schema.key_column_usage kcu ON kcu.constraint_name = tc.constraint_name AND kcu.table_name = tc.table_name
  WHERE tc.table_name = 'jira_tickets' AND tc.constraint_type = 'FOREIGN KEY' AND kcu.column_name = 'jira_connection_id';
  EXECUTE format('ALTER TABLE jira_tickets DROP CONSTRAINT %I', conname);

  SELECT tc.constraint_name INTO conname
  FROM information_schema.table_constraints tc
  JOIN information_schema.key_column_usage kcu ON kcu.constraint_name = tc.constraint_name AND kcu.table_name = tc.table_name
  WHERE tc.table_name = 'jira_tickets' AND tc.constraint_type = 'UNIQUE' AND kcu.column_name = 'jira_connection_id';
  EXECUTE format('ALTER TABLE jira_tickets DROP CONSTRAINT %I', conname);
END $$;

UPDATE jira_project_mappings jpm
SET jira_connection_id = m.new_id
FROM _jira_connection_map m
WHERE jpm.jira_connection_id = m.old_id;

UPDATE jira_tickets jt
SET jira_connection_id = m.new_id
FROM _jira_connection_map m
WHERE jt.jira_connection_id = m.old_id;

-- Re-point the FK constraints at integration_connections, and widen the uniqueness to include
-- project_id since a shared connection can now feed several Tesbo projects from the same remote
-- Jira project/issue.
ALTER TABLE jira_project_mappings
  ADD CONSTRAINT jira_project_mappings_connection_fkey FOREIGN KEY (jira_connection_id) REFERENCES integration_connections(id) ON DELETE CASCADE,
  ADD CONSTRAINT jira_project_mappings_connection_project_key UNIQUE (jira_connection_id, jira_project_id, project_id);

ALTER TABLE jira_tickets
  ADD CONSTRAINT jira_tickets_connection_fkey FOREIGN KEY (jira_connection_id) REFERENCES integration_connections(id) ON DELETE CASCADE,
  ADD CONSTRAINT jira_tickets_connection_issue_project_key UNIQUE (jira_connection_id, jira_issue_id, project_id);

DROP TABLE _jira_connection_map;
DROP TABLE jira_oauth_config;
DROP TABLE jira_connections;
