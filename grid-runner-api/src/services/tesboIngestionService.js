import { Queue, Worker } from "bullmq";
import IORedis from "ioredis";
import { query } from "../db/database.js";
import { config } from "../config.js";
import { logError, logInfo } from "../logger.js";

const INGESTION_QUEUE_NAME = "tesbo-ingestion";
const INGESTION_CONCURRENCY = 3;

let ingestionQueue = null;
let ingestionWorker = null;

function getIngestionConnection() {
  return new IORedis(config.redisUrl, { maxRetriesPerRequest: null });
}

export function startIngestionWorker() {
  if (ingestionWorker) return;

  ingestionQueue = new Queue(INGESTION_QUEUE_NAME, {
    connection: getIngestionConnection(),
    prefix: config.queuePrefix,
  });

  ingestionWorker = new Worker(
    INGESTION_QUEUE_NAME,
    async (job) => {
      const { type, runId, jobId } = job.data;
      if (type === "start") {
        await doIngestionStart(runId);
      } else if (type === "job") {
        await doIngestionForJob(runId, jobId);
      } else if (type === "final") {
        await doFinalIngestion(runId);
      }
    },
    {
      connection: getIngestionConnection(),
      prefix: config.queuePrefix,
      concurrency: INGESTION_CONCURRENCY,
    },
  );

  ingestionWorker.on("failed", (job, err) => {
    logError("ingestion_worker_job_failed", {
      jobName: job?.name,
      data: job?.data,
      error: err?.message,
    });
  });

  logInfo("ingestion_worker_started", { concurrency: INGESTION_CONCURRENCY });
}

/**
 * Enqueue: create the TesboX run (idempotent — skips if already created).
 */
export async function triggerTesboIngestionStart(runId) {
  if (!ingestionQueue) return;
  await ingestionQueue.add("ingestion-start", { type: "start", runId }, {
    jobId: `start-${runId}`,
    attempts: 3,
    backoff: { type: "exponential", delay: 2000 },
    removeOnComplete: 100,
    removeOnFail: 200,
  });
}

/**
 * Enqueue: ingest a single job's test results into the TesboX run.
 */
export async function triggerTesboIngestionForJob(runId, jobId) {
  if (!ingestionQueue) return;
  await ingestionQueue.add("ingestion-job", { type: "job", runId, jobId }, {
    attempts: 3,
    backoff: { type: "exponential", delay: 2000 },
    removeOnComplete: 100,
    removeOnFail: 200,
  });
}

/**
 * Enqueue: send final run status with all test results.
 */
export async function triggerTesboIngestion(runId) {
  if (!ingestionQueue) return;
  await ingestionQueue.add("ingestion-final", { type: "final", runId }, {
    jobId: `final-${runId}`,
    delay: 5000,
    attempts: 3,
    backoff: { type: "exponential", delay: 3000 },
    removeOnComplete: 100,
    removeOnFail: 200,
  });
}

// ---------------------------------------------------------------------------
// Actual ingestion logic (processed by the worker)
// ---------------------------------------------------------------------------

async function doIngestionStart(runId) {
  const run = await getRunWithMetadata(runId);
  if (!run) return;

  const meta = run.metadata_json || {};
  const cfg = meta.tesboConfig || {};
  if (!cfg.tesboApiUrl || !cfg.tesboAccessKey || !run.project_id) return;

  const current = meta.tesboIngestion || {};
  if (current.runId) return;

  const payload = {
    payload: {
      runName: cfg.runName || `Tesbox Run ${runId}`,
      sourceType: "TESBOX_EXECUTION",
      status: "IN_PROGRESS",
      startedAt: run.started_at ? new Date(run.started_at).toISOString() : new Date().toISOString(),
      tests: [],
    },
  };

  const result = await callTesboIngest(cfg, run.project_id, payload);
  const tesboRunId = result?.runId || null;
  const tesboRunUrl = result?.runUrl || buildTesboRunUrl(cfg, run.project_id, tesboRunId);

  await setIngestionState(runId, {
    status: "in_progress",
    runId: tesboRunId,
    runUrl: tesboRunUrl,
    error: null,
    startedAt: new Date().toISOString(),
    completedAt: null,
  });
  logInfo("tesbo_ingestion_started", { runId, tesboRunId });
}

async function doIngestionForJob(runId, jobId) {
  const run = await getRunWithMetadata(runId);
  if (!run) return;

  const meta = run.metadata_json || {};
  const cfg = meta.tesboConfig || {};
  if (!cfg.tesboApiUrl || !cfg.tesboAccessKey || !run.project_id) return;

  const current = meta.tesboIngestion || {};
  if (current.status === "completed") return;

  let tesboRunId = current.runId;

  if (!tesboRunId) {
    await doIngestionStart(runId);
    const refreshed = await getRunWithMetadata(runId);
    tesboRunId = refreshed?.metadata_json?.tesboIngestion?.runId;
    if (!tesboRunId) return;
  }

  const tests = await buildTestsForJob(jobId);
  if (tests.length === 0) return;

  const payload = {
    payload: {
      runId: tesboRunId,
      status: "IN_PROGRESS",
      tests,
    },
  };

  await callTesboIngest(cfg, run.project_id, payload);
  logInfo("tesbo_job_ingested", { runId, jobId, tesboRunId, testCount: tests.length });
}

async function doFinalIngestion(runId) {
  const run = await getRunWithMetadata(runId);
  if (!run) return;

  const meta = run.metadata_json || {};
  const cfg = meta.tesboConfig || {};
  if (!cfg.tesboApiUrl || !cfg.tesboAccessKey || !run.project_id) return;

  const current = meta.tesboIngestion || {};
  if (current.status === "completed") return;

  const tesboRunId = current.runId;

  try {
    const tests = await buildTests(runId);
    const payload = {
      payload: {
        ...(tesboRunId ? { runId: tesboRunId } : {}),
        runName: cfg.runName || `Tesbox Run ${runId}`,
        sourceType: "TESBOX_EXECUTION",
        status: mapRunStatus(run.status),
        startedAt: run.started_at ? new Date(run.started_at).toISOString() : new Date().toISOString(),
        completedAt: run.ended_at ? new Date(run.ended_at).toISOString() : new Date().toISOString(),
        tests,
      },
    };

    const result = await callTesboIngest(cfg, run.project_id, payload);
    const finalRunId = result?.runId || tesboRunId;
    const tesboRunUrl = result?.runUrl || buildTesboRunUrl(cfg, run.project_id, finalRunId);

    await setIngestionState(runId, {
      status: "completed",
      runId: finalRunId,
      runUrl: tesboRunUrl,
      error: null,
      startedAt: current.startedAt || new Date().toISOString(),
      completedAt: new Date().toISOString(),
    });
    logInfo("tesbo_ingestion_completed", { runId, tesboRunId: finalRunId });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await setIngestionState(runId, {
      status: "failed",
      runId: tesboRunId,
      runUrl: current.runUrl || buildTesboRunUrl(cfg, run.project_id, tesboRunId),
      error: message,
      startedAt: current.startedAt || new Date().toISOString(),
      completedAt: new Date().toISOString(),
    });
    throw error;
  }
}

// ---------------------------------------------------------------------------
// HTTP + helpers
// ---------------------------------------------------------------------------

async function callTesboIngest(cfg, projectId, payload) {
  const endpoint = `${stripTrailingSlash(cfg.tesboApiUrl)}/api/projects/${encodeURIComponent(projectId)}/tesbo-reports/ingest/playwright`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-project-access-key": cfg.tesboAccessKey,
    },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`HTTP ${response.status}: ${body}`);
  }
  return response.json().catch(() => ({}));
}

function buildTesboRunUrl(cfg, projectId, tesboRunId) {
  if (!tesboRunId || !cfg.tesboUiUrl) return null;
  return `${stripTrailingSlash(cfg.tesboUiUrl)}/projects/${projectId}/tesbo-reports/runs/${tesboRunId}`;
}

async function getRunWithMetadata(runId) {
  const { rows } = await query(
    `SELECT id, project_id, status, started_at, ended_at, metadata_json
     FROM execution_runs WHERE id = $1`,
    [runId]
  );
  return rows.length ? rows[0] : null;
}

async function buildTestsForJob(jobId) {
  const { rows } = await query(
    `SELECT ej.id, ej.title, ej.status, ej.error_message, ej.started_at, ej.ended_at,
            er.logs, er.video_path, er.screenshot_path, er.trace_path, er.error_message AS report_error
     FROM execution_jobs ej
     LEFT JOIN execution_reports er ON er.job_id = ej.id
     WHERE ej.id = $1`,
    [jobId]
  );
  if (!rows.length) return [];
  const r = rows[0];
  const perTestCases = extractPerTestCases({
    logs: r.logs,
    fallbackSpec: r.title || "unknown.spec.ts",
    traceUrl: asNonEmptyString(r.trace_path),
    screenshotUrl: asNonEmptyString(r.screenshot_path),
    videoUrl: asNonEmptyString(r.video_path),
    fallbackStatus: mapJobStatus(r.status),
  });
  if (perTestCases.length > 0) return perTestCases;

  const startedAt = r.started_at ? new Date(r.started_at).toISOString() : null;
  const endedAt = r.ended_at ? new Date(r.ended_at).toISOString() : null;
  const specFile = extractSpecFromJobTitle(r.title) || r.title || "unknown.spec.ts";
  const testName = extractTestNameFromJobTitle(r.title) || r.title || `job-${r.id}`;
  return [{
    spec: specFile,
    name: testName,
    fullTitle: r.title || `job-${r.id}`,
    status: mapJobStatus(r.status),
    durationMs: startedAt && endedAt ? Math.max(0, Date.parse(endedAt) - Date.parse(startedAt)) : null,
    errorMessage: r.report_error || r.error_message || null,
    traceUrl: asNonEmptyString(r.trace_path),
    screenshotUrl: asNonEmptyString(r.screenshot_path),
    videoUrl: asNonEmptyString(r.video_path),
    steps: normalizeLogs(r.logs),
  }];
}

async function buildTests(runId) {
  const { rows } = await query(
    `SELECT ej.id, ej.title, ej.status, ej.error_message, ej.started_at, ej.ended_at,
            er.logs, er.video_path, er.screenshot_path, er.trace_path, er.error_message AS report_error
     FROM execution_jobs ej
     LEFT JOIN execution_reports er ON er.job_id = ej.id
     WHERE ej.run_id = $1
     ORDER BY ej.created_at ASC`,
    [runId]
  );
  const all = rows.map((r) => {
    const perTestCases = extractPerTestCases({
      logs: r.logs,
      fallbackSpec: r.title || "unknown.spec.ts",
      traceUrl: asNonEmptyString(r.trace_path),
      screenshotUrl: asNonEmptyString(r.screenshot_path),
      videoUrl: asNonEmptyString(r.video_path),
      fallbackStatus: mapJobStatus(r.status),
    });
    if (perTestCases.length > 0) return perTestCases;
    const startedAt = r.started_at ? new Date(r.started_at).toISOString() : null;
    const endedAt = r.ended_at ? new Date(r.ended_at).toISOString() : null;
    const specFile = extractSpecFromJobTitle(r.title) || r.title || "unknown.spec.ts";
    const testName = extractTestNameFromJobTitle(r.title) || r.title || `job-${r.id}`;
    return [{
      spec: specFile,
      name: testName,
      fullTitle: r.title || `job-${r.id}`,
      status: mapJobStatus(r.status),
      durationMs: startedAt && endedAt ? Math.max(0, Date.parse(endedAt) - Date.parse(startedAt)) : null,
      errorMessage: r.report_error || r.error_message || null,
      traceUrl: asNonEmptyString(r.trace_path),
      screenshotUrl: asNonEmptyString(r.screenshot_path),
      videoUrl: asNonEmptyString(r.video_path),
      steps: normalizeLogs(r.logs),
    }];
  }).flat();

  const seen = new Map();
  for (const entry of all) {
    const key = `${entry.spec || ""}::${entry.name || ""}`;
    const existing = seen.get(key);
    if (!existing || statusPriority(entry.status) > statusPriority(existing.status)) {
      seen.set(key, entry);
    }
  }
  return Array.from(seen.values());
}

// ---------------------------------------------------------------------------
// Shared utilities
// ---------------------------------------------------------------------------

function extractSpecFromJobTitle(title) {
  if (!title || typeof title !== "string") return null;
  const sep = title.indexOf(" :: ");
  if (sep < 0) return null;
  return title.slice(0, sep).trim() || null;
}

function extractTestNameFromJobTitle(title) {
  if (!title || typeof title !== "string") return null;
  const sep = title.indexOf(" :: ");
  if (sep < 0) return null;
  return title.slice(sep + 4).trim() || null;
}

function normalizeLogs(logs) {
  if (!Array.isArray(logs)) return [];
  return logs.slice(0, 200).map((entry) => ({
    description: typeof entry?.message === "string" && entry.message.trim()
      ? entry.message.trim()
      : JSON.stringify(entry),
  }));
}

function extractPerTestCases({ logs, fallbackSpec, traceUrl, screenshotUrl, videoUrl, fallbackStatus }) {
  if (!Array.isArray(logs)) return [];
  const out = [];
  for (const entry of logs) {
    if (String(entry?.kind || "") !== "test_case") continue;
    const status = normalizeTestCaseStatus(entry?.status);
    out.push({
      spec: asNonEmptyString(entry?.spec) || fallbackSpec,
      name: asNonEmptyString(entry?.name) || "Unnamed test",
      fullTitle: asNonEmptyString(entry?.fullTitle) || asNonEmptyString(entry?.name) || "Unnamed test",
      status: status || fallbackStatus || "Skipped",
      durationMs: asNullableNumber(entry?.durationMs),
      errorMessage: asNonEmptyString(entry?.errorMessage) || null,
      errorStack: asNonEmptyString(entry?.errorStack) || null,
      attempt: asNullableNumber(entry?.attempt),
      projectName: asNonEmptyString(entry?.projectName) || null,
      tags: normalizeTags(entry?.tags),
      traceUrl,
      screenshotUrl,
      videoUrl,
      steps: normalizeSteps(entry?.steps),
    });
  }
  return out;
}

function normalizeSteps(steps) {
  if (!Array.isArray(steps)) return [];
  return steps.slice(0, 200).map((step) => {
    if (typeof step === "string") return { description: step };
    if (typeof step?.description === "string" && step.description.trim()) {
      return { description: step.description.trim() };
    }
    return { description: JSON.stringify(step) };
  });
}

function normalizeTestCaseStatus(status) {
  const normalized = String(status || "").toLowerCase();
  if (normalized === "passed") return "Passed";
  if (normalized === "failed") return "Failed";
  if (normalized === "skipped") return "Skipped";
  return null;
}

function asNullableNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function normalizeTags(tags) {
  if (!Array.isArray(tags)) return [];
  return tags
    .map((tag) => (typeof tag === "string" ? tag.trim() : String(tag || "").trim()))
    .filter(Boolean)
    .slice(0, 50);
}

function asNonEmptyString(value) {
  const text = typeof value === "string" ? value.trim() : "";
  return text || null;
}

async function setIngestionState(runId, state) {
  await query(
    `UPDATE execution_runs
     SET metadata_json = jsonb_set(
       COALESCE(metadata_json, '{}'::jsonb),
       '{tesboIngestion}',
       $1::jsonb,
       true
     ),
     updated_at = now()
     WHERE id = $2`,
    [JSON.stringify(state), runId]
  );
}

function statusPriority(status) {
  if (status === "Failed") return 3;
  if (status === "Passed") return 2;
  if (status === "Skipped") return 1;
  return 0;
}

function mapRunStatus(status) {
  if (status === "failed") return "FAILED";
  if (status === "cancelled") return "CANCELLED";
  return "COMPLETED";
}

function mapJobStatus(status) {
  if (status === "passed") return "Passed";
  if (status === "failed") return "Failed";
  return "Skipped";
}

function stripTrailingSlash(s) {
  return String(s || "").replace(/\/+$/, "");
}
