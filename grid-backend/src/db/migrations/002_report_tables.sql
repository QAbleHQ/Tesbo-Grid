-- Report storage for ingested test runs (standalone — no TesboX dependency).

CREATE TABLE IF NOT EXISTS report_runs (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id      UUID NOT NULL REFERENCES execute_projects(id) ON DELETE CASCADE,
    execution_run_id TEXT,
    run_name        VARCHAR(500),
    source_type     VARCHAR(64) NOT NULL DEFAULT 'TESBOX_EXECUTION',
    status          VARCHAR(32) NOT NULL DEFAULT 'IN_PROGRESS',
    total_tests     INTEGER NOT NULL DEFAULT 0,
    passed          INTEGER NOT NULL DEFAULT 0,
    failed          INTEGER NOT NULL DEFAULT 0,
    skipped         INTEGER NOT NULL DEFAULT 0,
    duration_ms     INTEGER,
    started_at      TIMESTAMPTZ,
    completed_at    TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS report_tests (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    report_run_id   UUID NOT NULL REFERENCES report_runs(id) ON DELETE CASCADE,
    spec            VARCHAR(1000),
    name            VARCHAR(1000),
    full_title      VARCHAR(2000),
    status          VARCHAR(32) NOT NULL DEFAULT 'Skipped',
    duration_ms     INTEGER,
    error_message   TEXT,
    error_stack     TEXT,
    attempt         INTEGER,
    project_name    VARCHAR(255),
    tags            JSONB DEFAULT '[]',
    trace_url       TEXT,
    screenshot_url  TEXT,
    video_url       TEXT,
    steps           JSONB DEFAULT '[]',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_report_runs_project ON report_runs(project_id);
CREATE INDEX IF NOT EXISTS idx_report_runs_project_created ON report_runs(project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_report_tests_run ON report_tests(report_run_id);
