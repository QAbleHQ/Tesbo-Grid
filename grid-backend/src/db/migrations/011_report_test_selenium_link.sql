-- Link a `report_tests` row to the WebDriver session that produced it.
--
-- Before this migration there was no way to navigate from a failed test in
-- the dashboard to the live VNC stream or to the post-mortem session
-- recording — even though both already existed (the runner-api stores
-- `selenium_sessions`, and selenium-node uploads an mp4 per sessionId).
--
-- We can't use a real foreign key because `selenium_sessions` lives in the
-- runner-api Postgres, not the grid-backend Postgres. So we persist the id
-- as text and resolve it on demand through the existing internal HTTP API.
--
-- Population strategy is layered:
--   1. Explicit  — when the test framework set `tesbo:options.name =
--      "<class>.<method>"` on the WebDriver capabilities, the grid-selenium-proxy
--      stored that on `selenium_sessions.tesbo_options.name`. The reports ingest
--      pass joins by (project_id, build, name) and writes both columns below.
--   2. Heuristic — for tests with no explicit tag, we fall back to picking the
--      session whose `started_at` falls inside the test's [start, end] window
--      and shares the same build. This works for sequential tests; parallel
--      runs without explicit tagging will land on whichever session started
--      first inside the window (better than nothing, but tag explicitly when
--      possible).
--
-- The `selenium_session_status` column caches the status at correlation time
-- so the dashboard can render "Live VNC" vs "Session recording" without an
-- extra round-trip per test row. We also re-hydrate it on read for accuracy.

ALTER TABLE report_tests
    ADD COLUMN IF NOT EXISTS selenium_session_id          TEXT,
    ADD COLUMN IF NOT EXISTS selenium_session_request_id  UUID,
    ADD COLUMN IF NOT EXISTS selenium_session_status      TEXT,
    ADD COLUMN IF NOT EXISTS selenium_session_video_url   TEXT,
    ADD COLUMN IF NOT EXISTS selenium_session_linked_at   TIMESTAMPTZ;

-- Most reads happen through `report_run_id`, so the existing per-run index is
-- enough for fetches. We add a per-session index to support the reverse
-- lookup ("which test row is using this Selenium session?") used by the
-- live-session viewer's "owning test" callout.
CREATE INDEX IF NOT EXISTS idx_report_tests_selenium_session_id
    ON report_tests (selenium_session_id)
    WHERE selenium_session_id IS NOT NULL;
