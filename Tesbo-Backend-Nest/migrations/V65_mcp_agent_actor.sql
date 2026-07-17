-- Tesbo MCP: seed a dedicated agent identity so writes driven through the MCP server
-- (machine/API-token clients) are attributed to their own actor and stay distinguishable
-- from human users and from Zyra in audit history and on actor-referencing columns
-- (testcases.created_by/updated_by, executions.executed_by).
--
-- Mirrors the Zyra seed in V58: inserting the agent fires the agents_actor_sync trigger,
-- which materialises the matching row in `actors` with the same id.

INSERT INTO agents (slug, display_name, description)
VALUES ('tesbo-mcp', 'Tesbo MCP', 'Machine actor for writes made through the Tesbo MCP server (API-token clients)')
ON CONFLICT (slug) DO NOTHING;
