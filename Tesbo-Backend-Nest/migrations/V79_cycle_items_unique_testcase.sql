-- One test case may appear only once in a given cycle.
-- Stage already has this from V78 (file never merged). Prod does not.
-- Idempotent so stage is a no-op and prod/fresh databases get the same key.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'cycle_items_cycle_id_testcase_id_key'
      AND conrelid = 'public.cycle_items'::regclass
  ) THEN
    ALTER TABLE cycle_items
      ADD CONSTRAINT cycle_items_cycle_id_testcase_id_key UNIQUE (cycle_id, testcase_id);
  END IF;
END $$;
