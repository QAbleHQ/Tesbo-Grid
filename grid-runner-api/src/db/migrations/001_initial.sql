-- Tesbo Execution Service: standalone schema (no FK to external product tables).
-- All external references are opaque strings the caller provides.

CREATE TABLE IF NOT EXISTS execution_runs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    external_ref TEXT,
    project_id TEXT,
    status TEXT NOT NULL DEFAULT 'running',
    total_jobs INT NOT NULL DEFAULT 0,
    completed_jobs INT NOT NULL DEFAULT 0,
    passed_jobs INT NOT NULL DEFAULT 0,
    failed_jobs INT NOT NULL DEFAULT 0,
    cancelled_jobs INT NOT NULL DEFAULT 0,
    queued_jobs INT NOT NULL DEFAULT 0,
    max_parallel INT NOT NULL DEFAULT 1,
    execution_provider TEXT NOT NULL DEFAULT 'default',
    provider_config_json JSONB DEFAULT '{}'::jsonb,
    webhook_url TEXT,
    webhook_secret TEXT,
    error_message TEXT,
    started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    ended_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_execution_runs_status ON execution_runs(status);
CREATE INDEX IF NOT EXISTS idx_execution_runs_project ON execution_runs(project_id);
CREATE INDEX IF NOT EXISTS idx_execution_runs_external_ref ON execution_runs(external_ref);

CREATE TABLE IF NOT EXISTS execution_jobs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    run_id UUID NOT NULL REFERENCES execution_runs(id) ON DELETE CASCADE,
    external_ref TEXT,
    title TEXT,
    script TEXT,
    start_url TEXT,
    status TEXT NOT NULL DEFAULT 'queued',
    worker_id TEXT,
    queue_job_id TEXT,
    retry_count INT NOT NULL DEFAULT 0,
    max_retries INT NOT NULL DEFAULT 2,
    execution_provider TEXT NOT NULL DEFAULT 'default',
    provider_payload_json JSONB DEFAULT '{}'::jsonb,
    shard_index INT NOT NULL DEFAULT 1,
    shard_total INT NOT NULL DEFAULT 1,
    last_heartbeat_at TIMESTAMPTZ,
    error_message TEXT,
    started_at TIMESTAMPTZ,
    ended_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_execution_jobs_run ON execution_jobs(run_id);
CREATE INDEX IF NOT EXISTS idx_execution_jobs_status ON execution_jobs(status);
CREATE INDEX IF NOT EXISTS idx_execution_jobs_external_ref ON execution_jobs(external_ref);
CREATE INDEX IF NOT EXISTS idx_execution_jobs_dispatch ON execution_jobs(status, queue_job_id)
    WHERE status = 'queued' AND queue_job_id IS NULL;

CREATE TABLE IF NOT EXISTS execution_reports (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    run_id UUID NOT NULL REFERENCES execution_runs(id) ON DELETE CASCADE,
    job_id UUID NOT NULL REFERENCES execution_jobs(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'pending',
    started_at TIMESTAMPTZ,
    ended_at TIMESTAMPTZ,
    logs JSONB DEFAULT '[]'::jsonb,
    video_path TEXT,
    screenshot_path TEXT,
    trace_path TEXT,
    error_message TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (job_id)
);

CREATE INDEX IF NOT EXISTS idx_execution_reports_run ON execution_reports(run_id);

CREATE TABLE IF NOT EXISTS api_keys (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    key_hash TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    project_id TEXT,
    scopes TEXT[] NOT NULL DEFAULT '{runs:write,runs:read,queue:read}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_used_at TIMESTAMPTZ,
    revoked_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys(key_hash);
