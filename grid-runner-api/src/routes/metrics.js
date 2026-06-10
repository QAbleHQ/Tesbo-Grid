import { Router } from "express";
import client from "prom-client";
import { currentMetrics, autoscaleRecommendation, startupLagSnapshot } from "../services/metricsService.js";

const router = Router();
const registry = new client.Registry();

const gauges = {
  queuedJobs: new client.Gauge({
    name: "tesbo_execution_queued_jobs",
    help: "Queued execution jobs.",
    registers: [registry],
  }),
  runningJobs: new client.Gauge({
    name: "tesbo_execution_running_jobs",
    help: "Running execution jobs.",
    registers: [registry],
  }),
  queuedTestCases: new client.Gauge({
    name: "tesbo_execution_queued_test_cases",
    help: "Queued execution test cases.",
    registers: [registry],
  }),
  runningTestCases: new client.Gauge({
    name: "tesbo_execution_running_test_cases",
    help: "Running execution test cases.",
    registers: [registry],
  }),
  pendingDispatchJobs: new client.Gauge({
    name: "tesbo_execution_pending_dispatch_jobs",
    help: "Queued jobs that have not yet been dispatched to BullMQ.",
    registers: [registry],
  }),
  pendingDispatchTestCases: new client.Gauge({
    name: "tesbo_execution_pending_dispatch_test_cases",
    help: "Queued test cases that have not yet been dispatched to BullMQ.",
    registers: [registry],
  }),
  activeRuns: new client.Gauge({
    name: "tesbo_execution_active_runs",
    help: "Active execution runs.",
    registers: [registry],
  }),
  desiredWorkers: new client.Gauge({
    name: "tesbo_execution_desired_workers",
    help: "Recommended worker replicas from scheduler pressure.",
    registers: [registry],
  }),
  scalerPressure: new client.Gauge({
    name: "tesbo_execution_scaler_pressure",
    help: "Testcase-based scaling pressure consumed by KEDA.",
    registers: [registry],
  }),
  waitingRuns: new client.Gauge({
    name: "tesbo_execution_waiting_runs",
    help: "Runs still waiting for their first job start.",
    registers: [registry],
  }),
  oldestWaitingRunAgeSeconds: new client.Gauge({
    name: "tesbo_execution_oldest_waiting_run_age_seconds",
    help: "Age in seconds of the oldest run still waiting for its first job start.",
    registers: [registry],
  }),
};

router.get("/", async (_req, res) => {
  try {
    const [snapshot, recommendation, startupLag] = await Promise.all([
      currentMetrics(),
      autoscaleRecommendation(),
      startupLagSnapshot(),
    ]);

    gauges.queuedJobs.set(Number(snapshot.queued_jobs || 0));
    gauges.runningJobs.set(Number(snapshot.running_jobs || 0));
    gauges.queuedTestCases.set(Number(snapshot.queued_test_cases || 0));
    gauges.runningTestCases.set(Number(snapshot.running_test_cases || 0));
    gauges.pendingDispatchJobs.set(Number(recommendation.pendingDispatchJobs || 0));
    gauges.pendingDispatchTestCases.set(Number(recommendation.pendingDispatchTestCases || 0));
    gauges.activeRuns.set(Number(snapshot.running_runs || snapshot.activeRuns || 0));
    gauges.desiredWorkers.set(Number(recommendation.desiredWorkers || 0));
    gauges.scalerPressure.set(Number(recommendation.scalerPressure || 0));
    gauges.waitingRuns.set(Number(startupLag.waiting_runs || 0));
    gauges.oldestWaitingRunAgeSeconds.set(Number(startupLag.oldest_waiting_run_age_seconds || 0));

    res.set("Content-Type", registry.contentType);
    res.end(await registry.metrics());
  } catch (err) {
    res.status(500).json({ error: err.message || "Failed to gather metrics" });
  }
});

export default router;
