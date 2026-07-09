-- Tracks which testcases the most recent Zyra-generated batch created, independent of
-- active_plan (which gets cleared once the plan pauses/stops/completes) and independent of
-- the 12-message chat-history window used to build Zyra's prompt. Lets a later "move all
-- the cases we just generated" request resolve the exact set instead of relying on the
-- model to re-enumerate external IDs it may no longer have in context.

ALTER TABLE zyra_chat_sessions
  ADD COLUMN last_completed_plan JSONB;
