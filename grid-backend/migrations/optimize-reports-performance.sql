-- Migration to optimize tesbo-reports query performance
-- Run this in your production database to fix 500 errors

-- Add indexes for report_runs queries
CREATE INDEX IF NOT EXISTS idx_report_runs_project_created 
ON report_runs(project_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_report_runs_project_status 
ON report_runs(project_id, status);

-- Add indexes for report_tests queries  
CREATE INDEX IF NOT EXISTS idx_report_tests_run_id 
ON report_tests(report_run_id);

CREATE INDEX IF NOT EXISTS idx_report_tests_spec 
ON report_tests(spec);

CREATE INDEX IF NOT EXISTS idx_report_tests_status 
ON report_tests(status);

CREATE INDEX IF NOT EXISTS idx_report_tests_ai_category 
ON report_tests(ai_analysis_category);

-- Composite index for spec intelligence queries
CREATE INDEX IF NOT EXISTS idx_report_tests_spec_status 
ON report_tests(spec, status);

-- Add index for joining reports with AI key allocations
CREATE INDEX IF NOT EXISTS idx_execute_project_ai_allocations 
ON execute_project_ai_key_allocations(execute_project_id, workspace_ai_key_id);

-- Analyze tables to update statistics
ANALYZE report_runs;
ANALYZE report_tests;
ANALYZE execute_project_ai_key_allocations;

-- Check current connection pool usage
SELECT 
    datname,
    numbackends as active_connections,
    (SELECT setting FROM pg_settings WHERE name = 'max_connections')::int as max_connections,
    ROUND(100.0 * numbackends / (SELECT setting FROM pg_settings WHERE name = 'max_connections')::int, 2) as percent_used
FROM pg_stat_database
WHERE datname = current_database();