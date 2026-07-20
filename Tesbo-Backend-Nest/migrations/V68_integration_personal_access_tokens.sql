-- Adds Personal Access Token auth as an alternative to OAuth for integration_connections.
-- The PAT value itself reuses the existing access_token column (refresh_token stays '' for
-- personal_token rows, same convention Linear OAuth connections already use) so every
-- downstream call site keeps reading connection.access_token regardless of auth_method.
--
-- Encryption of existing plaintext columns (access_token, refresh_token, client_secret) is
-- NOT done here -- src/database/migrate.ts only executes plain .sql files and has no access to
-- Node's crypto/env-sourced key, so re-encrypting existing rows is a separate one-off script
-- (src/database/backfill-encrypt-secrets.ts).

ALTER TABLE integration_connections
  ADD COLUMN auth_method VARCHAR(32) NOT NULL DEFAULT 'oauth',
  ADD COLUMN personal_token_identifier VARCHAR(320);

ALTER TABLE integration_connections
  ADD CONSTRAINT integration_connections_auth_method_check
    CHECK (auth_method IN ('oauth', 'personal_token')),
  ADD CONSTRAINT integration_connections_pat_identifier_scope_check
    CHECK (auth_method = 'personal_token' OR personal_token_identifier IS NULL);

COMMENT ON COLUMN integration_connections.access_token IS
  'Encrypted (AES-256-GCM, see src/common/crypto.util.ts). For auth_method=oauth this is the OAuth access token; for auth_method=personal_token this is the Jira API token or Linear personal API key.';
COMMENT ON COLUMN integration_connections.refresh_token IS
  'Encrypted. Empty string and unused for auth_method=personal_token connections (personal tokens do not expire/refresh).';
COMMENT ON COLUMN integration_connections.personal_token_identifier IS
  'Email paired with the Jira API token for HTTP Basic auth. Always NULL for Linear (personal keys are a single opaque value) and for all auth_method=oauth rows.';
COMMENT ON COLUMN integration_oauth_configs.client_secret IS
  'Encrypted (AES-256-GCM, see src/common/crypto.util.ts).';
