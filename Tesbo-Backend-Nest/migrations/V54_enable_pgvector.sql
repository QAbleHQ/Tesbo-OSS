-- Enables semantic (embedding) search over the project Knowledge Base for Zyra.
-- Requires the postgres image to be pgvector-enabled (see docker-compose.yml); in any
-- externally-hosted/managed Postgres this must be enabled by whoever administers that instance.
CREATE EXTENSION IF NOT EXISTS vector;
