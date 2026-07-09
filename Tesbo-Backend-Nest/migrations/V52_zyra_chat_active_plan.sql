-- "All possible cases" chat generation is now broken into a planned todo list of scenarios,
-- processed in small batches so each AI call stays well under the provider's output token
-- limit (a single "generate 50" call was truncating and returning invalid JSON). The plan
-- is persisted here so a fire-and-forget background loop can pick up where the last batch
-- left off, and so a new user message can cancel it (see sendZyraChatMessage).

ALTER TABLE zyra_chat_sessions
  ADD COLUMN active_plan JSONB;
