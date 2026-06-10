ALTER TABLE report_runs
  ADD COLUMN IF NOT EXISTS release_risk_score INTEGER,
  ADD COLUMN IF NOT EXISTS release_risk_level VARCHAR(16),
  ADD COLUMN IF NOT EXISTS release_risk_breakdown JSONB,
  ADD COLUMN IF NOT EXISTS release_risk_updated_at TIMESTAMPTZ;

ALTER TABLE report_tests
  ADD COLUMN IF NOT EXISTS ai_analysis_prompt_version VARCHAR(64),
  ADD COLUMN IF NOT EXISTS is_probable_regression BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS regression_confidence INTEGER,
  ADD COLUMN IF NOT EXISTS regression_pass_streak_before_fail INTEGER,
  ADD COLUMN IF NOT EXISTS regression_first_seen_run_id UUID REFERENCES report_runs(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS regression_hint TEXT;

CREATE TABLE IF NOT EXISTS report_failure_clusters (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES execute_projects(id) ON DELETE CASCADE,
  cluster_key VARCHAR(255) NOT NULL,
  title VARCHAR(500),
  primary_signature TEXT,
  category_hint VARCHAR(32),
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  occurrence_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (project_id, cluster_key)
);

CREATE TABLE IF NOT EXISTS report_test_cluster_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  report_test_id UUID NOT NULL REFERENCES report_tests(id) ON DELETE CASCADE,
  cluster_id UUID NOT NULL REFERENCES report_failure_clusters(id) ON DELETE CASCADE,
  match_confidence INTEGER,
  match_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (report_test_id, cluster_id)
);

CREATE TABLE IF NOT EXISTS report_test_flakiness_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES execute_projects(id) ON DELETE CASCADE,
  test_identity_key VARCHAR(2000) NOT NULL,
  spec VARCHAR(1000),
  test_name VARCHAR(2000),
  score INTEGER NOT NULL,
  trend_slope NUMERIC(10, 4),
  likely_reason TEXT,
  window_size INTEGER NOT NULL DEFAULT 20,
  computed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_report_runs_project_risk
  ON report_runs (project_id, release_risk_score DESC NULLS LAST, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_report_tests_regression
  ON report_tests (report_run_id, is_probable_regression);

CREATE INDEX IF NOT EXISTS idx_report_tests_prompt_version
  ON report_tests (report_run_id, ai_analysis_prompt_version);

CREATE INDEX IF NOT EXISTS idx_report_failure_clusters_project_last_seen
  ON report_failure_clusters (project_id, last_seen_at DESC);

CREATE INDEX IF NOT EXISTS idx_report_test_cluster_links_test
  ON report_test_cluster_links (report_test_id);

CREATE INDEX IF NOT EXISTS idx_report_test_cluster_links_cluster
  ON report_test_cluster_links (cluster_id);

CREATE INDEX IF NOT EXISTS idx_report_test_flakiness_snapshots_project_identity
  ON report_test_flakiness_snapshots (project_id, test_identity_key, computed_at DESC);
