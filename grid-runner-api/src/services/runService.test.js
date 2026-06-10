import test from "node:test";
import assert from "node:assert/strict";
import {
  assignShards,
  formatRun,
  normalizeSchedulerPolicy,
  computePlatformRunAllocation,
} from "./runService.js";

// ── assignShards ─────────────────────────────────────────────────────────────

test("assignShards: single shard assigns all jobs to shard 1", () => {
  const jobs = [{ script: "test('a', () => {})" }, { script: "test('b', () => {})" }];
  const result = assignShards(jobs, 1);
  assert.equal(result.get(0), 1);
  assert.equal(result.get(1), 1);
});

test("assignShards: distributes script jobs round-robin across shards", () => {
  const makeJob = () => ({ script: "test('x', async ({ page }) => { await page.goto('https://example.com'); });" });
  const jobs = [makeJob(), makeJob(), makeJob(), makeJob()];
  const result = assignShards(jobs, 2);
  const shardCounts = [0, 0];
  for (const [, shard] of result) {
    shardCounts[shard - 1] += 1;
  }
  assert.equal(shardCounts[0] + shardCounts[1], 4);
  assert.ok(Math.abs(shardCounts[0] - shardCounts[1]) <= 1, "shards should be balanced");
});

test("assignShards: non-queueable jobs (no script, no bundle) are omitted from the map", () => {
  const jobs = [{ title: "manual only" }];
  const result = assignShards(jobs, 2);
  assert.equal(result.size, 0);
});

test("assignShards: shardTotal of 0 behaves like 1 (all jobs map to shard 1)", () => {
  const jobs = [{ script: "test('a', async ({ page }) => { await page.goto('/'); });" }];
  const result = assignShards(jobs, 0);
  assert.equal(result.get(0), 1);
});

// ── formatRun ─────────────────────────────────────────────────────────────────

const baseRow = {
  id: "run-1",
  external_ref: "ref-abc",
  project_id: "proj-1",
  status: "running",
  total_jobs: 4,
  completed_jobs: 1,
  passed_jobs: 1,
  failed_jobs: 0,
  cancelled_jobs: 0,
  queued_jobs: 3,
  total_test_cases: 4,
  queued_test_cases: 3,
  completed_test_cases: 1,
  passed_test_cases: 1,
  failed_test_cases: 0,
  cancelled_test_cases: 0,
  max_parallel: 2,
  execution_provider: "default",
  error_message: null,
  started_at: new Date("2025-01-01T10:00:00Z"),
  ended_at: null,
  first_job_started_at: new Date("2025-01-01T10:00:05Z"),
  metadata_json: {},
};

test("formatRun: maps DB row fields to camelCase output", () => {
  const run = formatRun(baseRow);
  assert.equal(run.runId, "run-1");
  assert.equal(run.externalRef, "ref-abc");
  assert.equal(run.projectId, "proj-1");
  assert.equal(run.status, "running");
  assert.equal(run.totalJobs, 4);
  assert.equal(run.passedJobs, 1);
  assert.equal(run.maxParallel, 2);
  assert.equal(run.executionProvider, "default");
});

test("formatRun: computes runningTestCases correctly", () => {
  const run = formatRun(baseRow);
  assert.equal(run.runningTestCases, Math.max(0, 4 - 3 - 1));
});

test("formatRun: ISO-formats timestamps", () => {
  const run = formatRun(baseRow);
  assert.equal(run.startedAt, "2025-01-01T10:00:00.000Z");
  assert.equal(run.firstJobStartedAt, "2025-01-01T10:00:05.000Z");
  assert.equal(run.endedAt, null);
});

test("formatRun: sets schedulerReason when queued work exists", () => {
  const run = formatRun({ ...baseRow, queued_jobs: 3 });
  assert.equal(run.schedulerReason, "waiting_for_scheduler_capacity");
});

test("formatRun: schedulerReason is null when no queued work remains", () => {
  const run = formatRun({ ...baseRow, queued_jobs: 0, metadata_json: {} });
  assert.equal(run.schedulerReason, null);
});

test("formatRun: surfaces tesbo ingestion fields from metadata", () => {
  const row = {
    ...baseRow,
    metadata_json: {
      tesboIngestion: {
        status: "completed",
        runId: "tesbo-run-99",
        runUrl: "https://tesbo.io/runs/99",
        error: null,
      },
    },
  };
  const run = formatRun(row);
  assert.equal(run.tesboIngestionStatus, "completed");
  assert.equal(run.tesboRunId, "tesbo-run-99");
  assert.equal(run.tesboRunUrl, "https://tesbo.io/runs/99");
  assert.equal(run.tesboIngestionError, null);
});

test("formatRun: handles missing metadata gracefully", () => {
  const run = formatRun({ ...baseRow, queued_jobs: 0, metadata_json: null });
  assert.equal(run.tesboIngestionStatus, null);
  assert.equal(run.schedulerReason, null);
});

// ── normalizeSchedulerPolicy ──────────────────────────────────────────────────

test("normalizeSchedulerPolicy: clamps tenantConcurrencyLimit to at least 1", () => {
  const result = normalizeSchedulerPolicy({ tenantConcurrencyLimit: 0 });
  assert.ok(result.tenantConcurrencyLimit >= 1);
});

test("normalizeSchedulerPolicy: uses provided tenantConcurrencyLimit when positive", () => {
  const result = normalizeSchedulerPolicy({ tenantConcurrencyLimit: 5 });
  assert.equal(result.tenantConcurrencyLimit, 5);
});

test("normalizeSchedulerPolicy: burstConcurrencyLimit is at least tenantConcurrencyLimit", () => {
  const result = normalizeSchedulerPolicy({ tenantConcurrencyLimit: 10, burstConcurrencyLimit: 3 });
  assert.ok(result.burstConcurrencyLimit >= result.tenantConcurrencyLimit);
});

test("normalizeSchedulerPolicy: burstConcurrencyLimit equals tenantConcurrencyLimit when not specified", () => {
  const result = normalizeSchedulerPolicy({ tenantConcurrencyLimit: 8 });
  assert.equal(result.burstConcurrencyLimit, 8);
});

test("normalizeSchedulerPolicy: reservedConcurrency defaults to 0", () => {
  const result = normalizeSchedulerPolicy({});
  assert.equal(result.reservedConcurrency, 0);
});

test("normalizeSchedulerPolicy: reservedConcurrency respects positive integer input", () => {
  const result = normalizeSchedulerPolicy({ reservedConcurrency: 4 });
  assert.equal(result.reservedConcurrency, 4);
});

test("normalizeSchedulerPolicy: tenantWeight defaults to at least 1", () => {
  const result = normalizeSchedulerPolicy({});
  assert.ok(result.tenantWeight >= 1);
});

test("normalizeSchedulerPolicy: handles null/undefined input", () => {
  const result = normalizeSchedulerPolicy(null);
  assert.ok(result.tenantConcurrencyLimit >= 1);
  assert.ok(result.tenantWeight >= 1);
  assert.equal(result.reservedConcurrency, 0);
});

// ── computePlatformRunAllocation ─────────────────────────────────────────────

test("computePlatformRunAllocation: allocation is at least maxJobTestCases", () => {
  const result = computePlatformRunAllocation({
    tenantPolicy: { tenantConcurrencyLimit: 2, burstConcurrencyLimit: 2 },
    queueableTestCases: 1,
    maxJobTestCases: 5,
  });
  assert.ok(result >= 5);
});

test("computePlatformRunAllocation: allocation does not exceed burst limit when fewer test cases", () => {
  const result = computePlatformRunAllocation({
    tenantPolicy: { tenantConcurrencyLimit: 10, burstConcurrencyLimit: 10 },
    queueableTestCases: 3,
    maxJobTestCases: 1,
  });
  assert.equal(result, 3);
});

test("computePlatformRunAllocation: treats zero queueableTestCases as 1", () => {
  const result = computePlatformRunAllocation({
    tenantPolicy: { tenantConcurrencyLimit: 10, burstConcurrencyLimit: 10 },
    queueableTestCases: 0,
    maxJobTestCases: 1,
  });
  assert.ok(result >= 1);
});
