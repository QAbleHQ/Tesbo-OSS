-- Project-scoped custom fields for test cases.
--
-- The custom_field_definitions/custom_field_values tables created in
-- V2_test_cases_and_suites.sql were never wired up to any application code and are
-- missing everything this feature needs (display order, lifecycle status, required flag,
-- default values, per-type config). Rather than bolt all of that onto the unused V2 shape,
-- this migration drops and recreates the tables fresh. No data migration is needed because
-- nothing ever wrote to them.
DROP TABLE IF EXISTS custom_field_values;
DROP TABLE IF EXISTS custom_field_definitions;

-- `key` is a stable identifier generated once at creation (slug of the name + a short
-- random suffix). `name` is the editable display label — renaming a field only ever
-- touches `name`, never `key`, so anything that references a field by key (CSV/XLSX
-- import column mapping) survives a rename untouched.
--
-- `field_type` is immutable after creation (no UPDATE path changes it) — the only
-- categorical guarantee against data-loss on type change; a team that needs a different
-- type archives the old field and creates a new one.
--
-- All type-specific configuration (placeholder, max length, default value, min/max,
-- decimals-allowed, unit, allow past/future dates, options[], default option/selections,
-- min/max selection count, boolean display format) lives in one `config` JSONB column
-- rather than a wide column-per-option table, matching this codebase's existing JSONB-heavy
-- conventions (testcases.steps, projects.settings).
CREATE TABLE custom_field_definitions (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id      UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    key             VARCHAR(80) NOT NULL,
    name            VARCHAR(160) NOT NULL,
    description     TEXT,
    field_type      VARCHAR(16) NOT NULL CHECK (field_type IN
                        ('text', 'long_text', 'boolean', 'single_select', 'multi_select', 'number', 'date')),
    status          VARCHAR(16) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive', 'archived')),
    required        BOOLEAN NOT NULL DEFAULT false,
    display_order   INT NOT NULL DEFAULT 0,
    config          JSONB NOT NULL DEFAULT '{}',
    created_by      UUID REFERENCES actors(id) ON DELETE SET NULL,
    updated_by      UUID REFERENCES actors(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(project_id, key)
);

CREATE INDEX idx_custom_field_definitions_project ON custom_field_definitions(project_id);
CREATE INDEX idx_custom_field_definitions_project_status_order
  ON custom_field_definitions(project_id, status, display_order);

-- Case-insensitive name uniqueness among non-archived fields only: an archived field
-- keeps its historical name without permanently blocking a brand-new field from reusing it.
CREATE UNIQUE INDEX idx_custom_field_definitions_project_name_active
  ON custom_field_definitions(project_id, lower(name)) WHERE status <> 'archived';

-- One row per (definition, testcase). A single JSONB `value` column stores the
-- type-appropriate native JSON scalar/array (string, number, boolean, ISO date string
-- "YYYY-MM-DD", an option-id string, or an array of option-id strings) rather than four
-- typed value_text/value_number/value_date/value_json columns — every business rule
-- (option must be active, number in range, decimals allowed, etc.) has to be enforced in
-- the application layer regardless of column type, so a JSONB catch-all avoids
-- COALESCE-across-4-columns plumbing on every read/write for no loss of safety.
--
-- A row is only ever inserted when a real (non-empty) value is set; clearing a value back
-- to empty DELETEs the row rather than storing an empty/null value, so "is this field
-- empty" and "has this field ever been used" are both simple existence checks.
CREATE TABLE custom_field_values (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    definition_id   UUID NOT NULL REFERENCES custom_field_definitions(id) ON DELETE CASCADE,
    testcase_id     UUID NOT NULL REFERENCES testcases(id) ON DELETE CASCADE,
    value           JSONB NOT NULL,
    created_by      UUID REFERENCES actors(id) ON DELETE SET NULL,
    updated_by      UUID REFERENCES actors(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(definition_id, testcase_id)
);

CREATE INDEX idx_custom_field_values_testcase ON custom_field_values(testcase_id);

-- Speeds up multi/single-select "includes any" / "includes all" filters (jsonb ?| / ?&).
CREATE INDEX idx_custom_field_values_value_gin ON custom_field_values USING GIN (value);
