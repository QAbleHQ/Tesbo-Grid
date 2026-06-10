import { query } from "../db/database.js";
import { recomputeRunById } from "./runService.js";

export async function getJob(jobId) {
  const { rows } = await query(
    `SELECT id, run_id, external_ref, status, script, max_retries,
            execution_provider, shard_index, shard_total, test_case_count,
            language, runtime_mode, runtime_entrypoint, runtime_config_json
     FROM execution_jobs WHERE id = $1`,
    [jobId]
  );
  if (!rows.length) return null;
  const r = rows[0];
  return {
    jobId: r.id,
    runId: r.run_id,
    externalRef: r.external_ref,
    status: r.status,
    script: r.script,
    maxRetries: r.max_retries,
    executionProvider: r.execution_provider,
    shardIndex: r.shard_index,
    shardTotal: r.shard_total,
    testCaseCount: r.test_case_count,
    runtime: {
      framework: r.runtime_config_json?.framework || "playwright",
      language: r.language || "javascript",
      executionMode: r.runtime_mode || "script",
      entrypoint: r.runtime_entrypoint || "",
      command: r.runtime_config_json?.command || "",
      configFile: r.runtime_config_json?.configFile || "",
      browser: r.runtime_config_json?.browser || "chrome",
      testSelector: r.runtime_config_json?.testSelector || "",
    },
  };
}

export async function markJobStarted(jobId, workerId, attempt = 0) {
  await query(
    `UPDATE execution_jobs
     SET status = 'running',
         worker_id = $1,
         retry_count = $2,
         started_at = COALESCE(started_at, now()),
         last_heartbeat_at = now(),
         updated_at = now()
     WHERE id = $3`,
    [workerId, Math.max(0, attempt), jobId]
  );
  await query(
    `UPDATE execution_runs
     SET first_job_started_at = COALESCE(first_job_started_at, now()),
         updated_at = now()
     WHERE id = (SELECT run_id FROM execution_jobs WHERE id = $1)`,
    [jobId]
  );
  await recomputeRunByJob(jobId);
}

export async function heartbeat(jobId, workerId) {
  await query(
    `UPDATE execution_jobs
     SET worker_id = COALESCE($1, worker_id),
         last_heartbeat_at = now(),
         updated_at = now()
     WHERE id = $2`,
    [workerId, jobId]
  );
}

export async function markJobCompleted(jobId) {
  await query(
    `UPDATE execution_jobs
     SET status = 'passed',
         ended_at = now(),
         last_heartbeat_at = now(),
         updated_at = now()
     WHERE id = $1`,
    [jobId]
  );
  return recomputeRunByJob(jobId);
}

export async function markJobFailed(jobId, errorMessage, willRetry, attempt = 0) {
  const nextStatus = willRetry ? "queued" : "failed";
  await query(
    `UPDATE execution_jobs
     SET status = $1,
         error_message = $2,
         retry_count = $3,
         ended_at = CASE WHEN $1 = 'failed' THEN now() ELSE ended_at END,
         last_heartbeat_at = now(),
         updated_at = now()
     WHERE id = $4`,
    [nextStatus, errorMessage, Math.max(0, attempt), jobId]
  );
  return recomputeRunByJob(jobId);
}

export async function markJobEnqueued(jobId, queueJobId) {
  await query(
    "UPDATE execution_jobs SET queue_job_id = $1, updated_at = now() WHERE id = $2",
    [queueJobId, jobId]
  );
}

export async function getJobRunId(jobId) {
  const { rows } = await query("SELECT run_id FROM execution_jobs WHERE id = $1", [jobId]);
  return rows.length ? rows[0].run_id : null;
}

async function recomputeRunByJob(jobId) {
  const runId = await getJobRunId(jobId);
  if (runId) return recomputeRunById(runId);
  return null;
}
