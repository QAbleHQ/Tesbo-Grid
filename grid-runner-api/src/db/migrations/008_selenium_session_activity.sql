-- Track real session activity (not just `started_at`) so the cleanup sweep
-- can distinguish a long-running test from one whose client crashed without
-- sending DELETE /session/{id}.
--
-- Why: the previous sweep used
--   WHERE status = 'active' AND started_at < now() - sessionIdleTimeoutMs
-- which is "old sessions", not "idle sessions". A test that crashed 30s in
-- (very common when a CI job is killed) stayed `active` for the full
-- 10-minute timeout, padding the dashboard's live count and consuming a
-- concurrency slot. The new column is updated on every captured WebDriver
-- command, so a dead session is reaped within a single sweep interval.

ALTER TABLE selenium_sessions
    ADD COLUMN IF NOT EXISTS last_activity_at TIMESTAMPTZ;

-- Backfill so existing rows aren't immediately considered idle. For active
-- rows we use `started_at` (their last known liveness signal); for ended
-- rows we use `ended_at` so a recently-finished session isn't treated as
-- ancient when the schema lands.
UPDATE selenium_sessions
   SET last_activity_at = COALESCE(ended_at, started_at, queued_at, now())
 WHERE last_activity_at IS NULL;

-- Cleanup query lives on a hot path (every 30s by default) — index by
-- (status, last_activity_at) so the WHERE-clause planner can use an
-- index-only scan.
CREATE INDEX IF NOT EXISTS idx_selenium_sessions_status_activity
    ON selenium_sessions(status, last_activity_at DESC);

-- Dashboard browses completed sessions by day; index the natural ordering
-- so date-range scans on a busy project don't sequential-scan the whole
-- table.
CREATE INDEX IF NOT EXISTS idx_selenium_sessions_project_ended
    ON selenium_sessions(project_id, ended_at DESC NULLS LAST);
