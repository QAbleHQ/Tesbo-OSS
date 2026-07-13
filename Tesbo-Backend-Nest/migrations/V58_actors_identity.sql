-- Actor identity model: lets every "who did this" column reference either a human user
-- or an AI agent (e.g. Zyra), without duplicating every FK column or merging `users` into
-- a generic identity table. `actors.id` reuses the SAME uuid value as `users.id`/`agents.id`,
-- so existing FK columns can later be repointed at actors(id) with zero data rewriting.

CREATE TABLE agents (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    slug          VARCHAR(64) NOT NULL UNIQUE,
    display_name  VARCHAR(255) NOT NULL,
    description   TEXT,
    avatar_url    VARCHAR(1024),
    is_active     BOOLEAN NOT NULL DEFAULT true,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE actors (
    id          UUID PRIMARY KEY,
    actor_type  VARCHAR(16) NOT NULL CHECK (actor_type IN ('user', 'agent')),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_actors_type ON actors(actor_type);

CREATE OR REPLACE FUNCTION sync_actor_from_user() RETURNS trigger AS $$
BEGIN
  INSERT INTO actors (id, actor_type, created_at) VALUES (NEW.id, 'user', NEW.created_at)
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER users_actor_sync
  AFTER INSERT ON users
  FOR EACH ROW EXECUTE PROCEDURE sync_actor_from_user();

CREATE OR REPLACE FUNCTION sync_actor_from_agent() RETURNS trigger AS $$
BEGIN
  INSERT INTO actors (id, actor_type, created_at) VALUES (NEW.id, 'agent', NEW.created_at)
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER agents_actor_sync
  AFTER INSERT ON agents
  FOR EACH ROW EXECUTE PROCEDURE sync_actor_from_agent();

-- Backfill every existing user into actors (same id, zero ambiguity).
INSERT INTO actors (id, actor_type, created_at)
SELECT id, 'user', created_at FROM users
ON CONFLICT (id) DO NOTHING;

-- Seed Zyra as a first-class, referenceable agent identity.
INSERT INTO agents (slug, display_name, description)
VALUES ('zyra', 'Zyra', 'Tesbo''s AI test-generation and execution agent')
ON CONFLICT (slug) DO NOTHING;

-- Guarantee every user has a matching actor row going forward too. Deferred so the
-- AFTER INSERT trigger above can populate `actors` before the constraint is checked.
ALTER TABLE users
  ADD CONSTRAINT users_id_actor_fkey FOREIGN KEY (id) REFERENCES actors(id) DEFERRABLE INITIALLY DEFERRED;

-- Single-join lookup for a display name regardless of whether the actor is a user or an agent.
CREATE VIEW actor_profiles AS
  SELECT a.id, a.actor_type, u.name AS display_name, u.email, u.avatar_url
  FROM actors a JOIN users u ON u.id = a.id WHERE a.actor_type = 'user'
  UNION ALL
  SELECT a.id, a.actor_type, g.display_name, NULL::varchar AS email, g.avatar_url
  FROM actors a JOIN agents g ON g.id = a.id WHERE a.actor_type = 'agent';
