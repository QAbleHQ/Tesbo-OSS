-- One row per (cycle, test case) in a run.
--
-- addCycleTestCases has always written `ON CONFLICT DO NOTHING` when inserting cycle_items, but the
-- table never had a constraint for that clause to fire on: V3 gave it a primary key over a random
-- uuid and a plain index on cycle_id, nothing more. So the guard was decorative, and re-adding a
-- case that a run already contained inserted a second row instead of being a no-op.
--
-- That turned the import timeout into duplicated data. The add is not atomic per request, so when
-- the proxy gave up on a large selection the rows already written stayed written; the natural next
-- move is to hit "add" again, and the retry duplicated every case that had landed the first time.
-- The run then shows the same test case twice, each with its own execution and its own status.
--
-- Adding the constraint makes the retry idempotent, which is what the calling code has assumed all
-- along.

-- Existing duplicates have to go before the constraint can be created.
--
-- Which row survives matters: a duplicate pair is usually one row somebody has already executed and
-- one left untouched by the retry, and dropping the executed one would discard a real result (the
-- execution rows cascade from cycle_items). So rank progressed executions first — anything with a
-- status off the default, a recorded time, a written result, or a linked defect — and only fall back
-- to insertion order when neither row carries any of that.
WITH ranked AS (
    SELECT ci.id,
           row_number() OVER (
               PARTITION BY ci.cycle_id, ci.testcase_id
               ORDER BY
                   (
                       e.id IS NOT NULL AND (
                           e.status <> 'Untested'
                           OR e.executed_at IS NOT NULL
                           OR e.actual_result IS NOT NULL
                           OR e.defect_key IS NOT NULL
                       )
                   ) DESC,
                   ci.position,
                   ci.created_at,
                   ci.id
           ) AS rn
      FROM cycle_items ci
      LEFT JOIN executions e
        ON e.cycle_item_id = ci.id
       AND e.deleted_at IS NULL
)
DELETE FROM cycle_items
 WHERE id IN (SELECT id FROM ranked WHERE rn > 1);

ALTER TABLE cycle_items
    ADD CONSTRAINT cycle_items_cycle_id_testcase_id_key UNIQUE (cycle_id, testcase_id);
