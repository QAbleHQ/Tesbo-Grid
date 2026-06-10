-- Live session viewer support.
--
-- 1) Allow rows to exist BEFORE the upstream Selenium Hub assigns a session id.
--    The proxy used to insert a row only after `await fetch(... /wd/hub/session)`
--    returned, which meant queued sessions (waiting for a node slot) were
--    invisible in the dashboard. We now insert immediately as `queued` keyed
--    by `request_id`, then upgrade with the real `selenium_id` once the hub
--    accepts the session.
--
-- 2) Track the upstream node URI for live VNC routing — the selenium-proxy
--    looks up this column to find which node:7900 to tunnel a noVNC WebSocket
--    to.
--
-- 3) Persist a tail of WebDriver commands per session so the dashboard can
--    show what the test is doing right now alongside the live VNC view. We
--    store summaries (truncated request/response payloads) to keep storage
--    bounded; older rows beyond MAX_LIVE_COMMANDS_PER_SESSION are trimmed
--    by the proxy on insert.

ALTER TABLE selenium_sessions
    ALTER COLUMN selenium_id DROP NOT NULL;

ALTER TABLE selenium_sessions
    ADD COLUMN IF NOT EXISTS request_id   UUID UNIQUE,
    ADD COLUMN IF NOT EXISTS node_uri     TEXT,
    ADD COLUMN IF NOT EXISTS queued_at    TIMESTAMPTZ;

-- Backfill request_id for any pre-existing rows so the column is populated
-- even before the proxy ever runs the new code path.
UPDATE selenium_sessions
   SET request_id = gen_random_uuid()
 WHERE request_id IS NULL;

-- The original unique index on selenium_id was implicit via NOT NULL UNIQUE.
-- After dropping NOT NULL we re-add it as a partial unique index so multiple
-- queued rows (selenium_id IS NULL) can coexist while a finalised session id
-- remains unique.
ALTER TABLE selenium_sessions
    DROP CONSTRAINT IF EXISTS selenium_sessions_selenium_id_key;

CREATE UNIQUE INDEX IF NOT EXISTS uq_selenium_sessions_selenium_id
    ON selenium_sessions(selenium_id)
    WHERE selenium_id IS NOT NULL;

-- Each WebDriver command captured by the proxy. Bounded per-session by the
-- proxy: it deletes everything older than the most recent N commands on each
-- insert. We don't bother with TTL deletes here because abandoned sessions
-- are rare and selenium_sessions itself is the source of truth for retention.
CREATE TABLE IF NOT EXISTS selenium_session_commands (
    id              BIGSERIAL PRIMARY KEY,
    selenium_id     TEXT NOT NULL,
    sequence        INTEGER NOT NULL,
    occurred_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    method          TEXT NOT NULL,
    path            TEXT NOT NULL,
    -- The WebDriver "command name" (e.g. "findElement", "click", "navigateTo")
    -- derived from the URL — handy for the dashboard so it doesn't have to
    -- know the W3C URL grammar.
    command         TEXT,
    status          INTEGER,
    duration_ms     INTEGER,
    request_body    TEXT,
    response_body   TEXT,
    error           TEXT
);

CREATE INDEX IF NOT EXISTS idx_selenium_session_commands_session
    ON selenium_session_commands(selenium_id, sequence DESC);

CREATE INDEX IF NOT EXISTS idx_selenium_session_commands_occurred
    ON selenium_session_commands(selenium_id, occurred_at DESC);
