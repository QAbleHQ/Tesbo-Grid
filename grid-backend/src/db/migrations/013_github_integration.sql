CREATE TABLE IF NOT EXISTS github_integrations (
    id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    execute_project_id    UUID NOT NULL UNIQUE REFERENCES execute_projects(id) ON DELETE CASCADE,
    installation_id       BIGINT NOT NULL,
    github_account_login  TEXT NOT NULL,
    dev_repo_full_name    TEXT NOT NULL,
    dev_repo_id           BIGINT NOT NULL,
    test_repo_full_name   TEXT NOT NULL,
    test_repo_id          BIGINT NOT NULL,
    webhook_secret        TEXT NOT NULL,
    created_by            UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_github_integrations_dev_repo  ON github_integrations(dev_repo_id);
CREATE INDEX IF NOT EXISTS idx_github_integrations_test_repo ON github_integrations(test_repo_id);
CREATE INDEX IF NOT EXISTS idx_github_integrations_install   ON github_integrations(installation_id);

CREATE TABLE IF NOT EXISTS github_run_schedules (
    id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    integration_id       UUID NOT NULL REFERENCES github_integrations(id) ON DELETE CASCADE,
    name                 TEXT NOT NULL,
    trigger_type         TEXT NOT NULL CHECK (trigger_type IN ('cron', 'pr')),
    cron_expression      TEXT,
    test_repo_ref        TEXT NOT NULL DEFAULT 'main',
    suite_mode           TEXT NOT NULL CHECK (suite_mode IN ('fixed', 'dynamic')),
    discovered_suite_id  UUID,
    enabled              BOOLEAN NOT NULL DEFAULT TRUE,
    last_fired_at        TIMESTAMPTZ,
    next_fire_at         TIMESTAMPTZ,
    created_by           UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_github_run_schedules_integration ON github_run_schedules(integration_id);
CREATE INDEX IF NOT EXISTS idx_github_run_schedules_next_fire   ON github_run_schedules(next_fire_at) WHERE trigger_type = 'cron' AND enabled = TRUE;

CREATE TABLE IF NOT EXISTS github_repo_suites (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    integration_id  UUID NOT NULL REFERENCES github_integrations(id) ON DELETE CASCADE,
    repo_ref        TEXT NOT NULL,
    head_sha        TEXT NOT NULL,
    suite_key       TEXT NOT NULL,
    suite_label     TEXT NOT NULL,
    suite_kind      TEXT NOT NULL,
    metadata        JSONB DEFAULT '{}',
    discovered_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (integration_id, repo_ref, suite_key)
);

CREATE INDEX IF NOT EXISTS idx_github_repo_suites_integration_ref ON github_repo_suites(integration_id, repo_ref);

CREATE TABLE IF NOT EXISTS github_pr_runs (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    integration_id     UUID NOT NULL REFERENCES github_integrations(id) ON DELETE CASCADE,
    schedule_id        UUID REFERENCES github_run_schedules(id) ON DELETE SET NULL,
    pr_number          INT NOT NULL,
    head_sha           TEXT NOT NULL,
    base_sha           TEXT,
    execution_run_id   UUID,
    comment_id         BIGINT,
    suite_mode         TEXT NOT NULL,
    selected_tests     JSONB,
    status             TEXT NOT NULL DEFAULT 'pending',
    error_message      TEXT,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_github_pr_runs_integration_pr ON github_pr_runs(integration_id, pr_number);
CREATE INDEX IF NOT EXISTS idx_github_pr_runs_execution_run  ON github_pr_runs(execution_run_id);
