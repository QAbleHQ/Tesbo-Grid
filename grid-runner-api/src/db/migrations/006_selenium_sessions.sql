-- selenium_sessions tracks every WebDriver session that flows through the
-- authenticated Selenium Grid proxy (grid-selenium-proxy). Each row is keyed
-- by the upstream Selenium Hub session id and records who opened it
-- (project_id / api_key_id), the sanitised capabilities, and the lifecycle
-- bookends (started_at / ended_at).
CREATE TABLE IF NOT EXISTS selenium_sessions (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    selenium_id     TEXT NOT NULL UNIQUE,
    project_id      TEXT NOT NULL,
    api_key_id      UUID,
    started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    ended_at        TIMESTAMPTZ,
    status          TEXT NOT NULL DEFAULT 'active',
    capabilities    JSONB NOT NULL DEFAULT '{}'::jsonb,
    tesbo_options   JSONB NOT NULL DEFAULT '{}'::jsonb,
    duration_ms     INTEGER,
    end_reason      TEXT
);

CREATE INDEX IF NOT EXISTS idx_selenium_sessions_project
    ON selenium_sessions(project_id, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_selenium_sessions_status
    ON selenium_sessions(status, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_selenium_sessions_build
    ON selenium_sessions((tesbo_options->>'build'));
