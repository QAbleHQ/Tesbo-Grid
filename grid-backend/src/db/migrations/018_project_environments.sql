-- Application Under Test (AUT) environments per project.
--
-- An environment is a named target — e.g. "Staging" -> https://staging.example.com,
-- "Prod" -> https://example.com. When a schedule fires, the GitHub Actions
-- workflow injects PLAYWRIGHT_BASE_URL (or the framework's equivalent) plus
-- any extra key/value pairs from the selected environment so the tests know
-- where to point.
--
-- Also stores a schedule_timezone on github_run_schedules so the calendar-
-- style schedule UI can round-trip the user's chosen timezone — the
-- cron_expression column itself stays in UTC.

CREATE TABLE IF NOT EXISTS project_environments (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    execute_project_id  UUID NOT NULL REFERENCES execute_projects(id) ON DELETE CASCADE,
    name                TEXT NOT NULL,
    base_url            TEXT,
    variables           JSONB NOT NULL DEFAULT '[]'::jsonb,
    is_default          BOOLEAN NOT NULL DEFAULT FALSE,
    created_by          UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (execute_project_id, name)
);

CREATE INDEX IF NOT EXISTS idx_project_environments_project
  ON project_environments(execute_project_id);

ALTER TABLE github_run_schedules
  ADD COLUMN IF NOT EXISTS environment_id UUID REFERENCES project_environments(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS schedule_timezone TEXT;

CREATE INDEX IF NOT EXISTS idx_github_run_schedules_environment
  ON github_run_schedules(environment_id);
