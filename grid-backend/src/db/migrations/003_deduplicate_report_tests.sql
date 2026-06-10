-- Remove duplicate report_tests rows (keep only the latest per spec+name per run)
-- then add a unique constraint to prevent future duplicates.

DELETE FROM report_tests a
USING report_tests b
WHERE a.report_run_id = b.report_run_id
  AND a.spec IS NOT DISTINCT FROM b.spec
  AND a.name IS NOT DISTINCT FROM b.name
  AND a.created_at < b.created_at;

-- Also handle exact same created_at by keeping the one with the larger id
DELETE FROM report_tests a
USING report_tests b
WHERE a.report_run_id = b.report_run_id
  AND a.spec IS NOT DISTINCT FROM b.spec
  AND a.name IS NOT DISTINCT FROM b.name
  AND a.created_at = b.created_at
  AND a.id < b.id;

CREATE UNIQUE INDEX IF NOT EXISTS idx_report_tests_unique_per_run
  ON report_tests (report_run_id, COALESCE(spec, ''), COALESCE(name, ''));
