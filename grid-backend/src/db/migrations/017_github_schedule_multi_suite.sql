-- Multi-suite selection for scheduled runs.
--
-- A schedule can now reference many discovered spec files at once, or be
-- configured to run every test file in the repo via run_all_tests.

ALTER TABLE github_run_schedules
  ADD COLUMN IF NOT EXISTS discovered_suite_ids UUID[] NOT NULL DEFAULT ARRAY[]::UUID[],
  ADD COLUMN IF NOT EXISTS run_all_tests BOOLEAN NOT NULL DEFAULT FALSE;

-- Backfill the new array from the legacy single column where present.
UPDATE github_run_schedules
   SET discovered_suite_ids = ARRAY[discovered_suite_id]
 WHERE discovered_suite_id IS NOT NULL
   AND (discovered_suite_ids IS NULL OR cardinality(discovered_suite_ids) = 0);

ALTER TABLE github_run_schedules
  DROP COLUMN IF EXISTS discovered_suite_id;

CREATE INDEX IF NOT EXISTS idx_ghrs_suite_ids
  ON github_run_schedules USING GIN (discovered_suite_ids);
