import { Router } from "express";
import * as jobService from "../services/jobService.js";
import * as reportService from "../services/reportService.js";
import { dispatchAvailableSlots } from "../services/dispatchService.js";
import { emitJobWebhook, emitWebhook } from "../services/webhookService.js";
import { triggerTesboIngestion, triggerTesboIngestionStart, triggerTesboIngestionForJob } from "../services/tesboIngestionService.js";
import { logError } from "../logger.js";
import { query } from "../db/database.js";

const router = Router();

router.post("/jobs/:jobId/start", async (req, res) => {
  try {
    const { jobId } = req.params;
    const { workerId, attempt } = req.body || {};
    await jobService.markJobStarted(jobId, workerId, attempt);
    const runId = await jobService.getJobRunId(jobId);
    emitJobWebhook(runId, jobId, "job.started", { workerId, attempt }).catch(() => {});
    triggerTesboIngestionStart(runId).catch((err) =>
      logError("tesbo_ingestion_start_trigger_failed", { runId, error: err.message })
    );
    res.status(204).end();
  } catch (err) {
    logError("callback_start_error", { jobId: req.params.jobId, error: err.message });
    res.status(500).json({ error: "Internal error" });
  }
});

router.post("/jobs/:jobId/heartbeat", async (req, res) => {
  try {
    const { jobId } = req.params;
    const { workerId } = req.body || {};
    await jobService.heartbeat(jobId, workerId);
    res.status(204).end();
  } catch (err) {
    logError("callback_heartbeat_error", { jobId: req.params.jobId, error: err.message });
    res.status(500).json({ error: "Internal error" });
  }
});

router.post("/jobs/:jobId/complete", async (req, res) => {
  try {
    const { jobId } = req.params;
    const body = req.body || {};
    const ok = body.status === "passed";

    const job = await jobService.getJob(jobId);
    if (!job) return res.status(404).json({ error: "Job not found" });

    let newRunStatus;
    if (ok) {
      newRunStatus = await jobService.markJobCompleted(jobId);
    } else {
      newRunStatus = await jobService.markJobFailed(jobId, body.errorMessage, false, body.attempt);
    }

    await reportService.upsertReport(job.runId, jobId, {
      status: ok ? "passed" : "failed",
      startedAt: body.startedAt || null,
      endedAt: new Date().toISOString(),
      logs: Array.isArray(body.logs) ? body.logs : [],
      videoPath: body.videoPath || null,
      screenshotPath: body.screenshotPath || null,
      tracePath: body.tracePath || null,
      errorMessage: ok ? null : body.errorMessage,
    }).catch((err) => logError("report_upsert_failed", { jobId, error: err.message }));

    const projectId = await getProjectIdForRun(job.runId);
    if (projectId) {
      dispatchAvailableSlots(projectId).catch((err) =>
        logError("dispatch_after_complete_failed", { error: err.message })
      );
    }

    emitJobWebhook(job.runId, jobId, ok ? "job.completed" : "job.failed", {
      externalJobRef: job.externalRef,
      status: ok ? "passed" : "failed",
      errorMessage: body.errorMessage || null,
      logs: Array.isArray(body.logs) ? body.logs : [],
      videoPath: body.videoPath || null,
      screenshotPath: body.screenshotPath || null,
      tracePath: body.tracePath || null,
      startedAt: body.startedAt || null,
      attempt: body.attempt,
    }).catch(() => {});

    triggerTesboIngestionForJob(job.runId, jobId).catch((err) =>
      logError("tesbo_job_ingestion_trigger_failed", { runId: job.runId, jobId, error: err.message })
    );

    if (newRunStatus && newRunStatus !== "running") {
      const runEvent = newRunStatus === "completed" ? "run.completed" : "run.failed";
      emitWebhook(job.runId, runEvent, {}).catch(() => {});
      triggerTesboIngestion(job.runId).catch((err) =>
        logError("tesbo_ingestion_trigger_failed", { runId: job.runId, error: err.message })
      );
    }

    res.status(204).end();
  } catch (err) {
    logError("callback_complete_error", { jobId: req.params.jobId, error: err.message });
    res.status(500).json({ error: "Internal error" });
  }
});

router.post("/jobs/:jobId/fail", async (req, res) => {
  try {
    const { jobId } = req.params;
    const body = req.body || {};
    const message = body.errorMessage || "Worker failure";

    const newRunStatus = await jobService.markJobFailed(jobId, message, body.willRetry, body.attempt);

    if (!body.willRetry) {
      const job = await jobService.getJob(jobId);
      if (job) {
        const projectId = await getProjectIdForRun(job.runId);
        if (projectId) {
          dispatchAvailableSlots(projectId).catch((err) =>
            logError("dispatch_after_fail_failed", { error: err.message })
          );
        }
        emitJobWebhook(job.runId, jobId, "job.failed", {
          externalJobRef: job.externalRef,
          errorMessage: message,
          willRetry: false,
          attempt: body.attempt,
        }).catch(() => {});

        triggerTesboIngestionForJob(job.runId, jobId).catch((err) =>
          logError("tesbo_job_ingestion_trigger_failed", { runId: job.runId, jobId, error: err.message })
        );

        if (newRunStatus && newRunStatus !== "running") {
          const runEvent = newRunStatus === "completed" ? "run.completed" : "run.failed";
          emitWebhook(job.runId, runEvent, {}).catch(() => {});
          triggerTesboIngestion(job.runId).catch((err) =>
            logError("tesbo_ingestion_trigger_failed", { runId: job.runId, error: err.message })
          );
        }
      }
    }

    res.status(204).end();
  } catch (err) {
    logError("callback_fail_error", { jobId: req.params.jobId, error: err.message });
    res.status(500).json({ error: "Internal error" });
  }
});

async function getProjectIdForRun(runId) {
  const { rows } = await query("SELECT project_id FROM execution_runs WHERE id = $1", [runId]);
  return rows.length ? rows[0].project_id : null;
}

export default router;
