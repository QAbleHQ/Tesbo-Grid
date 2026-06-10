import { Queue } from "bullmq";
import IORedis from "ioredis";
import { config } from "../config.js";
import { logInfo } from "../logger.js";

let connectionRef = null;
const queueRefs = new Map();

export function ensureQueue(queueName = config.queueName) {
  if (!connectionRef) {
    connectionRef = new IORedis(config.redisUrl, { maxRetriesPerRequest: null });
  }
  if (!queueRefs.has(queueName)) {
    const queue = new Queue(queueName, {
      connection: connectionRef,
      prefix: config.queuePrefix,
    });
    queueRefs.set(queueName, queue);
    logInfo("queue_initialized", { queueName, prefix: config.queuePrefix });
  }
  return queueRefs.get(queueName);
}

export function getQueueRef(queueName = config.queueName) {
  return queueRefs.get(queueName) || null;
}

export async function getQueueStats() {
  const queueNames = config.allQueueNames || [config.queueName];
  const totals = {
    waiting: 0,
    active: 0,
    completed: 0,
    failed: 0,
    delayed: 0,
    paused: 0,
  };
  for (const queueName of queueNames) {
    const queue = ensureQueue(queueName);
    const counts = await queue.getJobCounts("waiting", "active", "completed", "failed", "delayed", "paused");
    totals.waiting += counts.waiting || 0;
    totals.active += counts.active || 0;
    totals.completed += counts.completed || 0;
    totals.failed += counts.failed || 0;
    totals.delayed += counts.delayed || 0;
    totals.paused += counts.paused || 0;
  }
  return {
    prefix: config.queuePrefix,
    queueName: config.queueName,
    queueNames,
    ...totals,
  };
}

export async function cancelQueuedJobs(runId) {
  const queueNames = config.allQueueNames || [config.queueName];
  for (const queueName of queueNames) {
    const queue = ensureQueue(queueName);
    const jobs = await queue.getJobs(["waiting", "delayed", "active"], 0, 1000);
    for (const job of jobs) {
      if (String(job.data?.runId) !== String(runId)) continue;
      if ((await job.getState()) === "active") continue;
      await job.remove();
    }
  }
}
