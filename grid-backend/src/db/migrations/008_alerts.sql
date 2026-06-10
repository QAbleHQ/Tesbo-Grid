-- Project alert rules and triggered alert history
-- Supports per-project monitoring on metrics like pass ratio, failure rate, and flaky tests.

CREATE TABLE IF NOT EXISTS project_alerts (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    execute_project_id  UUID NOT NULL REFERENCES execute_projects(id) ON DELETE CASCADE,
    name                VARCHAR(200) NOT NULL,
    metric              VARCHAR(32)  NOT NULL,    -- 'pass_ratio' | 'failure_rate' | 'flaky_tests'
    operator            VARCHAR(8)   NOT NULL,    -- 'below' | 'above'
    threshold           NUMERIC      NOT NULL,
    unit                VARCHAR(8)   NOT NULL,    -- '%' | 'tests'
    channel             VARCHAR(16)  NOT NULL DEFAULT 'email',
    recipients          JSONB        NOT NULL DEFAULT '[]'::jsonb,
    enabled             BOOLEAN      NOT NULL DEFAULT TRUE,
    created_by          UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_project_alerts_project
    ON project_alerts(execute_project_id);

CREATE TABLE IF NOT EXISTS project_alert_events (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    execute_project_id  UUID NOT NULL REFERENCES execute_projects(id) ON DELETE CASCADE,
    alert_id            UUID REFERENCES project_alerts(id) ON DELETE SET NULL,
    rule_title          VARCHAR(200) NOT NULL,
    summary             TEXT NOT NULL,
    severity            VARCHAR(16) NOT NULL DEFAULT 'Medium',
    run_id              UUID,
    run_name            VARCHAR(255),
    metric              VARCHAR(32) NOT NULL,
    observed_value      NUMERIC,
    threshold           NUMERIC,
    triggered_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_project_alert_events_project
    ON project_alert_events(execute_project_id);

CREATE INDEX IF NOT EXISTS idx_project_alert_events_triggered
    ON project_alert_events(triggered_at DESC);
