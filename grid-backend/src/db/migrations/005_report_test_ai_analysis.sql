ALTER TABLE report_tests
  ADD COLUMN IF NOT EXISTS ai_analysis_status VARCHAR(32),
  ADD COLUMN IF NOT EXISTS ai_analysis_category VARCHAR(32),
  ADD COLUMN IF NOT EXISTS ai_analysis_summary TEXT,
  ADD COLUMN IF NOT EXISTS ai_analysis_confidence INTEGER,
  ADD COLUMN IF NOT EXISTS ai_analysis_model VARCHAR(255),
  ADD COLUMN IF NOT EXISTS ai_analysis_updated_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_report_tests_ai_status
  ON report_tests (report_run_id, ai_analysis_status);
