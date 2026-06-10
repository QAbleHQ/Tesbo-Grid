import express from "express";
import { config, validateQueueRoutingOrThrow } from "./config.js";
import { logInfo } from "./logger.js";
import { startQueueWorkers, getActiveJobs } from "./queueRuntime.js";

// Fail fast if the deployment subscribed this pod to a queue it can't run.
validateQueueRoutingOrThrow();

const app = express();
const startedAt = Date.now();

app.get("/health", (_req, res) => {
  const now = Date.now();
  const active = getActiveJobs();
  const jobTimeoutMs = config.queueJobTimeoutMs;
  let hasStuckJobs = false;
  const activeJobSummary = [];

  for (const [jobId, info] of active) {
    const elapsed = now - info.startedAt;
    const stuck = jobTimeoutMs > 0 && elapsed > jobTimeoutMs + 30000;
    if (stuck) hasStuckJobs = true;
    activeJobSummary.push({ jobId, elapsedMs: elapsed, stuck, queueName: info.queueName || null });
  }

  const status = hasStuckJobs ? "degraded" : "ok";
  const httpCode = hasStuckJobs ? 503 : 200;

  res.status(httpCode).json({
    status,
    service: "tesbo-execution-worker",
    workerId: config.workerId,
    uptimeMs: now - startedAt,
    concurrency: config.queueConcurrency,
    activeJobs: activeJobSummary.length,
    activeJobDetails: activeJobSummary,
  });
});

app.listen(config.port, () => {
  startQueueWorkers();
  logInfo("execution_worker_started", {
    port: config.port,
    workerId: config.workerId,
    concurrency: config.queueConcurrency,
    jobTimeoutMs: config.queueJobTimeoutMs,
    queueNames: config.queueNames,
  });
});
