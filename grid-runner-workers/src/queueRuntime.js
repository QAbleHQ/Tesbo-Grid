import { Worker } from "bullmq";
import IORedis from "ioredis";
import { config } from "./config.js";
import { logError, logInfo, logWarn } from "./logger.js";
import { runExecutionWithProvider } from "./providers/index.js";
import { uploadArtifactsIfConfigured } from "./artifactStorage.js";

const cancelledRuns = new Map();
let connectionRef = null;

const activeJobs = new Map();

export function getActiveJobs() {
  return activeJobs;
}

function callbackHeaders() {
  const headers = { "Content-Type": "application/json" };
  if (config.executionApiSharedToken) {
    headers["x-agent-token"] = config.executionApiSharedToken;
  }
  return headers;
}

async function notifyExecutionApi(path, payload) {
  const response = await fetch(`${config.executionApiBaseUrl}${path}`, {
    method: "POST",
    headers: callbackHeaders(),
    body: JSON.stringify(payload ?? {}),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`callback failed (${response.status}): ${body}`);
  }
}

function rememberCancelledRun(runId) {
  cancelledRuns.set(String(runId), Date.now());
}

function isCancelledRun(runId) {
  const key = String(runId);
  const at = cancelledRuns.get(key);
  if (!at) return false;
  const ttlMs = 60 * 60 * 1000;
  if (Date.now() - at > ttlMs) {
    cancelledRuns.delete(key);
    return false;
  }
  return true;
}

function startHeartbeatLoop(jobId, timeoutMs) {
  const intervalMs = Math.max(1000, Number(config.queueHeartbeatMs || 5000));
  const startedAt = Date.now();
  let timedOut = false;

  const timer = setInterval(() => {
    const elapsed = Date.now() - startedAt;
    if (timeoutMs > 0 && elapsed > timeoutMs) {
      if (!timedOut) {
        timedOut = true;
        logWarn("heartbeat_timeout_exceeded", { jobId, elapsedMs: elapsed, timeoutMs });
      }
      return;
    }

    void notifyExecutionApi(`/api/internal/execution/jobs/${jobId}/heartbeat`, {
      workerId: config.workerId,
    }).catch((error) => {
      logError("heartbeat_failed", {
        jobId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }, intervalMs);
  if (typeof timer.unref === "function") timer.unref();
  return () => clearInterval(timer);
}

function withTimeout(promise, timeoutMs, jobId) {
  if (!timeoutMs || timeoutMs <= 0) return promise;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Job ${jobId} timed out after ${Math.round(timeoutMs / 1000)}s (limit: ${Math.round(timeoutMs / 1000)}s)`));
    }, timeoutMs);
    if (typeof timer.unref === "function") timer.unref();
    promise.then(
      (val) => { clearTimeout(timer); resolve(val); },
      (err) => { clearTimeout(timer); reject(err); }
    );
  });
}

const workerRefs = new Map();

export function startQueueWorkers() {
  if (!connectionRef) {
    connectionRef = new IORedis(config.redisUrl, { maxRetriesPerRequest: null });
  }

  const jobTimeoutMs = Math.max(0, config.queueJobTimeoutMs);
  const queueNames = Array.isArray(config.queueNames) && config.queueNames.length > 0
    ? config.queueNames
    : [config.queueName];

  for (const queueName of queueNames) {
    if (workerRefs.has(queueName)) continue;

    const worker = new Worker(
      queueName,
      async (job) => {
        const data = job.data || {};
        const attempt = Number(job.attemptsMade ?? 0);
        const runId = String(data.runId || "");
        const jobId = String(data.jobId || "");
        if (!jobId) throw new Error("jobId missing in queue payload");

        if (isCancelledRun(runId)) {
          await notifyExecutionApi(`/api/internal/execution/jobs/${jobId}/fail`, {
            errorMessage: "Run cancelled",
            willRetry: false,
            attempt,
          });
          return { status: "cancelled" };
        }

        await notifyExecutionApi(`/api/internal/execution/jobs/${jobId}/start`, {
          workerId: config.workerId,
          attempt,
        });

        activeJobs.set(jobId, { startedAt: Date.now(), runId, attempt, queueName });
        const stopHeartbeat = startHeartbeatLoop(jobId, jobTimeoutMs);
        try {
          const startedAt = new Date().toISOString();

          const rawResult = await withTimeout(
            runExecutionWithProvider(data),
            jobTimeoutMs,
            jobId
          );

          const result = await uploadArtifactsIfConfigured(runId, jobId, rawResult);
          await notifyExecutionApi(`/api/internal/execution/jobs/${jobId}/complete`, {
            status: result?.status || "failed",
            startedAt,
            errorMessage: result?.errorMessage || null,
            logs: Array.isArray(result?.logs) ? result.logs : [],
            videoPath: result?.videoPath || null,
            screenshotPath: result?.screenshotPath || null,
            tracePath: result?.tracePath || null,
            attempt,
          });
          return { status: result?.status || "failed" };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const willRetry = attempt + 1 < Number(job.opts.attempts || 1);
          await notifyExecutionApi(`/api/internal/execution/jobs/${jobId}/fail`, {
            errorMessage: message,
            willRetry,
            attempt,
          }).catch((cbErr) => {
            logError("fail_callback_error", { jobId, error: cbErr.message, queueName });
          });
          throw error;
        } finally {
          stopHeartbeat();
          activeJobs.delete(jobId);
        }
      },
      {
        connection: connectionRef,
        prefix: config.queuePrefix,
        concurrency: Math.max(1, config.queueConcurrency),
        lockDuration: Math.max(30000, jobTimeoutMs + 60000),
      }
    );

    worker.on("failed", (job, err) => {
      logError("job_failed", {
        jobId: job?.id,
        attemptsMade: job?.attemptsMade,
        error: err?.message || String(err),
        queueName,
      });
    });

    worker.on("completed", (job) => {
      logInfo("job_completed", { jobId: job?.id, attemptsMade: job?.attemptsMade, queueName });
    });

    workerRefs.set(queueName, worker);
  }

  logInfo("worker_started", {
    queueNames,
    workerId: config.workerId,
    concurrency: config.queueConcurrency,
    jobTimeoutMs,
  });
  return Array.from(workerRefs.values());
}
