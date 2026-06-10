-- dev_repo columns are now optional (user may not have access to the dev repo)
ALTER TABLE github_integrations
  ALTER COLUMN dev_repo_full_name DROP NOT NULL,
  ALTER COLUMN dev_repo_id        DROP NOT NULL;

-- Unified run history for every schedule trigger (manual or automated, PR or cron)
CREATE TABLE IF NOT EXISTS github_schedule_run_log (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  schedule_id      UUID        NOT NULL REFERENCES github_run_schedules(id) ON DELETE CASCADE,
  integration_id   UUID        NOT NULL REFERENCES github_integrations(id)  ON DELETE CASCADE,
  trigger_source   TEXT        NOT NULL CHECK (trigger_source IN ('manual', 'automated')),
  suite_mode       TEXT        NOT NULL CHECK (suite_mode IN ('fixed', 'dynamic')),
  pr_number        INT,
  head_sha         TEXT,
  execution_run_id UUID,
  status           TEXT        NOT NULL DEFAULT 'pending'
                               CHECK (status IN ('pending','running','recorded','completed','failed','cancelled','no_suites')),
  selected_tests   JSONB,
  error_message    TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_schedule_run_log_schedule
  ON github_schedule_run_log(schedule_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_schedule_run_log_integration
  ON github_schedule_run_log(integration_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_schedule_run_log_exec_run
  ON github_schedule_run_log(execution_run_id)
  WHERE execution_run_id IS NOT NULL;
