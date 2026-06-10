-- Track whether the TESBO_GRID_API_KEY repo secret was auto-configured on the
-- customer's GitHub repo. Until now we inferred this from a substring match
-- against workflow_status_detail, which is overwritten on PR merge and resync
-- so the signal is lost. A dedicated boolean lets the UI keep showing the
-- "secret not configured" alert until the user (or a retry) actually fixes it.

ALTER TABLE github_run_schedules
  ADD COLUMN IF NOT EXISTS repo_secret_configured BOOLEAN NOT NULL DEFAULT FALSE;

-- Backfill: existing rows where the workflow setup ran cleanly have
-- workflow_status_detail = NULL (see openWorkflowPrForSchedule), so we mark
-- those as configured. Rows whose detail mentions "Repo secret" are the ones
-- that need manual setup and stay FALSE.
UPDATE github_run_schedules
   SET repo_secret_configured = TRUE
 WHERE workflow_file_path IS NOT NULL
   AND (workflow_status_detail IS NULL
        OR workflow_status_detail NOT LIKE '%Repo secret%');
