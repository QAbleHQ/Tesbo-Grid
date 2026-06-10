ALTER TABLE execution_jobs
    ADD COLUMN IF NOT EXISTS test_case_count INT NOT NULL DEFAULT 1;

ALTER TABLE execution_runs
    ADD COLUMN IF NOT EXISTS total_test_cases INT NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS queued_test_cases INT NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS completed_test_cases INT NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS passed_test_cases INT NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS failed_test_cases INT NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS cancelled_test_cases INT NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS first_job_started_at TIMESTAMPTZ;

UPDATE execution_jobs
SET test_case_count = 1
WHERE test_case_count IS NULL OR test_case_count < 1;

UPDATE execution_runs r
SET total_test_cases = COALESCE(s.total_test_cases, 0),
    queued_test_cases = COALESCE(s.queued_test_cases, 0),
    completed_test_cases = COALESCE(s.completed_test_cases, 0),
    passed_test_cases = COALESCE(s.passed_test_cases, 0),
    failed_test_cases = COALESCE(s.failed_test_cases, 0),
    cancelled_test_cases = COALESCE(s.cancelled_test_cases, 0)
FROM (
    SELECT ej.run_id,
           COALESCE(SUM(GREATEST(1, ej.test_case_count)), 0)::int AS total_test_cases,
           COALESCE(SUM(GREATEST(1, ej.test_case_count)) FILTER (WHERE ej.status = 'queued'), 0)::int AS queued_test_cases,
           COALESCE(SUM(GREATEST(1, ej.test_case_count)) FILTER (WHERE ej.status IN ('passed', 'failed', 'cancelled', 'manual')), 0)::int AS completed_test_cases,
           COALESCE(SUM(GREATEST(1, ej.test_case_count)) FILTER (WHERE ej.status = 'passed'), 0)::int AS passed_test_cases,
           COALESCE(SUM(GREATEST(1, ej.test_case_count)) FILTER (WHERE ej.status = 'failed'), 0)::int AS failed_test_cases,
           COALESCE(SUM(GREATEST(1, ej.test_case_count)) FILTER (WHERE ej.status = 'cancelled'), 0)::int AS cancelled_test_cases
    FROM execution_jobs ej
    GROUP BY ej.run_id
) s
WHERE r.id = s.run_id;
