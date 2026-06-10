#!/usr/bin/env node
/**
 * Clear all jobs from the BullMQ execution-jobs queue.
 *
 * Usage:
 *   REDIS_URL="rediss://<USERNAME>:<PASSWORD>@<HOST>:<PORT>" node scripts/clear-queue.mjs
 *   REDIS_URL="..." node scripts/clear-queue.mjs --force   # skip confirmation
 *
 * Env vars (all optional, shown with defaults):
 *   REDIS_URL          redis://localhost:6379
 *   QUEUE_NAME         execution-jobs
 *   QUEUE_PREFIX       bull
 */

import { Queue } from "bullmq";
import IORedis from "ioredis";
import readline from "node:readline";

const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";
const QUEUE_NAME = process.env.QUEUE_NAME || "execution-jobs";
const QUEUE_PREFIX = process.env.QUEUE_PREFIX || "bull";
const FORCE = process.argv.includes("--force");

function log(msg) {
  console.log(`[clear-queue] ${msg}`);
}

async function confirm(prompt) {
  if (FORCE) return true;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(`${prompt} (y/N): `, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === "y");
    });
  });
}

async function printStats(queue, label) {
  const counts = await queue.getJobCounts(
    "waiting", "active", "completed", "failed", "delayed", "paused", "prioritized"
  );
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  console.log(`\n── ${label} ──`);
  console.table(counts);
  console.log(`Total: ${total}\n`);
  return counts;
}

(async () => {
  log(`Connecting to Redis: ${REDIS_URL.replace(/:\/\/.*@/, "://***@")}`);
  log(`Queue: ${QUEUE_PREFIX}:${QUEUE_NAME}`);

  const connection = new IORedis(REDIS_URL, { maxRetriesPerRequest: null });
  const queue = new Queue(QUEUE_NAME, { connection, prefix: QUEUE_PREFIX });

  const before = await printStats(queue, "BEFORE");
  const total = Object.values(before).reduce((a, b) => a + b, 0);

  if (total === 0) {
    log("Queue is already empty. Nothing to do.");
    await queue.close();
    connection.disconnect();
    process.exit(0);
  }

  const ok = await confirm(
    `⚠️  This will remove ALL ${total} jobs from the production queue. Continue?`
  );
  if (!ok) {
    log("Aborted.");
    await queue.close();
    connection.disconnect();
    process.exit(1);
  }

  log("Draining waiting + delayed jobs...");
  await queue.drain(true);   // delayed = true → also removes delayed
  await queue.drain(false);  // waiting

  log("Cleaning completed jobs...");
  await queue.clean(0, 0, "completed");

  log("Cleaning failed jobs...");
  await queue.clean(0, 0, "failed");

  log("Cleaning paused jobs...");
  await queue.clean(0, 0, "paused");

  // Active jobs can't be removed directly; attempt to mark them as failed then clean
  const activeJobs = await queue.getJobs(["active"], 0, 5000);
  if (activeJobs.length > 0) {
    log(`Found ${activeJobs.length} active job(s) — attempting to remove...`);
    let removed = 0;
    for (const job of activeJobs) {
      try {
        await job.moveToFailed(new Error("Cleared by clear-queue script"), "0", true);
        removed++;
      } catch {
        // job may have already finished
      }
    }
    await queue.clean(0, 0, "failed");
    log(`Moved ${removed} active job(s) to failed and cleaned.`);
  }

  await printStats(queue, "AFTER");

  log("Done.");
  await queue.close();
  connection.disconnect();
  process.exit(0);
})();
