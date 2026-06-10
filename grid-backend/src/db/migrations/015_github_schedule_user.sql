-- Add optional "run as user" assignment to github_run_schedules
ALTER TABLE github_run_schedules
  ADD COLUMN IF NOT EXISTS run_as_user_id UUID REFERENCES users(id) ON DELETE SET NULL;
