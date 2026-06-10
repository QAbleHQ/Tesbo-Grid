import { query, transaction } from "../db/database.js";
import { config } from "../config.js";
import { hasQueueableWork, normalizeRuntime } from "./runtimeContract.js";

export async function createRunWithJobs(input) {
  const {
    jobs,
    externalRef = null,
    projectId = null,
    organizationId: organizationIdInput = null,
    executionProvider = "default",
    providerConfig = {},
    webhookUrl = null,
    webhookSecret = null,
    modelProvider = "",
    modelApiKey = "",
    model = "",
    tesboConfig = {},
    schedulerPolicy = {},
  } = input;

  const metadata = {};
  if (modelProvider) metadata.modelProvider = modelProvider;
  if (modelApiKey) metadata.modelApiKey = modelApiKey;
  if (model) metadata.model = model;
  const jobTestCaseCounts = jobs.map(inferJobTestCaseCount);
  const queueable = jobs
    .map((job, index) => ({ job, index, queueable: hasQueueableWork(job) }))
    .filter((entry) => entry.queueable);
  const queueableTestCases = queueable.reduce((sum, entry) => sum + jobTestCaseCounts[entry.index], 0);
  const maxJobTestCases = queueable.reduce((max, entry) => Math.max(max, jobTestCaseCounts[entry.index]), 1);
  const tenantPolicy = buildTenantSchedulerPolicy({
    projectId,
    requestedPolicy: schedulerPolicy,
    queueableTestCases,
    maxJobTestCases,
  });
  metadata.schedulerPolicy = tenantPolicy;
  if (tesboConfig?.tesboApiUrl && tesboConfig?.tesboAccessKey) {
    metadata.tesboConfig = {
      tesboApiUrl: tesboConfig.tesboApiUrl,
      tesboUiUrl: tesboConfig.tesboUiUrl || null,
      tesboAccessKey: tesboConfig.tesboAccessKey,
      runName: tesboConfig.runName || null,
    };
    metadata.tesboIngestion = {
      status: "pending",
      runId: null,
      runUrl: null,
      error: null,
      startedAt: null,
      completedAt: null,
    };
  }

  // The owning org is normally supplied by the caller (resolved from the
  // API key against grid-backend, which owns execute_projects). Fall back to
  // a direct lookup only for shared-DB dev/test setups where execute_projects
  // is reachable from this service.
  //
  // Either way, resolve BEFORE opening the run-creation transaction:
  // execute_projects is absent from this service's production database, and a
  // failed query inside a transaction aborts the whole transaction in
  // Postgres — the JS try/catch in the resolver cannot un-abort it, so every
  // following statement would fail with "current transaction is aborted".
  // Running it on its own connection isolates that failure.
  const organizationId =
    organizationIdInput || (await resolveProjectOrganizationId(projectId));

  return transaction(async (client) => {
    const effectiveRunAllocation = computePlatformRunAllocation({
      tenantPolicy,
      queueableTestCases,
      maxJobTestCases,
    });
    const totalTestCases = jobTestCaseCounts.reduce((sum, count) => sum + count, 0);
    const runResult = await client.query(
      `INSERT INTO execution_runs
        (external_ref, project_id, organization_id, status, total_jobs, total_test_cases, queued_jobs, queued_test_cases, max_parallel,
         execution_provider, provider_config_json, webhook_url, webhook_secret,
         metadata_json, started_at)
       VALUES ($1, $2, $3, 'running', $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12, $13::jsonb, now())
       RETURNING id`,
      [
        externalRef,
        projectId,
        organizationId,
        jobs.length,
        totalTestCases,
        jobs.length,
        totalTestCases,
        effectiveRunAllocation,
        executionProvider || "default",
        JSON.stringify(providerConfig || {}),
        webhookUrl || null,
        webhookSecret || null,
        JSON.stringify(metadata),
      ]
    );
    const runId = runResult.rows[0].id;

    const shardTotal = Math.max(1, Math.min(Math.max(1, effectiveRunAllocation), queueable.length));
    const shardAssignment = assignShards(jobs, shardTotal);

    for (let i = 0; i < jobs.length; i++) {
      const job = jobs[i];
      const runtime = normalizeRuntime(job);
      const queueable = hasQueueableWork(job, runtime);
      const status = queueable ? "queued" : "manual";
      const shardIndex = queueable ? (shardAssignment.get(i) || 1) : 1;

      await client.query(
        `INSERT INTO execution_jobs
          (run_id, external_ref, title, script, start_url, status,
           max_retries, execution_provider, provider_payload_json, shard_index, shard_total, test_case_count,
           language, runtime_mode, runtime_entrypoint, runtime_config_json)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12, $13, $14, $15, $16::jsonb)`,
        [
          runId,
          job.externalRef || null,
          job.title || null,
          job.script || null,
          job.startUrl || null,
          status,
          job.maxRetries ?? config.defaultMaxRetries,
          executionProvider || "default",
          JSON.stringify(job.providerPayload || providerConfig || {}),
          shardIndex,
          shardTotal,
          jobTestCaseCounts[i],
          runtime.language,
          runtime.executionMode,
          runtime.entrypoint || null,
          JSON.stringify({
            framework: runtime.framework || "playwright",
            command: runtime.command || "",
            configFile: runtime.configFile || "",
            browser: runtime.browser || "chrome",
            testSelector: runtime.testSelector || "",
          }),
        ]
      );
    }

    await recomputeRun(client, runId);

    return {
      runId,
      externalRef,
      status: "running",
      totalJobs: jobs.length,
      totalTestCases,
      executionProvider,
      maxParallel: effectiveRunAllocation,
      schedulerPolicy: {
        tenantConcurrencyLimit: tenantPolicy.tenantConcurrencyLimit,
        tenantWeight: tenantPolicy.tenantWeight,
        burstConcurrencyLimit: tenantPolicy.burstConcurrencyLimit,
        reservedConcurrency: tenantPolicy.reservedConcurrency,
        reasonCode: tenantPolicy.reasonCode,
      },
      modelProvider,
      modelApiKey,
      model,
    };
  });
}

export async function appendJobsToRun(input) {
  const { runId, jobs } = input;
  if (!runId) throw new Error("runId is required");
  if (!Array.isArray(jobs) || jobs.length === 0) {
    throw new Error("jobs array is required and must not be empty");
  }

  return transaction(async (client) => {
    const runResult = await client.query(
      `SELECT id, project_id, status, execution_provider, provider_config_json, max_parallel,
              total_test_cases, metadata_json
       FROM execution_runs
       WHERE id = $1
       FOR UPDATE`,
      [runId]
    );
    if (!runResult.rows.length) {
      throw new Error("Run not found");
    }

    const runRow = runResult.rows[0];
    if (runRow.status !== "running") {
      throw new Error("Run is not accepting new jobs");
    }

    const counts = jobs.map(inferJobTestCaseCount);
    const incomingTotalJobs = jobs.length;
    const incomingTotalTestCases = counts.reduce((sum, count) => sum + count, 0);
    const maxIncomingJobTestCases = counts.reduce((max, count) => Math.max(max, count), 1);
    const tenantPolicy = normalizeSchedulerPolicy(runRow.metadata_json?.schedulerPolicy || {});
    const totalQueuedCapacityAfterAppend = Math.max(
      1,
      Number(runRow.total_test_cases || 0) + incomingTotalTestCases
    );
    const updatedRunAllocation = computePlatformRunAllocation({
      tenantPolicy,
      queueableTestCases: totalQueuedCapacityAfterAppend,
      maxJobTestCases: Math.max(Number(runRow.max_parallel) || 1, maxIncomingJobTestCases),
    });
    const shardTotal = Math.max(1, updatedRunAllocation, maxIncomingJobTestCases);

    const { rows: existingCountsRows } = await client.query(
      `SELECT COALESCE(COUNT(*), 0)::int AS c
       FROM execution_jobs
       WHERE run_id = $1 AND status <> 'manual'`,
      [runId]
    );
    let shardCursor = Number(existingCountsRows[0]?.c || 0);

    for (let i = 0; i < jobs.length; i++) {
      const job = jobs[i];
      const runtime = normalizeRuntime(job);
      const queueable = hasQueueableWork(job, runtime);
      const status = queueable ? "queued" : "manual";
      const shardIndex = queueable ? ((shardCursor % shardTotal) + 1) : 1;
      if (queueable) shardCursor += 1;

      await client.query(
        `INSERT INTO execution_jobs
          (run_id, external_ref, title, script, start_url, status,
           max_retries, execution_provider, provider_payload_json, shard_index, shard_total, test_case_count,
           language, runtime_mode, runtime_entrypoint, runtime_config_json)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12, $13, $14, $15, $16::jsonb)`,
        [
          runId,
          job.externalRef || null,
          job.title || null,
          job.script || null,
          job.startUrl || null,
          status,
          job.maxRetries ?? config.defaultMaxRetries,
          runRow.execution_provider || "default",
          JSON.stringify(job.providerPayload || runRow.provider_config_json || {}),
          shardIndex,
          shardTotal,
          counts[i],
          runtime.language,
          runtime.executionMode,
          runtime.entrypoint || null,
          JSON.stringify({
            framework: runtime.framework || "playwright",
            command: runtime.command || "",
            configFile: runtime.configFile || "",
            browser: runtime.browser || "chrome",
            testSelector: runtime.testSelector || "",
          }),
        ]
      );
    }

    await client.query(
      `UPDATE execution_runs
       SET total_jobs = total_jobs + $2,
           total_test_cases = total_test_cases + $3,
           queued_jobs = queued_jobs + $2,
           queued_test_cases = queued_test_cases + $3,
           max_parallel = GREATEST(max_parallel, $4),
           updated_at = now()
       WHERE id = $1`,
      [runId, incomingTotalJobs, incomingTotalTestCases, updatedRunAllocation]
    );

    await recomputeRun(client, runId);
    const { rows: runRows } = await client.query(
      `SELECT id, external_ref, project_id, status, total_jobs, completed_jobs,
              passed_jobs, failed_jobs, cancelled_jobs, queued_jobs,
              total_test_cases, queued_test_cases, completed_test_cases,
              passed_test_cases, failed_test_cases, cancelled_test_cases,
              max_parallel, execution_provider, error_message,
              started_at, ended_at, first_job_started_at, metadata_json
       FROM execution_runs
       WHERE id = $1`,
      [runId]
    );
    return runRows.length ? formatRun(runRows[0]) : null;
  });
}

export async function getRun(runId) {
  const { rows } = await query(
    `SELECT id, external_ref, project_id, status, total_jobs, completed_jobs,
            passed_jobs, failed_jobs, cancelled_jobs, queued_jobs,
            total_test_cases, queued_test_cases, completed_test_cases,
            passed_test_cases, failed_test_cases, cancelled_test_cases,
            max_parallel, execution_provider, error_message,
            started_at, ended_at, first_job_started_at, metadata_json
     FROM execution_runs WHERE id = $1`,
    [runId]
  );
  if (!rows.length) return null;
  return formatRun(rows[0]);
}

export async function getRunJobs(runId) {
  const { rows } = await query(
    `SELECT ej.id, ej.external_ref, ej.title, ej.status, ej.worker_id, ej.error_message,
            ej.shard_index, ej.shard_total, ej.execution_provider, ej.test_case_count,
            ej.language, ej.runtime_mode, ej.runtime_entrypoint, ej.runtime_config_json,
            ej.started_at, ej.ended_at,
            er.video_path, er.screenshot_path, er.trace_path
     FROM execution_jobs ej
     LEFT JOIN execution_reports er ON er.job_id = ej.id
     WHERE ej.run_id = $1
     ORDER BY ej.created_at ASC`,
    [runId]
  );
  return rows.map((r, i) => ({
    jobId: r.id,
    externalRef: r.external_ref,
    title: r.title,
    status: r.status,
    workerId: r.worker_id,
    errorMessage: r.error_message,
    shardIndex: r.shard_index,
    shardTotal: r.shard_total,
    testCaseCount: r.test_case_count,
    executionProvider: r.execution_provider,
    runtime: {
      framework: r.runtime_config_json?.framework || "playwright",
      language: r.language || "javascript",
      executionMode: r.runtime_mode || "script",
      entrypoint: r.runtime_entrypoint || null,
      command: r.runtime_config_json?.command || "",
      configFile: r.runtime_config_json?.configFile || "",
      browser: r.runtime_config_json?.browser || "chrome",
      testSelector: r.runtime_config_json?.testSelector || "",
    },
    index: i + 1,
    startedAt: r.started_at ? r.started_at.toISOString() : null,
    endedAt: r.ended_at ? r.ended_at.toISOString() : null,
    videoPath: r.video_path || null,
    screenshotPath: r.screenshot_path || null,
    tracePath: r.trace_path || null,
  }));
}

export async function cancelRun(runId, reason = "Cancelled by user") {
  await query(
    `UPDATE execution_runs
     SET status = 'cancelled', error_message = $1, ended_at = now(), updated_at = now()
     WHERE id = $2 AND status = 'running'`,
    [reason, runId]
  );
  await query(
    `UPDATE execution_jobs
     SET status = 'cancelled', updated_at = now()
     WHERE run_id = $1 AND status = 'queued'`,
    [runId]
  );
}

export async function findActiveRunForExternalRef(externalRef) {
  if (!externalRef) return null;
  const { rows } = await query(
    `SELECT id FROM execution_runs
     WHERE external_ref = $1 AND status = 'running'
     ORDER BY started_at DESC LIMIT 1`,
    [externalRef]
  );
  return rows.length ? rows[0].id : null;
}

// (countActiveRunsForProject / countQueuedTestCasesForProject were used to
// enforce per-project run / queue caps that have been removed in favour of
// dashboard-set per-project settings — see grid-runner-api/src/config.js
// for the historical rationale. Dispatch already has its own per-project
// in-flight counters in dispatchService.js.)

export async function getRunMetadata(runId) {
  const { rows } = await query(
    "SELECT project_id, metadata_json FROM execution_runs WHERE id = $1",
    [runId]
  );
  if (!rows.length) return null;
  const meta = rows[0].metadata_json || {};
  return {
    projectId: rows[0].project_id,
    modelProvider: meta.modelProvider || "",
    modelApiKey: meta.modelApiKey || "",
    model: meta.model || "",
  };
}

export async function findRunsByExternalRef(externalRef) {
  if (!externalRef) return [];
  const { rows } = await query(
    `SELECT id, external_ref, project_id, status, total_jobs, completed_jobs,
            passed_jobs, failed_jobs, cancelled_jobs, queued_jobs,
            total_test_cases, queued_test_cases, completed_test_cases,
            passed_test_cases, failed_test_cases, cancelled_test_cases,
            max_parallel, execution_provider, error_message,
            started_at, ended_at, first_job_started_at, metadata_json
     FROM execution_runs
     WHERE external_ref = $1
     ORDER BY started_at DESC`,
    [externalRef]
  );
  return rows.map(formatRun);
}

export async function getRunWebhookConfig(runId) {
  const { rows } = await query(
    "SELECT webhook_url, webhook_secret, external_ref FROM execution_runs WHERE id = $1",
    [runId]
  );
  return rows.length ? rows[0] : null;
}

const _recomputePending = new Map();
const RECOMPUTE_DEBOUNCE_MS = 200;

export async function recomputeRunById(runId) {
  if (_recomputePending.has(runId)) {
    return _recomputePending.get(runId);
  }
  const promise = new Promise((resolve) => {
    setTimeout(async () => {
      _recomputePending.delete(runId);
      try {
        const status = await recomputeRun(null, runId);
        resolve(status);
      } catch {
        resolve(null);
      }
    }, RECOMPUTE_DEBOUNCE_MS);
  });
  _recomputePending.set(runId, promise);
  return promise;
}

async function recomputeRun(client, runId) {
  const sql = `
    UPDATE execution_runs r
    SET queued_jobs = c.queued_jobs,
        completed_jobs = c.completed_jobs,
        passed_jobs = c.passed_jobs,
        failed_jobs = c.failed_jobs,
        cancelled_jobs = c.cancelled_jobs,
        queued_test_cases = c.queued_test_cases,
        completed_test_cases = c.completed_test_cases,
        passed_test_cases = c.passed_test_cases,
        failed_test_cases = c.failed_test_cases,
        cancelled_test_cases = c.cancelled_test_cases,
        status = CASE
            WHEN r.status = 'cancelled' THEN r.status
            WHEN c.completed_jobs >= r.total_jobs THEN
              CASE WHEN c.failed_jobs > 0 THEN 'failed' ELSE 'completed' END
            ELSE 'running'
        END,
        ended_at = CASE
            WHEN r.status = 'cancelled' THEN r.ended_at
            WHEN c.completed_jobs >= r.total_jobs THEN COALESCE(r.ended_at, now())
            ELSE NULL
        END,
        updated_at = now()
    FROM (
        SELECT run_id,
               COUNT(*) FILTER (WHERE status = 'queued') AS queued_jobs,
               COUNT(*) FILTER (WHERE status IN ('passed', 'failed', 'cancelled', 'manual')) AS completed_jobs,
               COUNT(*) FILTER (WHERE status = 'passed') AS passed_jobs,
               COUNT(*) FILTER (WHERE status = 'failed') AS failed_jobs,
               COUNT(*) FILTER (WHERE status = 'cancelled') AS cancelled_jobs,
               COALESCE(SUM(GREATEST(1, test_case_count)) FILTER (WHERE status = 'queued'), 0)::int AS queued_test_cases,
               COALESCE(SUM(GREATEST(1, test_case_count)) FILTER (WHERE status IN ('passed', 'failed', 'cancelled', 'manual')), 0)::int AS completed_test_cases,
               COALESCE(SUM(GREATEST(1, test_case_count)) FILTER (WHERE status = 'passed'), 0)::int AS passed_test_cases,
               COALESCE(SUM(GREATEST(1, test_case_count)) FILTER (WHERE status = 'failed'), 0)::int AS failed_test_cases,
               COALESCE(SUM(GREATEST(1, test_case_count)) FILTER (WHERE status = 'cancelled'), 0)::int AS cancelled_test_cases
        FROM execution_jobs
        WHERE run_id = $1
        GROUP BY run_id
    ) c
    WHERE r.id = c.run_id
    RETURNING r.status`;
  const q = client ? client.query(sql, [runId]) : query(sql, [runId]);
  const { rows } = await q;
  return rows.length ? rows[0].status : null;
}

export function formatRun(row) {
  const meta = row.metadata_json || {};
  const ingestion = meta.tesboIngestion || {};
  const schedulerPolicy = meta.schedulerPolicy || {};
  const hasQueuedWork = Number(row.queued_jobs || 0) > 0;
  const totalTestCases = row.total_test_cases ?? row.total_jobs;
  const queuedTestCases = row.queued_test_cases ?? row.queued_jobs;
  const completedTestCases = row.completed_test_cases ?? row.completed_jobs;
  const schedulerReason = hasQueuedWork
    ? (schedulerPolicy.reasonCode || "waiting_for_scheduler_capacity")
    : null;
  return {
    runId: row.id,
    externalRef: row.external_ref,
    projectId: row.project_id,
    status: row.status,
    totalJobs: row.total_jobs,
    completedJobs: row.completed_jobs,
    passedJobs: row.passed_jobs,
    failedJobs: row.failed_jobs,
    cancelledJobs: row.cancelled_jobs,
    queuedJobs: row.queued_jobs,
    totalTestCases,
    queuedTestCases,
    runningTestCases: Math.max(0, totalTestCases - queuedTestCases - completedTestCases),
    completedTestCases,
    passedTestCases: row.passed_test_cases ?? row.passed_jobs,
    failedTestCases: row.failed_test_cases ?? row.failed_jobs,
    cancelledTestCases: row.cancelled_test_cases ?? row.cancelled_jobs,
    maxParallel: row.max_parallel,
    executionProvider: row.execution_provider,
    errorMessage: row.error_message,
    tenantConcurrencyLimit: schedulerPolicy.tenantConcurrencyLimit || null,
    tenantWeight: schedulerPolicy.tenantWeight || null,
    burstConcurrencyLimit: schedulerPolicy.burstConcurrencyLimit || null,
    reservedConcurrency: schedulerPolicy.reservedConcurrency || null,
    schedulerReason,
    startedAt: row.started_at ? row.started_at.toISOString() : null,
    firstJobStartedAt: row.first_job_started_at ? row.first_job_started_at.toISOString() : null,
    endedAt: row.ended_at ? row.ended_at.toISOString() : null,
    tesboIngestionStatus: ingestion.status || null,
    tesboRunId: ingestion.runId || null,
    tesboRunUrl: ingestion.runUrl || null,
    tesboIngestionError: ingestion.error || null,
  };
}

export function assignShards(jobs, shardTotal) {
  const assignment = new Map();
  if (shardTotal <= 1) {
    jobs.forEach((_, i) => assignment.set(i, 1));
    return assignment;
  }
  const shardLoad = new Array(shardTotal).fill(0);
  const queueable = jobs
    .map((j, i) => ({ index: i, queueable: hasQueueableWork(j) }))
    .filter((j) => j.queueable);

  for (const item of queueable) {
    let chosen = 0;
    for (let s = 1; s < shardTotal; s++) {
      if (shardLoad[s] < shardLoad[chosen]) chosen = s;
    }
    shardLoad[chosen] += 1;
    assignment.set(item.index, chosen + 1);
  }
  return assignment;
}

function inferJobTestCaseCount(job) {
  // Platform invariant: one execution job equals one test case.
  // Routes validate this contract before create/append.
  return 1;
}

// Stamps the run with the project's owning organization at create time so
// the dispatcher can enforce a per-org concurrency cap without joining
// execute_projects on every poll. Returns null when projectId is unknown
// or the project no longer exists — the dispatcher falls back to its
// existing per-project / global limits when organization_id is null.
async function resolveProjectOrganizationId(projectId) {
  if (!projectId) return null;
  try {
    const { rows } = await query(
      `SELECT organization_id FROM execute_projects WHERE id = $1 LIMIT 1`,
      [projectId]
    );
    return rows[0]?.organization_id || null;
  } catch (_err) {
    // execute_projects lives in grid-backend; if it's missing (dev/test
    // schemas, separate databases) we degrade to "no org cap".
    return null;
  }
}

function buildTenantSchedulerPolicy({ projectId, requestedPolicy, queueableTestCases, maxJobTestCases }) {
  const normalized = normalizeSchedulerPolicy(requestedPolicy);
  return {
    projectId: projectId || null,
    tenantConcurrencyLimit: Math.max(maxJobTestCases, normalized.tenantConcurrencyLimit),
    tenantWeight: normalized.tenantWeight,
    burstConcurrencyLimit: Math.max(
      maxJobTestCases,
      normalized.burstConcurrencyLimit,
      queueableTestCases
    ),
    reservedConcurrency: normalized.reservedConcurrency,
    reasonCode: queueableTestCases > normalized.tenantConcurrencyLimit
      ? "tenant_capacity_limited"
      : "platform_managed_allocation",
  };
}

// Per-project concurrency / queue limits are no longer enforced by env-var
// defaults — see grid-runner-api/src/config.js. Callers that pass an
// explicit `tenantConcurrencyLimit` (e.g. an API key whose stored
// schedulerPolicy carries a per-tenant cap) are still honored. When a
// caller passes nothing, we default to "unbounded at this layer" — the
// scheduler's global concurrency budget
// (config.schedulerGlobalConcurrentTestCases) and the cluster's actual
// worker / browser capacity remain the real ceiling.
export function normalizeSchedulerPolicy(requestedPolicy) {
  const requestedTenantCap = Number(requestedPolicy?.tenantConcurrencyLimit);
  const requestedWeight = Number(requestedPolicy?.tenantWeight);
  const requestedBurst = Number(requestedPolicy?.burstConcurrencyLimit);
  const requestedReserved = Number(requestedPolicy?.reservedConcurrency);

  const tenantConcurrencyLimit = Number.isFinite(requestedTenantCap) && requestedTenantCap > 0
    ? Math.max(1, Math.floor(requestedTenantCap))
    : Number.MAX_SAFE_INTEGER;
  const tenantWeight = Number.isFinite(requestedWeight) && requestedWeight > 0
    ? Math.max(1, Math.floor(requestedWeight))
    : Math.max(1, config.schedulerDefaultTenantWeight);
  const burstConcurrencyLimit = Number.isFinite(requestedBurst) && requestedBurst > 0
    ? Math.max(tenantConcurrencyLimit, Math.floor(requestedBurst))
    : tenantConcurrencyLimit;
  const reservedConcurrency = Number.isFinite(requestedReserved) && requestedReserved > 0
    ? Math.max(0, Math.floor(requestedReserved))
    : 0;

  return {
    tenantConcurrencyLimit,
    tenantWeight,
    burstConcurrencyLimit,
    reservedConcurrency,
  };
}

export function computePlatformRunAllocation({ tenantPolicy, queueableTestCases, maxJobTestCases }) {
  const normalized = normalizeSchedulerPolicy(tenantPolicy);
  const requestedCapacity = Math.max(1, queueableTestCases);
  return Math.max(
    maxJobTestCases,
    Math.min(Math.max(normalized.tenantConcurrencyLimit, normalized.burstConcurrencyLimit), requestedCapacity)
  );
}
