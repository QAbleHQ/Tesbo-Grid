import { query } from "../db/database.js";
import { config, resolveQueueNameForRuntime } from "../config.js";
import { markJobEnqueued } from "./jobService.js";
import { getQueueRef, ensureQueue } from "./queueService.js";
import { getRunMetadata } from "./runService.js";
import { logInfo, logError } from "../logger.js";

export async function dispatchAvailableSlots(projectId) {
  if (!projectId) return;
  return dispatchAllProjectsWithPendingJobs(projectId);
}

export async function dispatchAllProjectsWithPendingJobs(preferredProjectId = null) {
  const projectStates = await listProjectsWithPendingJobs();
  if (!projectStates.length) return;

  const globalHeadroom = await getGlobalDispatchHeadroom();
  if (globalHeadroom <= 0) return;

  const orderedStates = prioritizeProjects(projectStates, preferredProjectId);
  const projectAllocations = allocateProjectHeadroom(orderedStates, globalHeadroom);
  await enforceOrganizationCap(orderedStates, projectAllocations);
  for (const state of orderedStates) {
    const allocation = projectAllocations.get(state.projectId) || 0;
    if (allocation <= 0) continue;
    await dispatchProjectAllocation(state.projectId, allocation);
  }
}

// Caps each organization's total in-flight + about-to-dispatch test cases at
// the value stored in `organizations.settings.maxConcurrentJobs`, defaulting
// to config.schedulerDefaultOrganizationConcurrentJobs (5) when no override
// exists. Projects whose organization has already hit the cap are zeroed out.
// Projects with no resolvable organization_id are left untouched — the
// existing project / global limits remain the ceiling for them.
async function enforceOrganizationCap(orderedStates, projectAllocations) {
  const byOrg = new Map();
  for (const state of orderedStates) {
    if (!state.organizationId) continue;
    if (!byOrg.has(state.organizationId)) byOrg.set(state.organizationId, []);
    byOrg.get(state.organizationId).push(state);
  }
  if (byOrg.size === 0) return;

  for (const [orgId, states] of byOrg.entries()) {
    const cap = await getOrganizationCap(orgId);
    if (!Number.isFinite(cap) || cap <= 0) continue;

    const inFlight = await countOrganizationInFlightTestCases(orgId);
    let orgHeadroom = Math.max(0, cap - inFlight);

    for (const state of states) {
      const requested = projectAllocations.get(state.projectId) || 0;
      if (requested <= 0) continue;
      const granted = Math.min(requested, orgHeadroom);
      projectAllocations.set(state.projectId, granted);
      orgHeadroom -= granted;
      if (orgHeadroom <= 0) {
        // Zero out any remaining projects in this org so we don't dispatch
        // past the cap on the next iteration.
        for (const remaining of states) {
          if (remaining === state) continue;
          if ((projectAllocations.get(remaining.projectId) || 0) > 0) {
            projectAllocations.set(remaining.projectId, 0);
          }
        }
        logInfo("dispatch_org_cap_reached", { orgId, cap, inFlight });
        break;
      }
    }
  }
}

async function dispatchProjectAllocation(projectId, allocation) {
  const batchSize = Math.max(1, config.dispatchBatchSize);
  let remainingAllocation = Math.max(0, allocation);

  for (let iteration = 0; iteration < 500; iteration++) {
    if (remainingAllocation <= 0) return;

    const candidates = await listJobsPendingDispatch(projectId, 1000);
    if (!candidates.length) return;

    const batch = await buildDispatchBatch({
      projectHeadroom: remainingAllocation,
      batchSize,
      candidates,
    });
    if (!batch.length) return;

    await flushBatch(batch);
    remainingAllocation -= batch.reduce((sum, row) => sum + row.testCaseCount, 0);
  }
}

async function listProjectsWithPendingJobs() {
  const { rows } = await query(
    `SELECT er.project_id,
            MAX(er.organization_id::text) AS organization_id,
            MIN(er.started_at) AS oldest_run_started_at,
            COUNT(*)::int AS pending_jobs,
            COALESCE(SUM(GREATEST(1, ej.test_case_count)), 0)::int AS pending_test_cases,
            MIN(GREATEST(1, ej.test_case_count))::int AS min_pending_test_case_count
     FROM execution_jobs ej
     JOIN execution_runs er ON er.id = ej.run_id
     WHERE ej.status = 'queued'
       AND ej.queue_job_id IS NULL
       AND (
         (COALESCE(ej.runtime_mode, 'script') = 'script' AND ej.script IS NOT NULL AND btrim(ej.script) <> '')
         OR (COALESCE(ej.runtime_mode, 'script') = 'project' AND COALESCE(ej.provider_payload_json->>'projectBundleGzipBase64', '') <> '')
       )
       AND er.status = 'running'
       AND er.project_id IS NOT NULL
     GROUP BY er.project_id
     ORDER BY MIN(er.started_at) ASC`
  );

  const states = await Promise.all(rows.map(async (row) => {
    const projectId = row.project_id;
    const policy = await getProjectSchedulerPolicy(projectId);
    const inFlightTestCases = await countProjectInFlightTestCases(projectId);
    return {
      projectId,
      organizationId: row.organization_id || null,
      oldestRunStartedAt: row.oldest_run_started_at,
      pendingJobs: Number(row.pending_jobs) || 0,
      pendingTestCases: Number(row.pending_test_cases) || 0,
      minPendingTestCaseCount: Math.max(1, Number(row.min_pending_test_case_count) || 1),
      inFlightTestCases,
      policy,
    };
  }));

  return states.filter((state) => state.projectId);
}

async function countOrganizationInFlightTestCases(organizationId) {
  const { rows } = await query(
    `SELECT COALESCE(SUM(GREATEST(1, ej.test_case_count)), 0)::int AS c
     FROM execution_jobs ej
     JOIN execution_runs er ON er.id = ej.run_id
     WHERE er.organization_id = $1
       AND (ej.status = 'running'
            OR (ej.status = 'queued' AND ej.queue_job_id IS NOT NULL))`,
    [organizationId]
  );
  return rows[0].c;
}

// Reads `organizations.settings.maxConcurrentJobs`. Falls back to the
// platform-wide default when the org has no override, or when the
// organizations table isn't reachable (e.g. in test environments where
// grid-backend's schema isn't loaded).
async function getOrganizationCap(organizationId) {
  try {
    const { rows } = await query(
      `SELECT (settings->>'maxConcurrentJobs')::int AS cap
       FROM organizations
       WHERE id = $1
       LIMIT 1`,
      [organizationId]
    );
    const override = rows[0]?.cap;
    if (Number.isFinite(override) && override > 0) return override;
  } catch (_err) {
    // organizations lives in grid-backend; if it's missing fall through
    // to the platform default.
  }
  return Math.max(1, config.schedulerDefaultOrganizationConcurrentJobs);
}

async function getGlobalDispatchHeadroom() {
  const inFlight = await countGlobalInFlightTestCases();
  const ceiling = Math.max(1, config.schedulerGlobalConcurrentTestCases);
  return Math.max(0, ceiling - inFlight);
}

async function getProjectSchedulerPolicy(projectId) {
  const { rows } = await query(
    `SELECT metadata_json
     FROM execution_runs
     WHERE project_id = $1
       AND status = 'running'
     ORDER BY started_at ASC`,
    [projectId]
  );

  // No env-var-driven default cap any more — see config.js. Concurrency
  // is bounded by:
  //   1. an explicit `schedulerPolicy.tenantConcurrencyLimit` set on a
  //      run by the API caller (preserved in execution_runs.metadata_json);
  //   2. config.schedulerGlobalConcurrentTestCases (cluster-wide cap);
  //   3. actual worker / browser capacity in the cluster.
  let tenantConcurrencyLimit = Number.MAX_SAFE_INTEGER;
  let tenantWeight = Math.max(1, config.schedulerDefaultTenantWeight);
  let burstConcurrencyLimit = tenantConcurrencyLimit;
  let reservedConcurrency = 0;

  for (const row of rows) {
    const scheduler = row.metadata_json?.schedulerPolicy || {};
    const maybeLimit = Number(scheduler.tenantConcurrencyLimit);
    const maybeWeight = Number(scheduler.tenantWeight);
    const maybeBurst = Number(scheduler.burstConcurrencyLimit);
    const maybeReserved = Number(scheduler.reservedConcurrency);

    if (Number.isFinite(maybeLimit) && maybeLimit > 0) {
      tenantConcurrencyLimit = Math.max(tenantConcurrencyLimit, Math.floor(maybeLimit));
    }
    if (Number.isFinite(maybeWeight) && maybeWeight > 0) {
      tenantWeight = Math.max(tenantWeight, Math.floor(maybeWeight));
    }
    if (Number.isFinite(maybeBurst) && maybeBurst > 0) {
      burstConcurrencyLimit = Math.max(burstConcurrencyLimit, Math.floor(maybeBurst));
    }
    if (Number.isFinite(maybeReserved) && maybeReserved > 0) {
      reservedConcurrency = Math.max(reservedConcurrency, Math.floor(maybeReserved));
    }
  }

  return {
    tenantConcurrencyLimit: Math.max(reservedConcurrency, tenantConcurrencyLimit),
    tenantWeight,
    burstConcurrencyLimit: Math.max(tenantConcurrencyLimit, burstConcurrencyLimit),
    reservedConcurrency,
  };
}

async function countGlobalInFlightTestCases() {
  const { rows } = await query(
    `SELECT COALESCE(SUM(GREATEST(1, ej.test_case_count)), 0)::int AS c
     FROM execution_jobs ej
     JOIN execution_runs er ON er.id = ej.run_id
     WHERE er.status = 'running'
       AND (ej.status = 'running'
            OR (ej.status = 'queued' AND ej.queue_job_id IS NOT NULL))`
  );
  return rows[0].c;
}

async function countProjectInFlightTestCases(projectId) {
  const { rows } = await query(
    `SELECT COALESCE(SUM(GREATEST(1, ej.test_case_count)), 0)::int AS c
     FROM execution_jobs ej
     JOIN execution_runs er ON er.id = ej.run_id
     WHERE er.project_id = $1
       AND (ej.status = 'running'
            OR (ej.status = 'queued' AND ej.queue_job_id IS NOT NULL))`,
    [projectId]
  );
  return rows[0].c;
}

async function countRunInFlightTestCases(runId) {
  const { rows } = await query(
    `SELECT COALESCE(SUM(GREATEST(1, test_case_count)), 0)::int AS c
     FROM execution_jobs
     WHERE run_id = $1
       AND (status = 'running'
            OR (status = 'queued' AND queue_job_id IS NOT NULL))`,
    [runId]
  );
  return rows[0].c;
}

async function listJobsPendingDispatch(projectId, limit) {
  const { rows } = await query(
    `SELECT ej.id AS job_id, ej.run_id, ej.external_ref, ej.script,
            ej.max_retries, ej.start_url, ej.execution_provider,
            ej.provider_payload_json, ej.shard_index, ej.shard_total,
            ej.language, ej.runtime_mode, ej.runtime_entrypoint, ej.runtime_config_json,
            GREATEST(1, ej.test_case_count) AS test_case_count,
            ej.created_at, er.started_at AS run_started_at,
            er.max_parallel, er.metadata_json
     FROM execution_jobs ej
     JOIN execution_runs er ON er.id = ej.run_id
     WHERE er.project_id = $1
       AND ej.status = 'queued'
       AND ej.queue_job_id IS NULL
      AND (
        (COALESCE(ej.runtime_mode, 'script') = 'script' AND ej.script IS NOT NULL AND btrim(ej.script) <> '')
        OR (COALESCE(ej.runtime_mode, 'script') = 'project' AND COALESCE(ej.provider_payload_json->>'projectBundleGzipBase64', '') <> '')
      )
       AND er.status = 'running'
     ORDER BY er.started_at ASC, ej.created_at ASC
     LIMIT $2`,
    [projectId, Math.min(2000, limit)]
  );
  return rows.map((r) => ({
    jobId: r.job_id,
    runId: r.run_id,
    externalRef: r.external_ref,
    script: r.script,
    maxRetries: r.max_retries,
    startUrl: r.start_url,
    executionProvider: r.execution_provider,
    providerPayload: parseJson(r.provider_payload_json),
    framework: parseJson(r.runtime_config_json)?.framework || "playwright",
    language: r.language || "javascript",
    runtimeMode: r.runtime_mode || "script",
    runtimeEntrypoint: r.runtime_entrypoint || "",
    runtimeConfig: parseJson(r.runtime_config_json),
    queueName: resolveQueueNameForRuntime({
      framework: parseJson(r.runtime_config_json)?.framework || "playwright",
      language: r.language || "javascript",
    }),
    shardIndex: r.shard_index,
    shardTotal: r.shard_total,
    testCaseCount: Number(r.test_case_count) || 1,
    createdAt: r.created_at,
    runStartedAt: r.run_started_at,
    effectiveRunAllocation: Math.max(1, Number(r.max_parallel) || 1),
  }));
}

function buildQueuePayload(row, runMeta) {
  return {
    jobId: row.jobId,
    projectId: runMeta?.projectId || "",
    runId: row.runId,
    externalRef: row.externalRef || "",
    script: row.script,
    startUrl: row.startUrl,
    maxRetries: row.maxRetries,
    executionProvider: row.executionProvider || "default",
    providerPayload: row.providerPayload || {},
    runtime: {
      framework: row.framework || row.runtimeConfig?.framework || "playwright",
      language: row.language || "javascript",
      executionMode: row.runtimeMode || "script",
      entrypoint: row.runtimeEntrypoint || "",
      command: row.runtimeConfig?.command || "",
      configFile: row.runtimeConfig?.configFile || "",
      browser: row.runtimeConfig?.browser || "chrome",
      testSelector: row.runtimeConfig?.testSelector || "",
    },
    shardIndex: row.shardIndex,
    shardTotal: row.shardTotal,
    testCaseCount: row.testCaseCount,
    modelProvider: runMeta?.modelProvider || "",
    modelApiKey: runMeta?.modelApiKey || "",
    model: runMeta?.model || "",
  };
}

async function buildDispatchBatch({ projectHeadroom, batchSize, candidates }) {
  const runReservations = new Map();
  const runGroups = groupCandidatesByRun(candidates);
  const runInFlightEntries = await Promise.all(
    runGroups.map(async (group) => [group.runId, await countRunInFlightTestCases(group.runId)])
  );
  const runInFlight = new Map(runInFlightEntries);
  const batch = [];
  let reservedProjectCases = 0;
  let progress = true;

  while (progress && batch.length < batchSize) {
    progress = false;
    for (const group of runGroups) {
      if (batch.length >= batchSize) break;
      if (!group.rows.length) continue;

      const row = group.rows[0];
      const reservedRunCases = runReservations.get(group.runId) || 0;
      const activeRunCases = runInFlight.get(group.runId) || 0;
      const runHeadroom = Math.max(0, row.effectiveRunAllocation - activeRunCases - reservedRunCases);
      const projectRemaining = Math.max(0, projectHeadroom - reservedProjectCases);

      if (runHeadroom <= 0 || projectRemaining <= 0) continue;

      const fitsRun = row.testCaseCount <= runHeadroom;
      const fitsProject = row.testCaseCount <= projectRemaining;
      if (!fitsRun || !fitsProject) continue;

      batch.push(row);
      group.rows.shift();
      runReservations.set(group.runId, reservedRunCases + row.testCaseCount);
      reservedProjectCases += row.testCaseCount;
      progress = true;
    }
  }

  return batch;
}

function prioritizeProjects(projectStates, preferredProjectId) {
  const ordered = [...projectStates];
  ordered.sort((left, right) => {
    if (preferredProjectId) {
      const leftPreferred = left.projectId === preferredProjectId ? 1 : 0;
      const rightPreferred = right.projectId === preferredProjectId ? 1 : 0;
      if (leftPreferred !== rightPreferred) return rightPreferred - leftPreferred;
    }

    const leftWait = Date.parse(left.oldestRunStartedAt || 0) || 0;
    const rightWait = Date.parse(right.oldestRunStartedAt || 0) || 0;
    return leftWait - rightWait;
  });
  return ordered;
}

function allocateProjectHeadroom(projectStates, globalHeadroom) {
  const allocations = new Map(projectStates.map((state) => [state.projectId, 0]));
  let remaining = Math.max(0, globalHeadroom);

  const allocateQuantum = (state, targetLimit) => {
    if (remaining <= 0) return false;
    const current = allocations.get(state.projectId) || 0;
    const quantum = state.minPendingTestCaseCount;
    const maxDispatchable = Math.min(
      state.pendingTestCases,
      Math.max(0, targetLimit - state.inFlightTestCases)
    );
    if (maxDispatchable - current < quantum || remaining < quantum) return false;
    allocations.set(state.projectId, current + quantum);
    remaining -= quantum;
    return true;
  };

  for (const state of projectStates) {
    const starterTarget = Math.min(
      state.policy.burstConcurrencyLimit,
      Math.max(
        state.policy.reservedConcurrency,
        state.inFlightTestCases === 0 ? state.minPendingTestCaseCount : 0
      ) + state.inFlightTestCases
    );
    allocateQuantum(state, starterTarget);
  }

  remaining = allocateWeightedCapacity({
    states: projectStates,
    allocations,
    remaining,
    targetSelector: (state) => state.policy.tenantConcurrencyLimit,
  });

  remaining = allocateWeightedCapacity({
    states: projectStates,
    allocations,
    remaining,
    targetSelector: (state) => state.policy.burstConcurrencyLimit,
  });

  logInfo("dispatch_global_allocation", {
    globalHeadroom,
    remainingHeadroom: remaining,
    projects: projectStates.map((state) => ({
      projectId: state.projectId,
      pendingTestCases: state.pendingTestCases,
      inFlightTestCases: state.inFlightTestCases,
      tenantConcurrencyLimit: state.policy.tenantConcurrencyLimit,
      burstConcurrencyLimit: state.policy.burstConcurrencyLimit,
      allocatedTestCases: allocations.get(state.projectId) || 0,
    })),
  });

  return allocations;
}

function allocateWeightedCapacity({ states, allocations, remaining, targetSelector }) {
  let progress = true;
  while (remaining > 0 && progress) {
    progress = false;
    for (const state of states) {
      const weight = Math.max(1, state.policy.tenantWeight || 1);
      for (let slot = 0; slot < weight; slot++) {
        const current = allocations.get(state.projectId) || 0;
        const quantum = state.minPendingTestCaseCount;
        const target = Math.max(0, targetSelector(state) - state.inFlightTestCases);
        const maxDispatchable = Math.min(state.pendingTestCases, target);
        if (maxDispatchable - current < quantum || remaining < quantum) break;
        allocations.set(state.projectId, current + quantum);
        remaining -= quantum;
        progress = true;
        if (remaining <= 0) break;
      }
      if (remaining <= 0) break;
    }
  }
  return remaining;
}

function groupCandidatesByRun(candidates) {
  const groups = [];
  const byRun = new Map();
  for (const row of candidates) {
    if (!byRun.has(row.runId)) {
      const group = { runId: row.runId, rows: [] };
      byRun.set(row.runId, group);
      groups.push(group);
    }
    byRun.get(row.runId).rows.push(row);
  }
  return groups;
}

async function flushBatch(rows) {
  const metaCache = new Map();
  async function resolveRunMeta(runId) {
    if (metaCache.has(runId)) return metaCache.get(runId);
    const meta = await getRunMetadata(runId);
    metaCache.set(runId, meta);
    return meta;
  }

  const byQueue = new Map();
  for (const row of rows) {
    const queueName = row.queueName || config.queueNameJavascript;
    if (!byQueue.has(queueName)) byQueue.set(queueName, []);
    byQueue.get(queueName).push(row);
  }

  for (const [queueName, queueRows] of byQueue.entries()) {
    const queue = getQueueRef(queueName) || ensureQueue(queueName);
    if (!queue) {
      logError("dispatch_no_queue", { message: "Queue not initialized", queueName });
      continue;
    }

    const bulkEntries = [];
    for (const row of queueRows) {
      const runMeta = await resolveRunMeta(row.runId);
      bulkEntries.push({
        name: "execution",
        data: buildQueuePayload(row, runMeta),
        opts: {
          jobId: row.jobId,
          attempts: Math.max(1, (row.maxRetries || 2) + 1),
          backoff: { type: "exponential", delay: 2000 },
          removeOnComplete: true,
          removeOnFail: false,
        },
      });
    }

    try {
      const jobs = await queue.addBulk(bulkEntries);
      const totalTestCases = queueRows.reduce((sum, row) => sum + row.testCaseCount, 0);
      logInfo("dispatch_batch_enqueued", { queueName, count: jobs.length, totalTestCases });
      for (let i = 0; i < queueRows.length; i++) {
        const qid = jobs[i] ? String(jobs[i].id) : queueRows[i].jobId;
        await markJobEnqueued(queueRows[i].jobId, qid);
      }
    } catch (err) {
      logError("dispatch_batch_failed", { queueName, error: err.message });
      for (const row of queueRows) {
        try {
          const runMeta = await resolveRunMeta(row.runId);
          const job = await queue.add("execution", buildQueuePayload(row, runMeta), {
            jobId: row.jobId,
            attempts: Math.max(1, (row.maxRetries || 2) + 1),
            backoff: { type: "exponential", delay: 2000 },
            removeOnComplete: true,
            removeOnFail: false,
          });
          await markJobEnqueued(row.jobId, String(job.id));
        } catch (innerErr) {
          logError("dispatch_single_failed", { queueName, jobId: row.jobId, error: innerErr.message });
        }
      }
    }
  }
}

export async function recoverStuckRunningJobs(staleMinutes) {
  const safeMinutes = Math.max(1, staleMinutes);
  const { rows, rowCount } = await query(
    `UPDATE execution_jobs
     SET status = 'queued',
         queue_job_id = NULL,
         error_message = COALESCE(error_message, 'Recovered from stale running state'),
         retry_count = retry_count + 1,
         updated_at = now()
     WHERE status = 'running'
       AND (last_heartbeat_at IS NULL OR last_heartbeat_at < now() - ($1 || ' minutes')::interval)
     RETURNING id`,
    [String(safeMinutes)]
  );
  if (rowCount > 0) {
    logInfo("recovered_stale_jobs", { count: rowCount, jobIds: rows.map((r) => r.id) });

    const queue = getQueueRef();
    if (queue) {
      for (const row of rows) {
        try {
          const staleJob = await queue.getJob(row.id);
          if (staleJob) await staleJob.remove().catch(() => {});
        } catch {}
      }
    }

    await recomputeAllRunningRuns();
  }

  // Fetch orphaned jobs (queued in DB but stale queue_job_id) including their language
  // so we can remove the stale BullMQ job from the correct queue before re-queuing.
  // If we skip the BullMQ removal, addBulk reuses the existing failed job (same jobId)
  // and the job never lands in the "wait" list — KEDA never sees it and workers never start.
  const orphanedSelect = await query(
    `SELECT id, queue_job_id, COALESCE(language, 'javascript') AS language, runtime_config_json
     FROM execution_jobs
     WHERE status = 'queued'
       AND queue_job_id IS NOT NULL
       AND updated_at < now() - ($1 || ' minutes')::interval`,
    [String(safeMinutes)]
  );

  if (orphanedSelect.rowCount > 0) {
    for (const row of orphanedSelect.rows) {
      try {
        const runtimeConfig = parseJson(row.runtime_config_json);
        const queueName = resolveQueueNameForRuntime({
          framework: runtimeConfig.framework || "playwright",
          language: row.language,
        });
        const q = getQueueRef(queueName) || ensureQueue(queueName);
        const staleJob = await q.getJob(row.queue_job_id);
        if (staleJob) await staleJob.remove().catch(() => {});
      } catch {}
    }

    const ids = orphanedSelect.rows.map((r) => r.id);
    await query(
      `UPDATE execution_jobs
       SET queue_job_id = NULL,
           updated_at = now()
       WHERE id = ANY($1)`,
      [ids]
    );
    logInfo("recovered_orphaned_queued_jobs", { count: orphanedSelect.rowCount });
  }

  // Cancel queued jobs whose parent run is no longer active (cancelled/completed/failed).
  // These are ghost jobs left over when a run ends without cleaning up its job records.
  const ghostResult = await query(
    `UPDATE execution_jobs ej
     SET status = 'cancelled', queue_job_id = NULL, updated_at = now()
     FROM execution_runs er
     WHERE er.id = ej.run_id
       AND ej.status = 'queued'
       AND er.status IN ('cancelled', 'completed', 'failed')
     RETURNING ej.id`
  );
  if (ghostResult.rowCount > 0) {
    logInfo("cancelled_ghost_queued_jobs", { count: ghostResult.rowCount });
  }

  return rowCount + (orphanedSelect.rowCount || 0) + (ghostResult.rowCount || 0);
}

async function recomputeAllRunningRuns() {
  const { rows } = await query("SELECT id FROM execution_runs WHERE status = 'running'");
  const { recomputeRunById } = await import("./runService.js");
  for (const row of rows) {
    await recomputeRunById(row.id);
  }
}

function parseJson(raw) {
  if (!raw) return {};
  if (typeof raw === "object") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}
