-- Heal cycle items that never got their execution row.
--
-- addCycleTestCases used to insert the cycle_item and its execution as two separate
-- autocommitted statements. When a large linking request hit the edge proxy's timeout (524)
-- between the two, the item stayed behind with no execution. Such an item is counted by
-- listCycles' COUNT(ci.id) but excluded from executions(), which INNER JOINs executions --
-- so a run reported more test cases than its own table could show.
--
-- The code now creates both in one statement, so no new orphans appear. This backfills the
-- ones already in the database. Idempotent: the NOT EXISTS makes a re-run a no-op.
INSERT INTO executions (cycle_item_id)
SELECT ci.id
FROM cycle_items ci
WHERE NOT EXISTS (
  SELECT 1 FROM executions e WHERE e.cycle_item_id = ci.id
);
