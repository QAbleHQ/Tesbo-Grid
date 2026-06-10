import { Router } from "express";
import * as runService from "../services/runService.js";
import * as reportService from "../services/reportService.js";
import { cancelQueuedJobs } from "../services/queueService.js";
import { dispatchAvailableSlots } from "../services/dispatchService.js";
import { emitWebhook } from "../services/webhookService.js";
import { triggerTesboIngestion, triggerTesboIngestionStart } from "../services/tesboIngestionService.js";
import { apiKeyAuth } from "../middleware/auth.js";
import { logError } from "../logger.js";
import { validateRuntimeJobs } from "../services/runtimeContract.js";

const router = Router();

router.post("/", apiKeyAuth("runs:write"), async (req, res) => {
  const { jobs, externalRef, projectId, executionProvider,
          providerConfig, webhookUrl, webhookSecret,
          modelProvider, modelApiKey, model,
          tesboApiUrl, tesboUiUrl, tesboAccessKey, tesboRunName } = req.body || {};

  if (!Array.isArray(jobs) || jobs.length === 0) {
    return res.status(400).json({ error: "jobs array is required and must not be empty" });
  }
  const invalidJobs = validateRuntimeJobs(jobs);
  if (invalidJobs.length > 0) {
    return res.status(400).json({
      error: "Invalid runtime configuration. Each queueable job must resolve to exactly one test case.",
      invalidJobs: invalidJobs.slice(0, 20),
    });
  }

  const effectiveProjectId = projectId || req.apiKeyProjectId || null;

  if (!effectiveProjectId) {
    return res.status(400).json({
      error: "Could not determine target project. Use a project-scoped API key, or pass projectId in the request.",
    });
  }

  if (req.authType === "tesbo_key" && projectId && req.apiKeyProjectId && projectId !== req.apiKeyProjectId) {
    return res.status(400).json({
      error: `This Tesbo access key is bound to project ${req.apiKeyProjectId}, not ${projectId}. Drop --project-id (the key already knows its project) or use the matching project.`,
    });
  }

  if (externalRef) {
    const existing = await runService.findActiveRunForExternalRef(externalRef);
    if (existing) {
      return res.status(409).json({
        error: "An execution run is already in progress for this reference.",
        existingRunId: existing,
      });
    }
  }

  // Per-project run-count and queue-depth caps were removed: they were
  // env-var-driven and unset in production, never user-controlled. Queue /
  // worker capacity is the only ceiling now. If we ever need to gate a
  // specific tenant, expose it as a per-project setting in the dashboard
  // (mirroring execute_projects.settings.maxConcurrentSessions).

  const effectiveTesboApiUrl = tesboApiUrl || req.apiKeyMetadata?.tesboConfig?.tesboApiUrl || null;
  const effectiveTesboAccessKey = tesboAccessKey || req.apiKeyMetadata?.tesboConfig?.tesboAccessKey || null;

  if (effectiveTesboApiUrl && effectiveTesboAccessKey && effectiveProjectId) {
    const preflight = await preflightTesboKey({
      tesboApiUrl: effectiveTesboApiUrl,
      tesboAccessKey: effectiveTesboAccessKey,
      projectId: effectiveProjectId,
    });
    if (!preflight.ok) {
      return res.status(400).json({
        error: preflight.error,
      });
    }
  }

  try {
    const result = await runService.createRunWithJobs({
      jobs,
      externalRef,
      projectId: effectiveProjectId,
      organizationId: req.apiKeyOrganizationId || null,
      executionProvider: executionProvider || "default",
      providerConfig: providerConfig || {},
      webhookUrl,
      webhookSecret,
      modelProvider,
      modelApiKey,
      model,
      schedulerPolicy: req.apiKeyMetadata?.schedulerPolicy || {},
      tesboConfig: {
        tesboApiUrl: effectiveTesboApiUrl,
        tesboUiUrl: tesboUiUrl || req.apiKeyMetadata?.tesboConfig?.tesboUiUrl || null,
        tesboAccessKey: effectiveTesboAccessKey,
        runName: tesboRunName || null,
      },
    });

    if (effectiveProjectId) {
      dispatchAvailableSlots(effectiveProjectId).catch((err) =>
        logError("dispatch_after_create_failed", { error: err.message })
      );
    }

    emitWebhook(result.runId, "run.started", {
      externalRef,
      totalJobs: result.totalJobs,
    }).catch(() => {});

    triggerTesboIngestionStart(result.runId).catch((err) =>
      logError("tesbo_ingestion_start_failed", { runId: result.runId, error: err.message })
    );

    res.status(202).json(result);
  } catch (err) {
    logError("create_run_failed", { error: err.message });
    res.status(500).json({ error: err.message || "Failed to create run" });
  }
});

router.post("/:runId/jobs", apiKeyAuth("runs:write"), async (req, res) => {
  const { jobs } = req.body || {};
  if (!Array.isArray(jobs) || jobs.length === 0) {
    return res.status(400).json({ error: "jobs array is required and must not be empty" });
  }
  const invalidJobs = validateRuntimeJobs(jobs);
  if (invalidJobs.length > 0) {
    return res.status(400).json({
      error: "Invalid runtime configuration. Each queueable job must resolve to exactly one test case.",
      invalidJobs: invalidJobs.slice(0, 20),
    });
  }

  const run = await runService.getRun(req.params.runId);
  if (!run) return res.status(404).json({ error: "Run not found" });
  if (run.status !== "running") {
    return res.status(409).json({ error: "Run is not accepting new jobs" });
  }

  // Per-project queue-depth cap removed — see POST / handler above.

  try {
    const result = await runService.appendJobsToRun({
      runId: req.params.runId,
      jobs,
    });

    if (run.projectId) {
      dispatchAvailableSlots(run.projectId).catch((err) =>
        logError("dispatch_after_append_failed", { error: err.message })
      );
    }

    res.status(202).json({
      ...result,
      appendedJobs: jobs.length,
    });
  } catch (err) {
    const message = err?.message || "Failed to append jobs";
    if (message === "Run not found") return res.status(404).json({ error: message });
    if (message === "Run is not accepting new jobs") return res.status(409).json({ error: message });
    logError("append_run_jobs_failed", { runId: req.params.runId, error: message });
    res.status(500).json({ error: message });
  }
});

router.get("/", apiKeyAuth("runs:read"), async (req, res) => {
  const { externalRef } = req.query;
  if (!externalRef) {
    return res.status(400).json({ error: "externalRef query parameter is required" });
  }
  const runs = await runService.findRunsByExternalRef(externalRef);
  res.json({ runs });
});

router.get("/:runId", apiKeyAuth("runs:read"), async (req, res) => {
  const run = await runService.getRun(req.params.runId);
  if (!run) return res.status(404).json({ error: "Run not found" });
  res.json(run);
});

router.get("/:runId/jobs", apiKeyAuth("runs:read"), async (req, res) => {
  const run = await runService.getRun(req.params.runId);
  if (!run) return res.status(404).json({ error: "Run not found" });
  const jobs = await runService.getRunJobs(req.params.runId);
  res.json({ jobs });
});

router.post("/:runId/cancel", apiKeyAuth("runs:write"), async (req, res) => {
  const run = await runService.getRun(req.params.runId);
  if (!run) return res.status(404).json({ error: "Run not found" });
  if (run.status !== "running") {
    return res.status(400).json({ error: "Run is not in a cancellable state" });
  }

  await runService.cancelRun(req.params.runId, "Cancelled via API");
  cancelQueuedJobs(req.params.runId).catch(() => {});
  emitWebhook(req.params.runId, "run.cancelled", { externalRef: run.externalRef }).catch(() => {});
  triggerTesboIngestion(req.params.runId).catch((err) =>
    logError("tesbo_ingestion_trigger_failed", { runId: req.params.runId, error: err.message })
  );

  res.status(204).end();
});

router.get("/:runId/jobs/:jobId/report", apiKeyAuth("runs:read"), async (req, res) => {
  const report = await reportService.getReport(req.params.jobId);
  if (!report) return res.status(404).json({ error: "Report not found" });
  res.json(report);
});

async function preflightTesboKey({ tesboApiUrl, tesboAccessKey, projectId }) {
  const baseUrl = String(tesboApiUrl).replace(/\/+$/, "");
  try {
    const res = await fetch(`${baseUrl}/api/tesbo-reports/project-by-key`, {
      headers: { "x-project-access-key": tesboAccessKey },
    });
    if (res.status === 401 || res.status === 403) {
      return { ok: false, error: "Tesbo access key was rejected by the Tesbo API. Verify the key is correct and not revoked before submitting tests." };
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      logError("tesbo_key_preflight_unexpected_status", { status: res.status, body: body.slice(0, 500) });
      return { ok: false, error: `Tesbo API returned HTTP ${res.status} during key preflight. Verify your tesboApiUrl and tesboAccessKey before submitting tests.` };
    }
    const payload = await res.json().catch(() => ({}));
    const resolvedProjectId = payload?.projectId ? String(payload.projectId) : null;
    if (!resolvedProjectId) {
      return { ok: false, error: "Tesbo access key did not resolve to any project. Verify the key before submitting tests." };
    }
    if (resolvedProjectId !== String(projectId)) {
      return {
        ok: false,
        error: `Tesbo access key is bound to project ${resolvedProjectId}, but this run targets project ${projectId}. Use the matching key, or drop --project-id to let the key resolve it.`,
      };
    }
    return { ok: true };
  } catch (err) {
    logError("tesbo_key_preflight_error", { error: err.message });
    return { ok: false, error: `Could not reach the Tesbo API (${err.message}). Test submission was blocked because ingestion would have failed.` };
  }
}

export default router;
