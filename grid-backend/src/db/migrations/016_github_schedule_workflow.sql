-- GitHub Actions workflow lifecycle for scheduled runs.
--
-- Tests still execute on Tesbo Grid's infrastructure. GitHub Actions is used
-- ONLY as the cron / dispatch trigger and as a free, native log viewer.
-- The workflow file lives in the customer's test repo and invokes the
-- @tesbox/cli, which calls /api/runs on our side.

ALTER TABLE github_run_schedules
  ADD COLUMN IF NOT EXISTS workflow_file_path TEXT,
  ADD COLUMN IF NOT EXISTS workflow_status TEXT NOT NULL DEFAULT 'pending_workflow_merge',
  ADD COLUMN IF NOT EXISTS workflow_status_detail TEXT,
  ADD COLUMN IF NOT EXISTS setup_pr_url TEXT,
  ADD COLUMN IF NOT EXISTS setup_pr_number INTEGER,
  ADD COLUMN IF NOT EXISTS setup_pr_merged_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS workflow_file_sha TEXT;

-- workflow_status values:
--   pending_workflow_merge — setup PR opened but not yet merged
--   active                 — workflow file is present and runnable
--   workflow_missing       — file was deleted from the repo
--   error                  — last attempt to use the workflow failed (see workflow_status_detail)
--   paused                 — user paused the schedule

CREATE INDEX IF NOT EXISTS idx_ghrs_workflow_file_path
  ON github_run_schedules (workflow_file_path);

ALTER TABLE github_schedule_run_log
  ADD COLUMN IF NOT EXISTS github_actions_run_id BIGINT,
  ADD COLUMN IF NOT EXISTS github_actions_run_url TEXT,
  ADD COLUMN IF NOT EXISTS github_actions_run_number INTEGER;

CREATE INDEX IF NOT EXISTS idx_ghsrl_ga_run_id
  ON github_schedule_run_log (github_actions_run_id);
