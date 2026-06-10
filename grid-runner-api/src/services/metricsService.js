import { query } from "../db/database.js";
import { config } from "../config.js";

export async function currentMetrics() {
  const runResult = await query(
    `SELECT
       COUNT(*) FILTER (WHERE status = 'running')::int AS running_runs,
       COUNT(*) FILTER (WHERE status = 'completed')::int AS completed_runs,
       COUNT(*) FILTER (WHERE status = 'failed')::int AS failed_runs,
       COUNT(*) FILTER (WHERE status = 'cancelled')::int AS cancelled_runs
     FROM execution_runs`
  );
  const jobResult = await query(
    `SELECT
       COUNT(*) FILTER (WHERE ej.status = 'queued')::int AS queued_jobs,
       COUNT(*) FILTER (WHERE ej.status = 'running')::int AS running_jobs,
       COUNT(*) FILTER (WHERE ej.status = 'passed')::int AS passed_jobs,
       COUNT(*) FILTER (WHERE ej.status = 'failed')::int AS failed_jobs,
       COUNT(*) FILTER (WHERE ej.status = 'cancelled')::int AS cancelled_jobs,
       COALESCE(SUM(GREATEST(1, ej.test_case_count)) FILTER (WHERE ej.status = 'queued'), 0)::int AS queued_test_cases,
       COALESCE(SUM(GREATEST(1, ej.test_case_count)) FILTER (WHERE ej.status = 'running'), 0)::int AS running_test_cases,
       COALESCE(SUM(GREATEST(1, ej.test_case_count)) FILTER (WHERE ej.status = 'passed'), 0)::int AS passed_test_cases,
       COALESCE(SUM(GREATEST(1, ej.test_case_count)) FILTER (WHERE ej.status = 'failed'), 0)::int AS failed_test_cases,
       COALESCE(SUM(GREATEST(1, ej.test_case_count)) FILTER (WHERE ej.status = 'cancelled'), 0)::int AS cancelled_test_cases
     FROM execution_jobs ej
     JOIN execution_runs er ON er.id = ej.run_id
     WHERE er.status = 'running'`
  );
  return { ...runResult.rows[0], ...jobResult.rows[0] };
}

export async function queueLoadSnapshot() {
  const { rows } = await query(
    `SELECT
       COUNT(*) FILTER (WHERE status = 'queued')::int AS queued_jobs,
       COUNT(*) FILTER (WHERE status = 'running')::int AS running_jobs,
       COUNT(*) FILTER (WHERE status IN ('failed','cancelled'))::int AS errored_jobs,
       COALESCE(SUM(GREATEST(1, test_case_count)) FILTER (WHERE status = 'queued'), 0)::int AS queued_test_cases,
       COALESCE(SUM(GREATEST(1, test_case_count)) FILTER (WHERE status = 'running'), 0)::int AS running_test_cases
     FROM execution_jobs`
  );
  const activeRuns = await query(
    "SELECT COUNT(*)::int AS c FROM execution_runs WHERE status = 'running'"
  );
  return { ...rows[0], activeRuns: activeRuns.rows[0].c };
}

export async function countGlobalPendingDispatch() {
  const { rows } = await query(
    `SELECT COUNT(*)::int AS jobs,
            COALESCE(SUM(GREATEST(1, ej.test_case_count)), 0)::int AS test_cases
     FROM execution_jobs ej
     JOIN execution_runs er ON er.id = ej.run_id
     WHERE ej.status = 'queued'
       AND ej.queue_job_id IS NULL
       AND (
         (COALESCE(ej.runtime_mode, 'script') = 'script' AND ej.script IS NOT NULL AND btrim(ej.script) <> '')
         OR (COALESCE(ej.runtime_mode, 'script') = 'project' AND COALESCE(ej.provider_payload_json->>'projectBundleGzipBase64', '') <> '')
       )
       AND er.status = 'running'`
  );
  return {
    jobs: rows[0].jobs,
    testCases: rows[0].test_cases,
  };
}

export async function autoscaleRecommendation() {
  const snapshot = await queueLoadSnapshot();
  const pendingDispatch = await countGlobalPendingDispatch();
  const targetPerWorker = Math.max(1, config.autoscaleTargetTestCasesPerWorker);
  const minWorkers = Math.max(0, config.autoscaleMinWorkers);
  const maxWorkers = Math.max(minWorkers, config.autoscaleMaxWorkers);
  const warmWorkers = Math.max(0, config.autoscaleWarmWorkers);

  const pressure = snapshot.queued_test_cases
    + Math.max(0, Math.floor(snapshot.running_test_cases / 2))
    + pendingDispatch.testCases;
  let desired = Math.ceil(pressure / targetPerWorker);
  desired = Math.max(minWorkers, desired);
  if (snapshot.queued_test_cases === 0 && snapshot.running_test_cases === 0) {
    desired = Math.max(minWorkers, warmWorkers);
  }
  desired = Math.min(maxWorkers, desired);

  let scaleReason;
  if (snapshot.queued_test_cases === 0 && snapshot.running_test_cases === 0) {
    scaleReason = "Queue is idle; keeping warm/min worker floor.";
  } else if (desired === maxWorkers) {
    scaleReason = "Queue pressure reached max worker cap.";
  } else if (desired === minWorkers && snapshot.queued_test_cases <= 1) {
    scaleReason = "Low queue pressure; staying near minimum workers.";
  } else {
    scaleReason = "Scaling from testcase pressure, pending dispatch backlog, and active execution load.";
  }

  return {
    desiredWorkers: desired,
    minWorkers,
    maxWorkers,
    targetTestCasesPerWorker: targetPerWorker,
    warmWorkers,
    queuedJobs: snapshot.queued_jobs,
    runningJobs: snapshot.running_jobs,
    queuedTestCases: snapshot.queued_test_cases,
    runningTestCases: snapshot.running_test_cases,
    activeRuns: snapshot.activeRuns,
    pendingDispatchJobs: pendingDispatch.jobs,
    pendingDispatchTestCases: pendingDispatch.testCases,
    scalerPressure: pressure,
    scaleReason,
  };
}

export async function startupLagSnapshot() {
  const { rows } = await query(
    `SELECT
       COUNT(*) FILTER (WHERE status = 'running' AND first_job_started_at IS NULL AND queued_test_cases > 0)::int AS waiting_runs,
       COALESCE(
         MAX(EXTRACT(EPOCH FROM (now() - started_at)))
         FILTER (WHERE status = 'running' AND first_job_started_at IS NULL AND queued_test_cases > 0),
         0
       )::int AS oldest_waiting_run_age_seconds
     FROM execution_runs`
  );
  return rows[0];
}
