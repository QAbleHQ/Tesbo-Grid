import { Router } from "express";
import path from "node:path";
import crypto from "node:crypto";
import multer from "multer";
import {
  parseTestReport,
  summarizeTests,
} from "@tesbox/playwright-runner/testReportParsers";
import { query } from "../db/database.js";
import { requireAuth } from "../middleware/session.js";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { evaluateAlertsForRun } from "../alerts/evaluator.js";
import {
  isArtifactStorageConfigured,
  uploadReportArtifact,
} from "../artifactStorage.js";
import {
  clusterFailedTestsForRun,
  buildHumanFailureTitle,
  buildHumanFailureSummary,
  extractErrorType,
} from "../services/ai/rootCauseClusterer.js";
import { computeAndPersistFlakyScoresForRun } from "../services/ai/flakyScorer.js";
import { detectRegressionsForRun } from "../services/ai/regressionDetector.js";
import { computeAndPersistReleaseRiskForRun } from "../services/ai/releaseRiskScorer.js";
import { linkTestsToSeleniumSessions } from "../services/seleniumSessionLinker.js";
import { buildSeleniumSessionVideoUrl } from "../artifactStorage.js";

const router = Router();
const AI_ANALYSIS_TIMEOUT_MS = 20000;
const OPENAI_DEFAULT_MODEL = "gpt-4o-mini";
const ANTHROPIC_DEFAULT_MODEL = "claude-3-5-haiku-latest";
const AI_ANALYSIS_PROMPT_VERSION = "v2.2";
const AI_MIN_CONFIDENCE_FOR_AUTO_CATEGORY = 55;

// Multer in-memory storage for ingest-time uploads. We never persist to disk
// on the API host — files are streamed straight to Spaces (or dropped if
// Spaces is not configured). Limits are intentionally generous because TestNG
// runs can produce dozens of failure screenshots in a single suite.
const reportUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 50 * 1024 * 1024, // 50 MB per file
    files: 1000,                 // 1 report + up to ~999 artifacts
    fields: 100,
  },
});

/**
 * Wrap a `multer.fields(...)` middleware so that limit/validation errors are
 * returned as actionable 4xx JSON instead of bubbling up to the default
 * Express error handler (which would respond with an opaque 500).
 *
 * We MUST handle these explicitly — our CLI sends multipart bodies that can
 * legitimately contain hundreds of screenshots, so users hitting a limit
 * deserve a clear message, not "Internal server error".
 */
function multipartIngest(fields) {
  const middleware = reportUpload.fields(fields);
  return (req, res, next) => {
    middleware(req, res, (err) => {
      if (!err) return next();
      const isMulter = err.name === "MulterError" || err instanceof multer.MulterError;
      if (isMulter) {
        logger.warn("Multipart ingest rejected:", {
          code: err.code,
          field: err.field,
          message: err.message,
        });
        const map = {
          LIMIT_FILE_COUNT: "Too many files in upload (max 1000). Reduce screenshot/video count.",
          LIMIT_FILE_SIZE: "One of the uploaded files exceeds 50 MB.",
          LIMIT_FIELD_COUNT: "Too many form fields in upload.",
          LIMIT_UNEXPECTED_FILE: `Unexpected file field "${err.field}". Use report/screenshots/videos/traces.`,
        };
        return res.status(413).json({
          error: map[err.code] || `Upload rejected: ${err.message}`,
          code: err.code,
        });
      }
      logger.error("Multipart ingest unexpected error:", err);
      return res.status(400).json({ error: err?.message || "Invalid multipart body" });
    });
  };
}

/**
 * Authenticate ingestion requests via x-project-access-key header.
 * Falls back to session auth for frontend read requests.
 */
async function authIngestion(req, res, next) {
  const accessKey = req.header("x-project-access-key");
  if (!accessKey) return requireAuth(req, res, next);

  try {
    const result = await query(
      `SELECT id FROM execute_projects
       WHERE id = $1
       AND settings ->> 'ingestionApiKey' = $2
       AND archived_at IS NULL`,
      [req.params.projectId, accessKey]
    );
    if (result.rows.length === 0) {
      return res.status(401).json({ error: "Invalid access key" });
    }
    req.accessKeyProjectId = result.rows[0].id;
    next();
  } catch (err) {
    logger.error("Ingestion auth error:", err);
    res.status(500).json({ error: "Authentication failed" });
  }
}

// ── Validate access key (lightweight auth-only check, no DB write) ───────────

router.get("/:projectId/tesbo-reports/validate-key", authIngestion, (_req, res) => {
  res.status(200).json({ valid: true });
});

// ── Ingest playwright results ───────────────────────────────────────────────

router.post("/:projectId/tesbo-reports/ingest/playwright", authIngestion, async (req, res) => {
  try {
    const projectId = req.params.projectId;
    const p = req.body?.payload || {};

    const existingRunId = p.runId || null;
    const runName = p.runName || "Unnamed Run";
    const sourceType = p.sourceType || "TESBOX_EXECUTION";
    const status = normalizeRunStatus(p.status);
    const startedAt = p.startedAt || null;
    const completedAt = p.completedAt || null;
    const tests = Array.isArray(p.tests) ? p.tests : [];

    let runId = existingRunId;

    if (runId) {
      const existing = await query(
        "SELECT id FROM report_runs WHERE id = $1::uuid AND project_id = $2",
        [runId, projectId]
      ).catch(() => ({ rows: [] }));

      if (existing.rows.length > 0) {
        const priorRes = await query(
          `SELECT started_at, completed_at FROM report_runs WHERE id = $1`,
          [runId]
        );
        const prior = priorRes.rows[0];
        const effectiveStartedAt = startedAt || timestampToIso(prior?.started_at);
        const nextCompletedAt =
          p.completedAt != null && p.completedAt !== "" ? p.completedAt : timestampToIso(prior?.completed_at);

        await upsertTests(runId, tests);
        const counts = await recalcCounts(runId);
        const durationMs = resolveRunDurationMs({
          summedMs: counts.durationMs,
          startedAt: effectiveStartedAt,
          completedAt: nextCompletedAt,
          status,
        });

        await query(
          `UPDATE report_runs
           SET status = $1,
               completed_at = COALESCE($2::timestamptz, completed_at),
               started_at = COALESCE($3::timestamptz, started_at),
               run_name = COALESCE($4, run_name),
               total_tests = $5, passed = $6, failed = $7, skipped = $8,
               duration_ms = $9, updated_at = now()
           WHERE id = $10`,
          [
            status,
            nextCompletedAt,
            effectiveStartedAt,
            runName,
            counts.total,
            counts.passed,
            counts.failed,
            counts.skipped,
            durationMs,
            runId,
          ]
        );

        if (isRunFinalized(status)) {
          void triggerFailedTestAiAnalysis({
            runId,
            projectId,
            runStatus: status,
          });
          void evaluateAlertsForRun({ projectId, runId }).catch((err) =>
            logger.error("Alerts evaluation (update path) failed:", err)
          );
        }

        return res.json({ runId, runUrl: buildRunUrl(projectId, runId), updated: true });
      }
    }

    const result = await query(
      `INSERT INTO report_runs
         (project_id, execution_run_id, run_name, source_type, status, started_at, completed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id`,
      [projectId, existingRunId, runName, sourceType, status, startedAt, completedAt]
    );
    runId = result.rows[0].id;

    if (tests.length > 0) {
      await upsertTests(runId, tests);
      const counts = await recalcCounts(runId);
      const durationMs = resolveRunDurationMs({
        summedMs: counts.durationMs,
        startedAt,
        completedAt,
        status,
      });
      await query(
        `UPDATE report_runs
         SET total_tests = $1, passed = $2, failed = $3, skipped = $4, duration_ms = $5, updated_at = now()
         WHERE id = $6`,
        [counts.total, counts.passed, counts.failed, counts.skipped, durationMs, runId]
      );
    }

    if (isRunFinalized(status)) {
      void triggerFailedTestAiAnalysis({
        runId,
        projectId,
        runStatus: status,
      });
      void evaluateAlertsForRun({ projectId, runId }).catch((err) =>
        logger.error("Alerts evaluation (insert path) failed:", err)
      );
    }

    res.json({ runId, runUrl: buildRunUrl(projectId, runId) });
  } catch (err) {
    logger.error("Ingestion error:", err);
    res.status(500).json({ error: "Ingestion failed" });
  }
});

// ── Start a build (CLI orchestration) ───────────────────────────────────────
//
// Used by `tesbox run-build` to register a build BEFORE the user's test
// command starts running. Creates an IN_PROGRESS row in report_runs keyed
// by the caller-supplied `buildId`, so the row is visible in the dashboard
// the moment the test execution begins. The same buildId is then passed to
// /ingest/test-report when the suite finishes, which updates this same row
// with the final results.
//
// Body (application/json):
//   { buildId: string, runName?: string, sourceType?: string, startedAt?: ISO-8601 }
//
// Response: { runId, runUrl, externalRef }
router.post(
  "/:projectId/tesbo-reports/builds/start",
  authIngestion,
  async (req, res) => {
    try {
      const projectId = req.params.projectId;
      const buildId = String(req.body?.buildId || "").trim();
      if (!buildId) {
        return res.status(400).json({ error: "Missing required `buildId`" });
      }
      const externalRef = `build-${buildId}`;
      const runName = req.body?.runName || `Build ${buildId}`;
      const sourceType = req.body?.sourceType || "SELENIUM_LOCAL";
      const startedAt = req.body?.startedAt || new Date().toISOString();

      // Reuse if a row already exists for this buildId — `run-build` may be
      // re-invoked with --build-id <id> in the same CI build (e.g. a flaky
      // test rerun script) and we don't want to create duplicates.
      const existing = await query(
        "SELECT id FROM report_runs WHERE project_id = $1 AND execution_run_id = $2 LIMIT 1",
        [projectId, externalRef]
      );

      let runId;
      if (existing.rows.length > 0) {
        runId = existing.rows[0].id;
      } else {
        const inserted = await query(
          `INSERT INTO report_runs
             (project_id, execution_run_id, run_name, source_type, status, started_at)
           VALUES ($1, $2, $3, $4, 'IN_PROGRESS', $5)
           RETURNING id`,
          [projectId, externalRef, runName, sourceType, startedAt]
        );
        runId = inserted.rows[0].id;
      }

      res.json({
        runId,
        runUrl: buildRunUrl(projectId, runId),
        externalRef,
        buildId,
      });
    } catch (err) {
      logger.error("builds/start error:", err);
      res.status(500).json({ error: "Failed to start build" });
    }
  }
);

// ── Ingest test report (TestNG / JUnit / pytest) ────────────────────────────
//
// Multipart endpoint used by `tesbox upload-results` and the final step of
// `tesbox run-build`. Accepts a raw report file (testng-results.xml, junit
// XML, or pytest report.json) plus optional screenshot/video/trace artifacts.
//
// Form fields:
//   report      — required file part containing the report
//   screenshots — repeatable file part (matched to tests by basename)
//   format      — optional hint: "testng" | "junit" | "pytest" (auto-detected otherwise)
//   runName     — optional friendly name for the run row
//   sourceType  — optional source label (default: SELENIUM_LOCAL)
//   buildId     — optional CLI-orchestrated build id; takes precedence over the
//                 XML-derived hash so the upload always resolves to the row
//                 created by /builds/start with the same buildId
//   runId       — optional existing run id to append/update
//   startedAt   — ISO-8601, optional
//   completedAt — ISO-8601, optional
//
// The endpoint streams attachments to Spaces, links them to test rows via
// best-effort filename matching, and returns the dashboard URL so the CLI can
// print a clickable link.
router.post(
  "/:projectId/tesbo-reports/ingest/test-report",
  authIngestion,
  multipartIngest([
    { name: "report", maxCount: 1 },
    { name: "screenshots", maxCount: 500 },
    { name: "videos", maxCount: 100 },
    { name: "traces", maxCount: 100 },
  ]),
  async (req, res) => {
    try {
      const projectId = req.params.projectId;
      const reportFile = req.files?.report?.[0];
      if (!reportFile) {
        return res.status(400).json({
          error: "Missing required `report` file part (testng-results.xml, junit XML, or pytest report.json)",
        });
      }

      const reportText = reportFile.buffer.toString("utf8");
      const { tests, format, meta } = parseTestReport(reportText, req.body?.format);
      if (!format) {
        return res.status(400).json({
          error:
            "Could not detect report format. Pass ?format=testng|junit|pytest or rename the file (e.g. testng-results.xml).",
        });
      }
      if (tests.length === 0) {
        return res.status(400).json({
          error: `Parsed 0 tests from ${format} report. Verify the file is well-formed.`,
        });
      }

      const summary = summarizeTests(tests);

      // Run name: caller override > suite name from XML > filename-based fallback.
      const runName =
        (req.body?.runName && String(req.body.runName)) ||
        meta?.suiteName ||
        defaultRunName(format, reportFile.originalname);

      const sourceType = req.body?.sourceType || `${format.toUpperCase()}_LOCAL`;

      // Timestamps: caller override > suite-level timestamps from the report.
      const startedAt = req.body?.startedAt || meta?.startedAt || null;
      const completedAt = req.body?.completedAt || meta?.completedAt || new Date().toISOString();
      const status = summary.status;

      // ── Idempotency ─────────────────────────────────────────────────────────
      // Resolve `externalRef` so re-uploading the same execution always lands
      // on the same `report_runs` row — no duplicates.
      //
      // Priority for the externalRef itself:
      //   a. Explicit buildId from CLI (`tesbox run-build`) — highest precedence
      //      so the orchestrated flow can join the upload back to the row
      //      created by /builds/start.
      //   b. Stable hash derived from suite name + started-at in the XML.
      //
      // Priority for actually finding the row:
      //   1. Explicit `runId` UUID from caller (update that specific row)
      //   2. Existing row whose `execution_run_id` matches `externalRef`
      //   3. INSERT a new row.
      const buildId = req.body?.buildId ? String(req.body.buildId).trim() : "";
      const externalRef = buildId
        ? `build-${buildId}`
        : meta?.externalRef || null;

      let runId = null;

      // 1. Explicit UUID override — honour only when the row actually exists.
      const explicitRunId = req.body?.runId || null;
      if (explicitRunId) {
        const existing = await query(
          "SELECT id FROM report_runs WHERE id = $1::uuid AND project_id = $2",
          [explicitRunId, projectId]
        ).catch(() => ({ rows: [] }));
        if (existing.rows.length > 0) runId = explicitRunId;
      }

      // 2. Stable externalRef lookup — this is the main dedup path.
      if (!runId && externalRef) {
        const existing = await query(
          "SELECT id FROM report_runs WHERE project_id = $1 AND execution_run_id = $2 LIMIT 1",
          [projectId, externalRef]
        ).catch(() => ({ rows: [] }));
        if (existing.rows.length > 0) runId = existing.rows[0].id;
      }

      // 3. Create a new run if we couldn't match an existing one.
      if (!runId) {
        const insert = await query(
          `INSERT INTO report_runs
             (project_id, execution_run_id, run_name, source_type, status, started_at, completed_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           RETURNING id`,
          [projectId, externalRef, runName, sourceType, status, startedAt, completedAt]
        );
        runId = insert.rows[0].id;
      }

      // Upload screenshot/video/trace artifacts and build a best-effort lookup
      // table keyed by basename so we can attach them to the matching test row.
      const screenshotsByName = await uploadAndIndexArtifacts({
        projectId,
        runId,
        files: req.files?.screenshots || [],
      });
      const videosByName = await uploadAndIndexArtifacts({
        projectId,
        runId,
        files: req.files?.videos || [],
      });
      const tracesByName = await uploadAndIndexArtifacts({
        projectId,
        runId,
        files: req.files?.traces || [],
      });

      // Attach uploaded artifact URLs to tests using two strategies:
      //   1. TestNG embeds <img src="..."> in <reporter-output>; match on the
      //      basename of those paths to a screenshot uploaded by the CLI.
      //   2. Otherwise fall back to fuzzy matching on test name + spec.
      const enrichedTests = tests.map((t) => {
        const screenshotUrl = pickArtifactUrl(t, screenshotsByName);
        const videoUrl = pickArtifactUrl(t, videosByName);
        const traceUrl = pickArtifactUrl(t, tracesByName);
        return {
          ...t,
          screenshotUrl,
          videoUrl,
          traceUrl,
        };
      });

      await upsertTests(runId, enrichedTests);

      // Best-effort: tie each test row to the WebDriver session that ran
      // it. Only meaningful when the CLI passed a `buildId` AND the test
      // framework set `tesbo:options` on its capabilities (or the test
      // window can be matched heuristically). Failure here is logged but
      // never blocks the upload — linking is purely additive.
      if (buildId) {
        void linkTestsToSeleniumSessions({
          query,
          projectId,
          runId,
          buildId,
          tests: enrichedTests,
          runStartedAt: startedAt,
        }).catch((err) => {
          logger.warn("session_linker_post_ingest_failed", {
            error: err instanceof Error ? err.message : String(err),
            runId,
          });
        });
      }

      const counts = await recalcCounts(runId);
      const durationMs = resolveRunDurationMs({
        summedMs: counts.durationMs,
        startedAt,
        completedAt,
        status,
      });
      await query(
        `UPDATE report_runs
         SET status = $1,
             completed_at = COALESCE($2::timestamptz, completed_at),
             started_at = COALESCE($3::timestamptz, started_at),
             run_name = COALESCE($4, run_name),
             total_tests = $5, passed = $6, failed = $7, skipped = $8,
             duration_ms = $9, updated_at = now()
         WHERE id = $10`,
        [
          status,
          completedAt,
          startedAt,
          runName,
          counts.total,
          counts.passed,
          counts.failed,
          counts.skipped,
          durationMs,
          runId,
        ]
      );

      if (isRunFinalized(status)) {
        void triggerFailedTestAiAnalysis({ runId, projectId, runStatus: status });
        void evaluateAlertsForRun({ projectId, runId }).catch((err) =>
          logger.error("Alerts evaluation (test-report ingest) failed:", err)
        );
      }

      res.json({
        runId,
        runUrl: buildRunUrl(projectId, runId),
        format,
        counts,
        artifactsUploaded:
          (req.files?.screenshots?.length || 0) +
          (req.files?.videos?.length || 0) +
          (req.files?.traces?.length || 0),
        artifactStorageConfigured: isArtifactStorageConfigured(),
      });
    } catch (err) {
      logger.error("Test report ingest error:", err);
      // Surface the underlying message so CLI users get actionable feedback
      // (e.g. "duplicate key value violates unique constraint …" instead of a
      // bare 500). The DB layer never echoes user data back, so this is safe.
      const message = err?.message || "Test report ingest failed";
      res.status(500).json({ error: `Test report ingest failed: ${message}` });
    }
  }
);

function defaultRunName(format, originalName) {
  const base = originalName ? path.basename(originalName).replace(/\.[^.]+$/, "") : "";
  const stamp = new Date().toISOString().replace("T", " ").slice(0, 19);
  if (base && base !== "report" && base !== "junit" && !base.startsWith("testng-")) {
    return `${base} — ${stamp}`;
  }
  const label = format === "pytest" ? "pytest" : format.toUpperCase();
  return `${label} run — ${stamp}`;
}

async function uploadAndIndexArtifacts({ projectId, runId, files }) {
  const index = new Map();
  for (const file of files || []) {
    const url = await uploadReportArtifact({
      projectId,
      runId,
      filename: file.originalname,
      buffer: file.buffer,
    });
    if (!url) continue;
    const baseName = path.basename(file.originalname || "");
    if (baseName) index.set(baseName.toLowerCase(), url);
    // Also index by name without extension so a screenshot called
    // "loginShouldFail_2026.png" can match the test "loginShouldFail".
    const stem = baseName.replace(/\.[^.]+$/, "");
    if (stem && stem !== baseName) index.set(stem.toLowerCase(), url);
  }
  return index;
}

function pickArtifactUrl(test, index) {
  if (!index || index.size === 0) return null;
  // 1. TestNG-style: parser already extracted <img src="..."> paths into
  //    `_screenshotPaths`. Try each basename until one matches.
  if (Array.isArray(test._screenshotPaths)) {
    for (const p of test._screenshotPaths) {
      const base = path.basename(String(p || "")).toLowerCase();
      if (base && index.has(base)) return index.get(base);
      const stem = base.replace(/\.[^.]+$/, "");
      if (stem && index.has(stem)) return index.get(stem);
    }
  }
  // 2. Fall back to matching by test name (Selenium frameworks commonly save
  //    failure screenshots as "<testName>_<timestamp>.png").
  const name = String(test.name || "").toLowerCase();
  if (name && index.has(name)) return index.get(name);
  for (const key of index.keys()) {
    if (name && key.startsWith(name + "_")) return index.get(key);
    if (name && key.startsWith(name + ".")) return index.get(key);
  }
  return null;
}

// ── List runs ───────────────────────────────────────────────────────────────

router.get("/:projectId/tesbo-reports/runs", requireAuth, async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
    const offset = (page - 1) * limit;

    const [runsResult, countResult] = await Promise.all([
      query(
        `SELECT id, execution_run_id, run_name, source_type, status,
                total_tests, passed, failed, skipped, duration_ms,
                started_at, completed_at, created_at,
                release_risk_score, release_risk_level, release_risk_breakdown, release_risk_updated_at,
                EXISTS (
                  SELECT 1
                  FROM execute_project_ai_key_allocations epa
                  JOIN workspace_ai_keys wak
                    ON wak.id = epa.workspace_ai_key_id
                   AND wak.is_active = TRUE
                  WHERE epa.execute_project_id = report_runs.project_id
                ) AS ai_analysis_enabled
         FROM report_runs
         WHERE project_id = $1
         ORDER BY created_at DESC
         LIMIT $2 OFFSET $3`,
        [req.params.projectId, limit, offset]
      ),
      query(
        "SELECT COUNT(*) AS total FROM report_runs WHERE project_id = $1",
        [req.params.projectId]
      ),
    ]);

    res.json({
      runs: runsResult.rows.map(formatRun),
      total: parseInt(countResult.rows[0].total),
      page,
      limit,
    });
  } catch (err) {
    logger.error("List runs error:", err);
    res.status(500).json({ error: "Failed to list runs" });
  }
});

// ── Get single run with tests ───────────────────────────────────────────────

router.get("/:projectId/tesbo-reports/runs/:runId", requireAuth, async (req, res) => {
  try {
    const runResult = await query(
      `SELECT id, execution_run_id, run_name, source_type, status,
              total_tests, passed, failed, skipped, duration_ms,
              started_at, completed_at, created_at,
              release_risk_score, release_risk_level, release_risk_breakdown, release_risk_updated_at,
              public_share_enabled, public_share_token,
              EXISTS (
                SELECT 1
                FROM execute_project_ai_key_allocations epa
                JOIN workspace_ai_keys wak
                  ON wak.id = epa.workspace_ai_key_id
                 AND wak.is_active = TRUE
                WHERE epa.execute_project_id = report_runs.project_id
              ) AS ai_analysis_enabled
       FROM report_runs
       WHERE id = $1 AND project_id = $2`,
      [req.params.runId, req.params.projectId]
    );
    if (runResult.rows.length === 0) {
      return res.status(404).json({ error: "Run not found" });
    }

    const testsResult = await query(
      `SELECT id, spec, name, full_title, status, duration_ms,
              error_message, error_stack, attempt, project_name,
              tags, trace_url, screenshot_url, video_url, steps, created_at,
              ai_analysis_status, ai_analysis_category, ai_analysis_summary,
              ai_analysis_confidence, ai_analysis_model, ai_analysis_updated_at,
              ai_analysis_prompt_version,
              is_probable_regression, regression_confidence,
              regression_pass_streak_before_fail, regression_first_seen_run_id, regression_hint,
              selenium_session_id, selenium_session_request_id,
              selenium_session_status, selenium_session_video_url, selenium_session_linked_at
       FROM report_tests
       WHERE report_run_id = $1
       ORDER BY spec, name`,
      [req.params.runId]
    );

    // Re-hydrate live status for every test that has a Selenium session id.
    // Cached `selenium_session_status` from ingest time may be stale (e.g.
    // ingest happens mid-run; the session keeps going then ends), so we ask
    // the runner-api once per session for the latest status. We batch by
    // de-duplicating session ids across the test list to keep the cost
    // bounded for parallel suites that share sessions.
    const sessionStatusBySelId = await refreshSeleniumSessionStatuses(
      req.params.projectId,
      testsResult.rows
    );

    res.json({
      ...formatRun(runResult.rows[0]),
      tests: testsResult.rows.map((row) =>
        formatTestWithSession(row, sessionStatusBySelId)
      ),
    });
  } catch (err) {
    logger.error("Get run error:", err);
    res.status(500).json({ error: "Failed to get run" });
  }
});

// ── Test-scoped Selenium command timeline (BFF) ─────────────────────────────
//
// The grid-selenium-proxy stores a tail of WebDriver commands per session in
// `selenium_session_commands`. The dashboard's "Live VNC" page already
// renders this for an entire session. Here we surface the same timeline
// scoped to a SINGLE test row so users can expand a failed test in the
// report and see the exact commands the driver issued before the failure —
// without leaving the run detail page.
//
// Resolves the report_test → selenium_session_id and proxies through to the
// runner-api's commands endpoint.
router.get(
  "/:projectId/tesbo-reports/runs/:runId/tests/:testId/session-commands",
  requireAuth,
  async (req, res) => {
    try {
      const { projectId, runId, testId } = req.params;

      const lookup = await query(
        `SELECT selenium_session_id
           FROM report_tests
          WHERE id = $1
            AND report_run_id = $2`,
        [testId, runId]
      );
      const seleniumId = lookup.rows[0]?.selenium_session_id || null;
      if (!seleniumId) {
        // 404 with a structured payload so the dashboard can render
        // "No session linked to this test" without a generic error toast.
        return res.status(404).json({
          error: "No Selenium session linked to this test",
          code: "SESSION_NOT_LINKED",
          commands: [],
        });
      }

      if (!config.executionApiUrl) {
        return res.json({ seleniumId, commands: [] });
      }

      const params = new URLSearchParams({ projectId });
      if (req.query.since) params.set("since", String(req.query.since));
      if (req.query.limit) params.set("limit", String(req.query.limit));
      const upstream = await fetch(
        `${config.executionApiUrl}/api/internal/selenium-sessions/${encodeURIComponent(
          seleniumId
        )}/commands?${params.toString()}`,
        {
          method: "GET",
          headers: {
            ...(config.executionApiSharedToken
              ? { "x-agent-token": config.executionApiSharedToken }
              : {}),
          },
        }
      );
      const payload = await upstream
        .json()
        .catch(() => ({ commands: [], seleniumId }));
      if (!upstream.ok) return res.status(upstream.status).json(payload);
      res.json(payload);
    } catch (err) {
      logger.error("GET test session-commands error:", err);
      res.status(502).json({ error: "Failed to load session commands" });
    }
  }
);

router.get("/:projectId/tesbo-reports/runs/:runId/clusters", requireAuth, async (req, res) => {
  try {
    // Pull a sample raw error per cluster (the most recently failing test)
    // so the frontend can render a clean preview without a second round-trip
    // for each card. We use DISTINCT ON over the per-test join, then
    // re-aggregate counts in the outer query to keep test_count accurate.
    const result = await query(
      `WITH sample_errors AS (
         SELECT DISTINCT ON (l.cluster_id)
           l.cluster_id,
           t.error_message AS sample_error_message,
           t.error_stack   AS sample_error_stack
         FROM report_test_cluster_links l
         JOIN report_tests t ON t.id = l.report_test_id
         WHERE t.report_run_id = $2
         ORDER BY l.cluster_id, t.created_at DESC NULLS LAST
       )
       SELECT
          c.id,
          c.cluster_key,
          c.title,
          c.primary_signature,
          c.category_hint,
          c.first_seen_at,
          c.last_seen_at,
          COUNT(l.report_test_id)::integer AS test_count,
          ROUND(AVG(l.match_confidence))::integer AS avg_match_confidence,
          se.sample_error_message,
          se.sample_error_stack
       FROM report_failure_clusters c
       JOIN report_test_cluster_links l ON l.cluster_id = c.id
       JOIN report_tests t ON t.id = l.report_test_id
       LEFT JOIN sample_errors se ON se.cluster_id = c.id
       WHERE c.project_id = $1
         AND t.report_run_id = $2
       GROUP BY c.id, se.sample_error_message, se.sample_error_stack
       ORDER BY test_count DESC, c.last_seen_at DESC`,
      [req.params.projectId, req.params.runId]
    );
    res.json({
      clusters: result.rows.map((row) => {
        const sampleTest = {
          error_message: row.sample_error_message,
          error_stack: row.sample_error_stack,
        };
        const friendlyTitle =
          row.title && !row.title.includes(" | ")
            ? row.title
            : buildHumanFailureTitle(sampleTest);
        const summary = buildHumanFailureSummary(sampleTest);
        const errorType =
          extractErrorType(row.sample_error_message) ||
          extractErrorType(row.sample_error_stack);
        return {
          id: row.id,
          clusterKey: row.cluster_key,
          title: friendlyTitle || "Failure cluster",
          summary,
          errorType,
          categoryHint: row.category_hint,
          firstSeenAt: row.first_seen_at,
          lastSeenAt: row.last_seen_at,
          testCount: Number(row.test_count || 0),
          avgMatchConfidence:
            row.avg_match_confidence != null ? Number(row.avg_match_confidence) : null,
        };
      }),
    });
  } catch (err) {
    logger.error("Run clusters error:", err);
    res.status(500).json({ error: "Failed to load run clusters" });
  }
});

router.get(
  "/:projectId/tesbo-reports/runs/:runId/clusters/:clusterId",
  requireAuth,
  async (req, res) => {
    try {
      const { projectId, runId, clusterId } = req.params;

      const clusterRes = await query(
        `SELECT
            c.id,
            c.cluster_key,
            c.title,
            c.primary_signature,
            c.category_hint,
            c.first_seen_at,
            c.last_seen_at,
            c.occurrence_count,
            COUNT(l.report_test_id)::integer AS test_count,
            ROUND(AVG(l.match_confidence))::integer AS avg_match_confidence
         FROM report_failure_clusters c
         JOIN report_test_cluster_links l ON l.cluster_id = c.id
         JOIN report_tests t ON t.id = l.report_test_id
         WHERE c.id = $3
           AND c.project_id = $1
           AND t.report_run_id = $2
         GROUP BY c.id`,
        [projectId, runId, clusterId]
      );

      if (clusterRes.rows.length === 0) {
        return res.status(404).json({ error: "Cluster not found" });
      }

      const testsRes = await query(
        `SELECT
            t.id,
            t.spec,
            t.name,
            t.full_title,
            t.status,
            t.duration_ms,
            t.error_message,
            t.error_stack,
            t.attempt,
            t.project_name,
            t.ai_analysis_category,
            t.ai_analysis_summary,
            l.match_confidence
         FROM report_test_cluster_links l
         JOIN report_tests t ON t.id = l.report_test_id
         WHERE l.cluster_id = $1
           AND t.report_run_id = $2
         ORDER BY t.created_at DESC NULLS LAST, t.spec, t.name`,
        [clusterId, runId]
      );

      const cluster = clusterRes.rows[0];
      const sample = testsRes.rows[0] || {};
      const friendlyTitle =
        cluster.title && !cluster.title.includes(" | ")
          ? cluster.title
          : buildHumanFailureTitle(sample);
      const summary = buildHumanFailureSummary(sample);
      const errorType =
        extractErrorType(sample.error_message) ||
        extractErrorType(sample.error_stack);

      res.json({
        id: cluster.id,
        clusterKey: cluster.cluster_key,
        title: friendlyTitle || "Failure cluster",
        summary,
        errorType,
        categoryHint: cluster.category_hint,
        firstSeenAt: cluster.first_seen_at,
        lastSeenAt: cluster.last_seen_at,
        occurrenceCount: Number(cluster.occurrence_count || 0),
        testCount: Number(cluster.test_count || 0),
        avgMatchConfidence:
          cluster.avg_match_confidence != null
            ? Number(cluster.avg_match_confidence)
            : null,
        sampleErrorMessage: sample.error_message || null,
        sampleErrorStack: sample.error_stack || null,
        tests: testsRes.rows.map((t) => ({
          id: t.id,
          spec: t.spec,
          name: t.name,
          fullTitle: t.full_title,
          status: t.status,
          durationMs: t.duration_ms,
          attempt: t.attempt,
          projectName: t.project_name,
          aiAnalysisCategory: t.ai_analysis_category,
          aiAnalysisSummary: t.ai_analysis_summary,
          matchConfidence:
            t.match_confidence != null ? Number(t.match_confidence) : null,
          errorPreview: buildHumanFailureSummary(t),
        })),
      });
    } catch (err) {
      logger.error("Run cluster detail error:", err);
      res.status(500).json({ error: "Failed to load cluster detail" });
    }
  }
);

router.get("/:projectId/tesbo-reports/runs/:runId/risk", requireAuth, async (req, res) => {
  try {
    const result = await query(
      `SELECT release_risk_score, release_risk_level, release_risk_breakdown, release_risk_updated_at
       FROM report_runs
       WHERE id = $1 AND project_id = $2`,
      [req.params.runId, req.params.projectId]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: "Run not found" });
    const row = result.rows[0];
    res.json({
      score: row.release_risk_score != null ? Number(row.release_risk_score) : null,
      level: row.release_risk_level || null,
      breakdown: row.release_risk_breakdown || null,
      updatedAt: row.release_risk_updated_at || null,
    });
  } catch (err) {
    logger.error("Run risk error:", err);
    res.status(500).json({ error: "Failed to load run risk" });
  }
});

router.get("/:projectId/tesbo-reports/flaky-tests", requireAuth, async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit) || 50));
    const offset = (page - 1) * limit;
    const minScore = Math.max(0, Math.min(100, parseInt(req.query.minScore) || 0));

    const [rows, count] = await Promise.all([
      query(
        `WITH latest AS (
           SELECT DISTINCT ON (project_id, test_identity_key)
             project_id, test_identity_key, spec, test_name, score, trend_slope, likely_reason, computed_at
           FROM report_test_flakiness_snapshots
           WHERE project_id = $1
           ORDER BY project_id, test_identity_key, computed_at DESC
         )
         SELECT *
         FROM latest
         WHERE score >= $2
         ORDER BY score DESC, computed_at DESC
         LIMIT $3 OFFSET $4`,
        [req.params.projectId, minScore, limit, offset]
      ),
      query(
        `WITH latest AS (
           SELECT DISTINCT ON (project_id, test_identity_key)
             project_id, test_identity_key, score
           FROM report_test_flakiness_snapshots
           WHERE project_id = $1
           ORDER BY project_id, test_identity_key, computed_at DESC
         )
         SELECT COUNT(*)::integer AS total
         FROM latest
         WHERE score >= $2`,
        [req.params.projectId, minScore]
      ),
    ]);

    res.json({
      tests: rows.rows.map((r) => ({
        spec: r.spec || "(unknown spec)",
        testName: r.test_name || "(unnamed test)",
        flakyScore: Number(r.score || 0),
        trendSlope: r.trend_slope != null ? Number(r.trend_slope) : null,
        likelyFlakyReason: r.likely_reason || null,
        updatedAt: r.computed_at,
      })),
      total: Number(count.rows[0]?.total || 0),
      page,
      limit,
    });
  } catch (err) {
    logger.error("Flaky tests error:", err);
    res.status(500).json({ error: "Failed to load flaky tests" });
  }
});

router.get("/:projectId/tesbo-reports/regressions", requireAuth, async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit) || 50));
    const offset = (page - 1) * limit;

    const [rows, count] = await Promise.all([
      query(
        `SELECT
           rr.id AS run_id,
           rr.run_name,
           rr.status AS run_status,
           rr.started_at,
           rr.created_at,
           rt.spec,
           COALESCE(NULLIF(rt.full_title, ''), NULLIF(rt.name, ''), '(unnamed test)') AS test_name,
           rt.regression_confidence,
           rt.regression_pass_streak_before_fail,
           rt.regression_hint
         FROM report_tests rt
         JOIN report_runs rr ON rr.id = rt.report_run_id
         WHERE rr.project_id = $1
           AND rt.is_probable_regression = TRUE
         ORDER BY COALESCE(rr.started_at, rr.created_at) DESC
         LIMIT $2 OFFSET $3`,
        [req.params.projectId, limit, offset]
      ),
      query(
        `SELECT COUNT(*)::integer AS total
         FROM report_tests rt
         JOIN report_runs rr ON rr.id = rt.report_run_id
         WHERE rr.project_id = $1
           AND rt.is_probable_regression = TRUE`,
        [req.params.projectId]
      ),
    ]);

    res.json({
      regressions: rows.rows.map((r) => ({
        runId: r.run_id,
        runName: r.run_name,
        runStatus: r.run_status,
        startedAt: r.started_at || r.created_at,
        spec: r.spec || "(unknown spec)",
        testName: r.test_name,
        confidence: r.regression_confidence != null ? Number(r.regression_confidence) : null,
        passStreakBeforeFail:
          r.regression_pass_streak_before_fail != null
            ? Number(r.regression_pass_streak_before_fail)
            : null,
        hint: r.regression_hint || null,
      })),
      total: Number(count.rows[0]?.total || 0),
      page,
      limit,
    });
  } catch (err) {
    logger.error("Regressions error:", err);
    res.status(500).json({ error: "Failed to load regressions" });
  }
});

router.get("/:projectId/tesbo-reports/quality-overview", requireAuth, async (req, res) => {
  try {
    const [runsRes, clustersRes, flakyRes, regressionsRes] = await Promise.all([
      query(
        `SELECT
            COUNT(*)::integer AS total_runs,
            ROUND(AVG(release_risk_score))::integer AS avg_risk_score,
            MAX(release_risk_score)::integer AS max_risk_score
         FROM report_runs
         WHERE project_id = $1`,
        [req.params.projectId]
      ),
      query(
        `SELECT
            COUNT(*)::integer AS total_clusters,
            COALESCE(SUM(occurrence_count), 0)::integer AS total_cluster_occurrences
         FROM report_failure_clusters
         WHERE project_id = $1`,
        [req.params.projectId]
      ),
      query(
        `WITH latest AS (
           SELECT DISTINCT ON (project_id, test_identity_key)
             score
           FROM report_test_flakiness_snapshots
           WHERE project_id = $1
           ORDER BY project_id, test_identity_key, computed_at DESC
         )
         SELECT
           ROUND(AVG(score))::integer AS avg_flaky_score,
           COUNT(*) FILTER (WHERE score >= 70)::integer AS high_flaky_tests
         FROM latest`,
        [req.params.projectId]
      ),
      query(
        `SELECT COUNT(*)::integer AS probable_regressions
         FROM report_tests rt
         JOIN report_runs rr ON rr.id = rt.report_run_id
         WHERE rr.project_id = $1
           AND rt.is_probable_regression = TRUE`,
        [req.params.projectId]
      ),
    ]);

    res.json({
      runs: {
        totalRuns: Number(runsRes.rows[0]?.total_runs || 0),
        avgRiskScore: runsRes.rows[0]?.avg_risk_score != null ? Number(runsRes.rows[0].avg_risk_score) : null,
        maxRiskScore: runsRes.rows[0]?.max_risk_score != null ? Number(runsRes.rows[0].max_risk_score) : null,
      },
      clusters: {
        totalClusters: Number(clustersRes.rows[0]?.total_clusters || 0),
        totalOccurrences: Number(clustersRes.rows[0]?.total_cluster_occurrences || 0),
      },
      flakiness: {
        avgFlakyScore:
          flakyRes.rows[0]?.avg_flaky_score != null ? Number(flakyRes.rows[0].avg_flaky_score) : null,
        highFlakyTests: Number(flakyRes.rows[0]?.high_flaky_tests || 0),
      },
      regressions: {
        probableRegressions: Number(regressionsRes.rows[0]?.probable_regressions || 0),
      },
    });
  } catch (err) {
    logger.error("Quality overview error:", err);
    res.status(500).json({ error: "Failed to load quality overview" });
  }
});

router.post("/:projectId/tesbo-reports/ai/reanalyze", requireAuth, async (req, res) => {
  try {
    const days = Math.max(1, Math.min(90, parseInt(req.body?.days) || 90));
    const runsRes = await query(
      `SELECT DISTINCT rr.id
       FROM report_runs rr
       JOIN report_tests rt ON rt.report_run_id = rr.id
       WHERE rr.project_id = $1
         AND rr.created_at >= now() - ($2::text || ' days')::interval
         AND rt.status = 'Failed'
       ORDER BY rr.created_at DESC`,
      [req.params.projectId, String(days)]
    );

    for (const row of runsRes.rows) {
      void triggerFailedTestAiAnalysis({
        runId: row.id,
        projectId: req.params.projectId,
        runStatus: "COMPLETED",
      });
    }

    res.json({
      queuedRuns: runsRes.rows.length,
      days,
    });
  } catch (err) {
    logger.error("Reanalyze failed tests error:", err);
    res.status(500).json({ error: "Failed to queue re-analysis" });
  }
});

// ── Spec intelligence (spec-level trends across runs) ──────────────────────

router.get("/:projectId/tesbo-reports/spec-intelligence", requireAuth, async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit) || 50));
    const offset = (page - 1) * limit;

    const [specsResult, countResult] = await Promise.all([
      query(
        `SELECT
            COALESCE(NULLIF(rt.spec, ''), '(unknown spec)') AS spec,
            COUNT(*) AS total_executions,
            COUNT(*) FILTER (WHERE rt.status = 'Passed') AS passed,
            COUNT(*) FILTER (WHERE rt.status = 'Failed') AS failed,
            COUNT(*) FILTER (WHERE rt.status = 'Skipped') AS skipped,
            ROUND(AVG(rt.duration_ms))::integer AS avg_duration_ms,
            ROUND(
              (COUNT(*) FILTER (WHERE rt.status = 'Failed')::numeric / NULLIF(COUNT(*), 0)::numeric) * 100,
              2
            ) AS failure_rate,
            MAX(rr.created_at) AS last_seen_at,
            (ARRAY_AGG(rt.status ORDER BY rr.created_at DESC))[1] AS last_status,
            COUNT(*) FILTER (WHERE rt.ai_analysis_category = 'ACTUAL_BUG') AS actual_bug_failures,
            COUNT(*) FILTER (WHERE rt.ai_analysis_category = 'FEATURE_CHANGE') AS feature_change_failures,
            COUNT(*) FILTER (WHERE rt.ai_analysis_category = 'SCRIPT_ISSUE') AS script_issue_failures,
            COUNT(*) FILTER (WHERE rt.ai_analysis_category = 'ENVIRONMENT_ISSUE') AS environment_issue_failures
         FROM report_tests rt
         JOIN report_runs rr ON rr.id = rt.report_run_id
         WHERE rr.project_id = $1
         GROUP BY COALESCE(NULLIF(rt.spec, ''), '(unknown spec)')
         ORDER BY failed DESC, total_executions DESC, spec ASC
         LIMIT $2 OFFSET $3`,
        [req.params.projectId, limit, offset]
      ),
      query(
        `SELECT COUNT(*)::integer AS total
         FROM (
           SELECT COALESCE(NULLIF(rt.spec, ''), '(unknown spec)')
           FROM report_tests rt
           JOIN report_runs rr ON rr.id = rt.report_run_id
           WHERE rr.project_id = $1
           GROUP BY COALESCE(NULLIF(rt.spec, ''), '(unknown spec)')
         ) grouped_specs`,
        [req.params.projectId]
      ),
    ]);

    res.json({
      specs: specsResult.rows.map((row) => ({
        spec: row.spec,
        totalExecutions: parseInt(row.total_executions),
        passed: parseInt(row.passed),
        failed: parseInt(row.failed),
        skipped: parseInt(row.skipped),
        avgDurationMs: row.avg_duration_ms != null ? parseInt(row.avg_duration_ms) : null,
        failureRate: row.failure_rate != null ? Number(row.failure_rate) : 0,
        lastStatus: row.last_status,
        lastSeenAt: row.last_seen_at,
        actualBugFailures: parseInt(row.actual_bug_failures),
        featureChangeFailures: parseInt(row.feature_change_failures),
        scriptIssueFailures: parseInt(row.script_issue_failures),
        environmentIssueFailures: parseInt(row.environment_issue_failures),
      })),
      total: parseInt(countResult.rows[0].total),
      page,
      limit,
    });
  } catch (err) {
    logger.error("Spec intelligence error:", err);
    res.status(500).json({ error: "Failed to load spec intelligence" });
  }
});

// ── Test intelligence (test-level trends across runs) ──────────────────────

router.get("/:projectId/tesbo-reports/test-intelligence", requireAuth, async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit) || 50));
    const offset = (page - 1) * limit;

    const testNameExpr = "COALESCE(NULLIF(rt.full_title, ''), NULLIF(rt.name, ''), '(unnamed test)')";
    const specExpr = "COALESCE(NULLIF(rt.spec, ''), '(unknown spec)')";

    const [testsResult, countResult] = await Promise.all([
      query(
        `SELECT
            ${specExpr} AS spec,
            ${testNameExpr} AS test_name,
            COUNT(*) AS total_executions,
            COUNT(*) FILTER (WHERE rt.status = 'Passed') AS passed,
            COUNT(*) FILTER (WHERE rt.status = 'Failed') AS failed,
            COUNT(*) FILTER (WHERE rt.status = 'Skipped') AS skipped,
            ROUND(AVG(rt.duration_ms))::integer AS avg_duration_ms,
            ROUND(
              (COUNT(*) FILTER (WHERE rt.status = 'Failed')::numeric * 100)
              / NULLIF(COUNT(*), 0),
              2
            ) AS failure_rate,
            (COUNT(*) FILTER (WHERE rt.status = 'Passed') > 0
             AND COUNT(*) FILTER (WHERE rt.status = 'Failed') > 0) AS flaky,
            MAX(rr.created_at) AS last_seen_at,
            (ARRAY_AGG(rt.status ORDER BY rr.created_at DESC))[1] AS last_status,
            COUNT(*) FILTER (WHERE rt.ai_analysis_category = 'ACTUAL_BUG') AS actual_bug_failures,
            COUNT(*) FILTER (WHERE rt.ai_analysis_category = 'FEATURE_CHANGE') AS feature_change_failures,
            COUNT(*) FILTER (WHERE rt.ai_analysis_category = 'SCRIPT_ISSUE') AS script_issue_failures,
            COUNT(*) FILTER (WHERE rt.ai_analysis_category = 'ENVIRONMENT_ISSUE') AS environment_issue_failures,
            (ARRAY_REMOVE(ARRAY_AGG(rt.error_message ORDER BY rr.created_at DESC), NULL))[1] AS latest_error_message,
            MAX(COALESCE(rt.is_probable_regression, FALSE)::int)::boolean AS probable_regression,
            fl.score AS flaky_score,
            fl.trend_slope AS flaky_trend_slope,
            fl.likely_reason AS likely_flaky_reason
         FROM report_tests rt
         JOIN report_runs rr ON rr.id = rt.report_run_id
         LEFT JOIN LATERAL (
            SELECT s.score, s.trend_slope, s.likely_reason
            FROM report_test_flakiness_snapshots s
            WHERE s.project_id = $1
              AND COALESCE(s.spec, '') = COALESCE(rt.spec, '')
              AND COALESCE(s.test_name, '') = COALESCE(rt.name, '')
            ORDER BY s.computed_at DESC
            LIMIT 1
         ) fl ON TRUE
         WHERE rr.project_id = $1
         GROUP BY ${specExpr}, ${testNameExpr}, fl.score, fl.trend_slope, fl.likely_reason
         ORDER BY failed DESC, total_executions DESC, test_name ASC
         LIMIT $2 OFFSET $3`,
        [req.params.projectId, limit, offset]
      ),
      query(
        `SELECT COUNT(*)::integer AS total
         FROM (
           SELECT ${specExpr}, ${testNameExpr}
           FROM report_tests rt
           JOIN report_runs rr ON rr.id = rt.report_run_id
           WHERE rr.project_id = $1
           GROUP BY ${specExpr}, ${testNameExpr}
         ) grouped_tests`,
        [req.params.projectId]
      ),
    ]);

    res.json({
      tests: testsResult.rows.map((row) => ({
        spec: row.spec,
        testName: row.test_name,
        totalExecutions: parseInt(row.total_executions),
        passed: parseInt(row.passed),
        failed: parseInt(row.failed),
        skipped: parseInt(row.skipped),
        avgDurationMs: row.avg_duration_ms != null ? parseInt(row.avg_duration_ms) : null,
        failureRate: row.failure_rate != null ? Number(row.failure_rate) : 0,
        flaky: row.flaky === true,
        lastStatus: row.last_status,
        lastSeenAt: row.last_seen_at,
        actualBugFailures: parseInt(row.actual_bug_failures),
        featureChangeFailures: parseInt(row.feature_change_failures),
        scriptIssueFailures: parseInt(row.script_issue_failures),
        environmentIssueFailures: parseInt(row.environment_issue_failures),
        latestErrorMessage: row.latest_error_message || null,
        probableRegression: row.probable_regression === true,
        flakyScore: row.flaky_score != null ? Number(row.flaky_score) : null,
        flakyTrendSlope: row.flaky_trend_slope != null ? Number(row.flaky_trend_slope) : null,
        likelyFlakyReason: row.likely_flaky_reason || null,
      })),
      total: parseInt(countResult.rows[0].total),
      page,
      limit,
    });
  } catch (err) {
    logger.error("Test intelligence error:", err);
    res.status(500).json({ error: "Failed to load test intelligence" });
  }
});

// ── Spec intelligence detail (single spec, across runs) ────────────────────

router.get("/:projectId/tesbo-reports/spec-intelligence/detail", requireAuth, async (req, res) => {
  try {
    const spec = String(req.query.spec || "").trim();
    if (!spec) {
      return res.status(400).json({ error: "spec query parameter is required" });
    }

    const runLimit = Math.min(60, Math.max(5, parseInt(req.query.runLimit) || 25));

    const [
      summaryResult,
      runsResult,
      topFailuresResult,
      peerSpecsResult,
      testCaseFlakinessResult,
    ] = await Promise.all([
      query(
        `SELECT
            COUNT(*) AS total_executions,
            COUNT(*) FILTER (WHERE rt.status = 'Passed') AS passed,
            COUNT(*) FILTER (WHERE rt.status = 'Failed') AS failed,
            COUNT(*) FILTER (WHERE rt.status = 'Skipped') AS skipped,
            ROUND(AVG(rt.duration_ms))::integer AS avg_duration_ms,
            ROUND(
              (COUNT(*) FILTER (WHERE rt.status = 'Failed')::numeric / NULLIF(COUNT(*), 0)::numeric) * 100,
              2
            ) AS failure_rate,
            MAX(rr.created_at) AS last_seen_at,
            COUNT(*) FILTER (WHERE rt.ai_analysis_category = 'ACTUAL_BUG') AS actual_bug_failures,
            COUNT(*) FILTER (WHERE rt.ai_analysis_category = 'FEATURE_CHANGE') AS feature_change_failures,
            COUNT(*) FILTER (WHERE rt.ai_analysis_category = 'SCRIPT_ISSUE') AS script_issue_failures,
            COUNT(*) FILTER (WHERE rt.ai_analysis_category = 'ENVIRONMENT_ISSUE') AS environment_issue_failures
         FROM report_tests rt
         JOIN report_runs rr ON rr.id = rt.report_run_id
         WHERE rr.project_id = $1
           AND COALESCE(NULLIF(rt.spec, ''), '(unknown spec)') = $2`,
        [req.params.projectId, spec]
      ),
      query(
        `SELECT
            rr.id AS run_id,
            rr.run_name,
            rr.status AS run_status,
            rr.started_at,
            rr.created_at,
            COUNT(*) AS total_executions,
            COUNT(*) FILTER (WHERE rt.status = 'Passed') AS passed,
            COUNT(*) FILTER (WHERE rt.status = 'Failed') AS failed,
            COUNT(*) FILTER (WHERE rt.status = 'Skipped') AS skipped,
            ROUND(AVG(rt.duration_ms))::integer AS avg_duration_ms,
            ROUND(
              (COUNT(*) FILTER (WHERE rt.status = 'Failed')::numeric * 100)
              / NULLIF(COUNT(*), 0),
              2
            ) AS failure_rate
         FROM report_tests rt
         JOIN report_runs rr ON rr.id = rt.report_run_id
         WHERE rr.project_id = $1
           AND COALESCE(NULLIF(rt.spec, ''), '(unknown spec)') = $2
         GROUP BY rr.id, rr.run_name, rr.status, rr.started_at, rr.created_at
         ORDER BY COALESCE(rr.started_at, rr.created_at) DESC
         LIMIT $3`,
        [req.params.projectId, spec, runLimit]
      ),
      query(
        `SELECT
            COALESCE(NULLIF(rt.full_title, ''), NULLIF(rt.name, ''), '(unnamed test)') AS test_name,
            COUNT(*) FILTER (WHERE rt.status = 'Failed') AS failed,
            COUNT(*) FILTER (WHERE rt.status = 'Passed') AS passed,
            COUNT(*) AS total_executions,
            ROUND(
              (COUNT(*) FILTER (WHERE rt.status = 'Failed')::numeric / NULLIF(COUNT(*), 0)::numeric) * 100,
              2
            ) AS failure_rate,
            MAX(rr.created_at) FILTER (WHERE rt.status = 'Failed') AS last_failed_at
         FROM report_tests rt
         JOIN report_runs rr ON rr.id = rt.report_run_id
         WHERE rr.project_id = $1
           AND COALESCE(NULLIF(rt.spec, ''), '(unknown spec)') = $2
         GROUP BY COALESCE(NULLIF(rt.full_title, ''), NULLIF(rt.name, ''), '(unnamed test)')
         ORDER BY failed DESC, failure_rate DESC, total_executions DESC, test_name ASC
         LIMIT 10`,
        [req.params.projectId, spec]
      ),
      query(
        `SELECT
            COALESCE(NULLIF(rt.spec, ''), '(unknown spec)') AS spec,
            COUNT(*) FILTER (WHERE rt.status = 'Passed') AS passed,
            COUNT(*) FILTER (WHERE rt.status = 'Failed') AS failed
         FROM report_tests rt
         JOIN report_runs rr ON rr.id = rt.report_run_id
         WHERE rr.project_id = $1
         GROUP BY COALESCE(NULLIF(rt.spec, ''), '(unknown spec)')
         ORDER BY failed DESC, passed DESC, spec ASC
         LIMIT 12`,
        [req.params.projectId]
      ),
      query(
        `SELECT
            COALESCE(NULLIF(rt.full_title, ''), NULLIF(rt.name, ''), '(unnamed test)') AS test_name,
            COUNT(*) AS total_executions,
            COUNT(*) FILTER (WHERE rt.status = 'Passed') AS passed,
            COUNT(*) FILTER (WHERE rt.status = 'Failed') AS failed,
            COUNT(*) FILTER (WHERE rt.status = 'Skipped') AS skipped,
            ROUND(
              (COUNT(*) FILTER (WHERE rt.status = 'Failed')::numeric * 100)
              / NULLIF(COUNT(*), 0),
              2
            ) AS flaky_ratio,
            (
              COUNT(*) FILTER (WHERE rt.status = 'Passed') > 0
              AND COUNT(*) FILTER (WHERE rt.status = 'Failed') > 0
            ) AS flaky
         FROM report_tests rt
         JOIN report_runs rr ON rr.id = rt.report_run_id
         WHERE rr.project_id = $1
           AND COALESCE(NULLIF(rt.spec, ''), '(unknown spec)') = $2
         GROUP BY COALESCE(NULLIF(rt.full_title, ''), NULLIF(rt.name, ''), '(unnamed test)')
         ORDER BY flaky DESC, flaky_ratio DESC, total_executions DESC, test_name ASC`,
        [req.params.projectId, spec]
      ),
    ]);

    const summary = summaryResult.rows[0];
    const totalExecutions = parseInt(summary?.total_executions || "0");
    if (totalExecutions === 0) {
      return res.json({
        spec,
        summary: null,
        runs: [],
        topFailingTests: [],
        peerSpecComparison: [],
      });
    }

    const testCases = testCaseFlakinessResult.rows.map((row) => ({
      testName: row.test_name,
      totalExecutions: parseInt(row.total_executions),
      passed: parseInt(row.passed),
      failed: parseInt(row.failed),
      skipped: parseInt(row.skipped),
      flakyRatio: row.flaky_ratio != null ? Number(row.flaky_ratio) : 0,
      flaky: row.flaky === true,
    }));

    const totalTestCases = testCases.length;
    const flakyTestCases = testCases.filter((testCase) => testCase.flaky).length;
    const combinedSpecFlakyRatio =
      totalTestCases > 0
        ? Number(((flakyTestCases * 100) / totalTestCases).toFixed(2))
        : 0;

    res.json({
      spec,
      summary: {
        totalExecutions,
        passed: parseInt(summary.passed),
        failed: parseInt(summary.failed),
        skipped: parseInt(summary.skipped),
        avgDurationMs:
          summary.avg_duration_ms != null ? parseInt(summary.avg_duration_ms) : null,
        failureRate: summary.failure_rate != null ? Number(summary.failure_rate) : 0,
        lastSeenAt: summary.last_seen_at,
        actualBugFailures: parseInt(summary.actual_bug_failures),
        featureChangeFailures: parseInt(summary.feature_change_failures),
        scriptIssueFailures: parseInt(summary.script_issue_failures),
        environmentIssueFailures: parseInt(summary.environment_issue_failures),
        totalTestCases,
        flakyTestCases,
        combinedSpecFlakyRatio,
      },
      runs: runsResult.rows.map((row) => ({
        runId: row.run_id,
        runName: row.run_name,
        runStatus: row.run_status,
        startedAt: row.started_at || row.created_at,
        totalExecutions: parseInt(row.total_executions),
        passed: parseInt(row.passed),
        failed: parseInt(row.failed),
        skipped: parseInt(row.skipped),
        avgDurationMs:
          row.avg_duration_ms != null ? parseInt(row.avg_duration_ms) : null,
        failureRate: row.failure_rate != null ? Number(row.failure_rate) : 0,
      })),
      topFailingTests: topFailuresResult.rows.map((row) => ({
        testName: row.test_name,
        failed: parseInt(row.failed),
        passed: parseInt(row.passed),
        totalExecutions: parseInt(row.total_executions),
        failureRate: row.failure_rate != null ? Number(row.failure_rate) : 0,
        lastFailedAt: row.last_failed_at || null,
      })),
      peerSpecComparison: peerSpecsResult.rows.map((row) => ({
        spec: row.spec,
        passed: parseInt(row.passed),
        failed: parseInt(row.failed),
      })),
      testCaseFlakiness: testCases,
    });
  } catch (err) {
    logger.error("Spec intelligence detail error:", err);
    res.status(500).json({ error: "Failed to load spec intelligence detail" });
  }
});

// ── Test intelligence detail (single test, across runs) ────────────────────

router.get("/:projectId/tesbo-reports/test-intelligence/detail", requireAuth, async (req, res) => {
  try {
    const spec = String(req.query.spec || "").trim();
    const testName = String(req.query.testName || "").trim();
    if (!spec || !testName) {
      return res
        .status(400)
        .json({ error: "spec and testName query parameters are required" });
    }

    const runLimit = Math.min(80, Math.max(5, parseInt(req.query.runLimit) || 30));
    const testNameExpr =
      "COALESCE(NULLIF(rt.full_title, ''), NULLIF(rt.name, ''), '(unnamed test)')";
    const specExpr = "COALESCE(NULLIF(rt.spec, ''), '(unknown spec)')";

    const [summaryResult, runsResult] = await Promise.all([
      query(
        `SELECT
            COUNT(*) AS total_executions,
            COUNT(*) FILTER (WHERE rt.status = 'Passed') AS passed,
            COUNT(*) FILTER (WHERE rt.status = 'Failed') AS failed,
            COUNT(*) FILTER (WHERE rt.status = 'Skipped') AS skipped,
            ROUND(AVG(rt.duration_ms))::integer AS avg_duration_ms,
            ROUND(
              (COUNT(*) FILTER (WHERE rt.status = 'Failed')::numeric * 100)
              / NULLIF(COUNT(*), 0),
              2
            ) AS failure_rate,
            (COUNT(*) FILTER (WHERE rt.status = 'Passed') > 0
             AND COUNT(*) FILTER (WHERE rt.status = 'Failed') > 0) AS flaky,
            MAX(rr.created_at) AS last_seen_at,
            COUNT(*) FILTER (WHERE rt.ai_analysis_category = 'ACTUAL_BUG') AS actual_bug_failures,
            COUNT(*) FILTER (WHERE rt.ai_analysis_category = 'FEATURE_CHANGE') AS feature_change_failures,
            COUNT(*) FILTER (WHERE rt.ai_analysis_category = 'SCRIPT_ISSUE') AS script_issue_failures,
            COUNT(*) FILTER (WHERE rt.ai_analysis_category = 'ENVIRONMENT_ISSUE') AS environment_issue_failures,
            (ARRAY_REMOVE(ARRAY_AGG(rt.error_message ORDER BY rr.created_at DESC), NULL))[1] AS latest_error_message,
            COUNT(*) FILTER (WHERE rt.is_probable_regression = TRUE) AS probable_regressions
         FROM report_tests rt
         JOIN report_runs rr ON rr.id = rt.report_run_id
         WHERE rr.project_id = $1
           AND ${specExpr} = $2
           AND ${testNameExpr} = $3`,
        [req.params.projectId, spec, testName]
      ),
      query(
        `SELECT
            rr.id AS run_id,
            rr.run_name,
            rr.status AS run_status,
            rr.started_at,
            rr.created_at,
            rt.status AS test_status,
            rt.duration_ms,
            rt.error_message,
            rt.ai_analysis_category,
            rt.ai_analysis_summary,
            rt.ai_analysis_confidence,
            rt.steps,
            rt.is_probable_regression,
            rt.regression_confidence,
            rt.regression_pass_streak_before_fail,
            rt.regression_hint
         FROM report_tests rt
         JOIN report_runs rr ON rr.id = rt.report_run_id
         WHERE rr.project_id = $1
           AND ${specExpr} = $2
           AND ${testNameExpr} = $3
         ORDER BY COALESCE(rr.started_at, rr.created_at) DESC
         LIMIT $4`,
        [req.params.projectId, spec, testName, runLimit]
      ),
    ]);

    const summary = summaryResult.rows[0];
    const totalExecutions = parseInt(summary?.total_executions || "0");
    if (totalExecutions === 0) {
      return res.json({
        spec,
        testName,
        summary: null,
        runs: [],
      });
    }

    res.json({
      spec,
      testName,
      summary: {
        totalExecutions,
        passed: parseInt(summary.passed),
        failed: parseInt(summary.failed),
        skipped: parseInt(summary.skipped),
        avgDurationMs:
          summary.avg_duration_ms != null ? parseInt(summary.avg_duration_ms) : null,
        failureRate: summary.failure_rate != null ? Number(summary.failure_rate) : 0,
        flaky: summary.flaky === true,
        lastSeenAt: summary.last_seen_at,
        actualBugFailures: parseInt(summary.actual_bug_failures),
        featureChangeFailures: parseInt(summary.feature_change_failures),
        scriptIssueFailures: parseInt(summary.script_issue_failures),
        environmentIssueFailures: parseInt(summary.environment_issue_failures),
        latestErrorMessage: summary.latest_error_message || null,
        probableRegressions: parseInt(summary.probable_regressions || "0"),
      },
      runs: runsResult.rows.map((row) => ({
        runId: row.run_id,
        runName: row.run_name,
        runStatus: row.run_status,
        startedAt: row.started_at || row.created_at,
        testStatus: row.test_status,
        durationMs: row.duration_ms != null ? parseInt(row.duration_ms) : null,
        errorMessage: row.error_message || null,
        aiAnalysisCategory: row.ai_analysis_category || null,
        aiAnalysisSummary: row.ai_analysis_summary || null,
        aiAnalysisConfidence:
          row.ai_analysis_confidence != null ? Number(row.ai_analysis_confidence) : null,
        steps: Array.isArray(row.steps) ? row.steps : [],
        isProbableRegression: row.is_probable_regression === true,
        regressionConfidence:
          row.regression_confidence != null ? Number(row.regression_confidence) : null,
        regressionPassStreakBeforeFail:
          row.regression_pass_streak_before_fail != null
            ? Number(row.regression_pass_streak_before_fail)
            : null,
        regressionHint: row.regression_hint || null,
      })),
    });
  } catch (err) {
    logger.error("Test intelligence detail error:", err);
    res.status(500).json({ error: "Failed to load test intelligence detail" });
  }
});

// ── Helpers ─────────────────────────────────────────────────────────────────

async function upsertTests(runId, tests) {
  for (const t of tests) {
    const spec = t.spec || "";
    const name = t.name || "";
    const normalizedStatus = t.status || "Skipped";
    await query(
      `INSERT INTO report_tests
         (report_run_id, spec, name, full_title, status, duration_ms,
          error_message, error_stack, attempt, project_name,
          tags, trace_url, screenshot_url, video_url, steps,
          ai_analysis_status, ai_analysis_category, ai_analysis_summary,
          ai_analysis_confidence, ai_analysis_model, ai_analysis_updated_at, ai_analysis_prompt_version)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, NULL, NULL, NULL, NULL, NULL, NULL)
       ON CONFLICT (report_run_id, COALESCE(spec, ''), COALESCE(name, ''))
       DO UPDATE SET
         full_title = EXCLUDED.full_title,
         status = EXCLUDED.status,
         duration_ms = EXCLUDED.duration_ms,
         error_message = EXCLUDED.error_message,
         error_stack = EXCLUDED.error_stack,
         attempt = EXCLUDED.attempt,
         project_name = EXCLUDED.project_name,
         tags = EXCLUDED.tags,
         trace_url = EXCLUDED.trace_url,
         screenshot_url = EXCLUDED.screenshot_url,
         video_url = EXCLUDED.video_url,
         steps = EXCLUDED.steps,
         ai_analysis_status = EXCLUDED.ai_analysis_status,
         ai_analysis_category = NULL,
         ai_analysis_summary = NULL,
         ai_analysis_confidence = NULL,
         ai_analysis_model = NULL,
         ai_analysis_updated_at = NULL,
         ai_analysis_prompt_version = NULL,
         is_probable_regression = FALSE,
         regression_confidence = NULL,
         regression_pass_streak_before_fail = NULL,
         regression_first_seen_run_id = NULL,
         regression_hint = NULL`,
      [
        runId,
        spec || null,
        name || null,
        t.fullTitle || t.full_title || null,
        normalizedStatus,
        t.durationMs ?? t.duration_ms ?? null,
        t.errorMessage ?? t.error_message ?? null,
        t.errorStack ?? t.error_stack ?? null,
        t.attempt ?? null,
        t.projectName ?? t.project_name ?? null,
        JSON.stringify(t.tags || []),
        t.traceUrl ?? t.trace_url ?? null,
        t.screenshotUrl ?? t.screenshot_url ?? null,
        t.videoUrl ?? t.video_url ?? null,
        JSON.stringify(t.steps || []),
        normalizedStatus === "Failed" ? "PENDING" : null,
      ]
    );
  }
}

async function recalcCounts(runId) {
  const result = await query(
    `SELECT
       COUNT(*) AS total,
       COUNT(*) FILTER (WHERE status = 'Passed') AS passed,
       COUNT(*) FILTER (WHERE status = 'Failed') AS failed,
       COUNT(*) FILTER (WHERE status = 'Skipped') AS skipped,
       COALESCE(SUM(duration_ms), 0) AS duration_ms
     FROM report_tests WHERE report_run_id = $1`,
    [runId]
  );
  const r = result.rows[0];
  return {
    total: parseInt(r.total),
    passed: parseInt(r.passed),
    failed: parseInt(r.failed),
    skipped: parseInt(r.skipped),
    durationMs: parseInt(r.duration_ms),
  };
}

function timestampToIso(value) {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") return value;
  return null;
}

function wallClockDurationMs(startedAt, completedAt) {
  if (!startedAt || !completedAt) return null;
  const s = Date.parse(startedAt);
  const e = Date.parse(completedAt);
  if (!Number.isFinite(s) || !Number.isFinite(e)) return null;
  return Math.max(0, Math.round(e - s));
}

/**
 * Run-level duration is wall-clock when the run is finalized and we have both timestamps.
 * Summing per-test duration_ms is wrong for parallel execution (many workers at once).
 */
function resolveRunDurationMs({ summedMs, startedAt, completedAt, status }) {
  const normalized = String(status || "").toUpperCase();
  if (["COMPLETED", "FAILED", "CANCELLED", "TIMED_OUT"].includes(normalized)) {
    const wall = wallClockDurationMs(startedAt, completedAt);
    if (wall != null) return wall;
  }
  return summedMs;
}

function normalizeRunStatus(status) {
  const s = String(status || "").toUpperCase();
  if (s === "COMPLETED" || s === "PASSED") return "COMPLETED";
  if (s === "FAILED") return "FAILED";
  if (s === "CANCELLED") return "CANCELLED";
  if (s === "TIMED_OUT") return "TIMED_OUT";
  return "IN_PROGRESS";
}

function isRunFinalized(status) {
  return ["COMPLETED", "FAILED", "CANCELLED", "TIMED_OUT"].includes(status);
}

async function triggerFailedTestAiAnalysis({ runId, projectId, runStatus }) {
  try {
    const aiConfig = await getProjectAiConfig(projectId);
    if (!aiConfig) {
      logger.debug(
        "Skipping failed-test AI analysis: no active AI key allocation for project",
        { projectId, runId, runStatus }
      );
      return;
    }

    const failedTests = await query(
      `SELECT id, spec, name, full_title, error_message, error_stack, steps, tags
       FROM report_tests
       WHERE report_run_id = $1
         AND status = 'Failed'
         AND ai_analysis_status = 'PENDING'
       ORDER BY created_at`,
      [runId]
    );

    if (failedTests.rows.length === 0) return;

    for (const failedTest of failedTests.rows) {
      const history = await getTestHistory(failedTest, runId, projectId);
      const analysis = await classifyFailureWithAi({
        aiConfig,
        test: failedTest,
        history,
      });

      if (analysis.ok) {
        const lowConfidence = analysis.confidence != null
          && analysis.confidence < AI_MIN_CONFIDENCE_FOR_AUTO_CATEGORY;
        const status = lowConfidence ? "NEEDS_REVIEW" : "COMPLETED";
        await query(
          `UPDATE report_tests
           SET ai_analysis_status = $6,
               ai_analysis_category = $2,
               ai_analysis_summary = $3,
               ai_analysis_confidence = $4,
               ai_analysis_model = $5,
               ai_analysis_prompt_version = $7,
               ai_analysis_updated_at = now()
           WHERE id = $1`,
          [
            failedTest.id,
            analysis.category,
            analysis.summary,
            analysis.confidence,
            analysis.model,
            status,
            AI_ANALYSIS_PROMPT_VERSION,
          ]
        );
      } else {
        await query(
          `UPDATE report_tests
           SET ai_analysis_status = 'ERROR',
               ai_analysis_summary = $2,
               ai_analysis_model = $3,
               ai_analysis_prompt_version = $4,
               ai_analysis_updated_at = now()
           WHERE id = $1`,
          [failedTest.id, analysis.error, analysis.model || null, AI_ANALYSIS_PROMPT_VERSION]
        );
      }
    }

    await triggerQaIntelligencePipeline({ runId, projectId });
  } catch (err) {
    logger.error("Failed test AI analysis failed:", err);
  }
}

async function triggerQaIntelligencePipeline({ runId, projectId }) {
  try {
    await clusterFailedTestsForRun({ projectId, runId, query });
    await computeAndPersistFlakyScoresForRun({ projectId, runId, query });
    await detectRegressionsForRun({ projectId, runId, query });
    await computeAndPersistReleaseRiskForRun({ projectId, runId, query });
  } catch (err) {
    logger.error("AI QA intelligence pipeline failed:", err);
  }
}

async function getProjectAiConfig(projectId) {
  const result = await query(
    `SELECT wak.provider, wak.api_key, wak.default_model
     FROM execute_project_ai_key_allocations epa
     JOIN workspace_ai_keys wak
       ON wak.id = epa.workspace_ai_key_id
      AND wak.is_active = TRUE
     WHERE epa.execute_project_id = $1
     LIMIT 1`,
    [projectId]
  );
  if (result.rows.length === 0) return null;
  return result.rows[0];
}

async function getTestHistory(test, currentRunId, projectId) {
  try {
    const result = await query(
      `SELECT rt.status, rt.error_message, rr.run_name, rr.started_at, rr.created_at
       FROM report_tests rt
       JOIN report_runs rr ON rr.id = rt.report_run_id
       WHERE rr.project_id = $1
         AND COALESCE(rt.spec, '') = $2
         AND COALESCE(rt.name, '') = $3
         AND rt.report_run_id != $4
       ORDER BY COALESCE(rr.started_at, rr.created_at) DESC
       LIMIT 10`,
      [projectId, test.spec || "", test.name || "", currentRunId]
    );
    return result.rows.map((r) => ({
      status: r.status,
      runName: r.run_name || null,
      at: r.started_at || r.created_at,
      errorMessage: r.error_message ? truncateText(r.error_message, 200) : null,
    }));
  } catch {
    return [];
  }
}

async function classifyFailureWithAi({ aiConfig, test, history = [] }) {
  const prompt = buildFailureClassificationPrompt(test, history);
  try {
    const { text, model } = await callAiProvider({
      provider: aiConfig.provider,
      apiKey: aiConfig.api_key,
      model: aiConfig.default_model,
      prompt,
    });
    const parsed = parseAiClassification(text) || classifyFailureDeterministically(test, history);
    if (!parsed) {
      return {
        ok: false,
        error: "AI returned an invalid classification payload and fallback was inconclusive",
        model,
      };
    }
    return { ok: true, ...parsed, model };
  } catch (err) {
    const fallback = classifyFailureDeterministically(test, history);
    if (fallback) {
      return {
        ok: true,
        ...fallback,
        model: aiConfig.default_model || "deterministic-fallback",
      };
    }
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Unknown AI analysis error",
      model: aiConfig.default_model || null,
    };
  }
}

function buildFailureClassificationPrompt(test, history = []) {
  const payload = {
    testName: test.name || test.full_title || "Unknown test",
    spec: test.spec || null,
    fullTitle: test.full_title || null,
    tags: Array.isArray(test.tags) ? test.tags : [],
    errorMessage: truncateText(test.error_message, 3000),
    errorStack: truncateText(test.error_stack, 6000),
    steps: Array.isArray(test.steps)
      ? test.steps.slice(0, 12).map((s) => s.description || "").filter(Boolean)
      : [],
    history: history.length > 0
      ? history.map((h) => ({
          status: h.status,
          errorMessage: h.errorMessage || null,
        }))
      : null,
  };

  const historySummary = buildHistorySummary(history);

  return [
    "You are an expert QA failure triage assistant.",
    "Think step-by-step privately, but return only final JSON.",
    "",
    "Classify this FAILED automated test into exactly ONE of these four categories:",
    "",
    "- ACTUAL_BUG: The application itself has a defect. The feature does not work as expected.",
    "  Signs: assertion on app behavior fails, API returns wrong data/status, business logic error,",
    "  UI element missing or broken. The test was passing before and the app code changed.",
    "",
    "- FEATURE_CHANGE: The test fails because intentional product changes broke it.",
    "  Signs: UI text/label changed, page flow restructured, API contract changed, new required field added,",
    "  selector still valid but content/behavior changed by design. Often seen when a test was green then",
    "  suddenly fails on many elements after a release.",
    "  Negative examples: random timeout, DNS/network failures, stale selectors with no release signal.",
    "",
    "- SCRIPT_ISSUE: The test automation code itself is the problem, not the app.",
    "  Signs: stale/broken locator (element not found, no such element), hardcoded wait too short,",
    "  missing await, wrong assertion logic, test data setup failure, brittle XPath/CSS selector,",
    "  test depends on another test, flaky intermittent failures with no consistent error.",
    "  Negative examples: backend/API returns logically wrong data with stable reproduction.",
    "",
    "- ENVIRONMENT_ISSUE: Infrastructure or environment caused the failure.",
    "  Strict definition: environment unavailable, browser crashed/disconnected, cannot connect to Selenium",
    "  grid/node, session not created, chromedriver crash, DNS/connection refused, service 503,",
    "  certificate error, OOM, third-party API down.",
    "  NOT ENVIRONMENT_ISSUE: a Selenium `findElement` that exceeds its wait timeout — the grid surfaces",
    "  that as 'Command duration or timeout' / HTTP 504, but the root cause is a missing element, which",
    "  is a SCRIPT_ISSUE (or possibly an ACTUAL_BUG / FEATURE_CHANGE if the element vanished by design).",
    "",
    "Decision rules using test history:",
    `- Test history (recent runs): ${historySummary}`,
    "- Element not found / no such element / locator timeout / waitFor selector / `findElement` timeout:",
    "  classify as SCRIPT_ISSUE by default. The word 'timeout' inside an element-wait error does NOT make",
    "  it an environment issue.",
    "- If the test recently passed (≥2 of last 3 runs) and now fails with element-not-found: still",
    "  SCRIPT_ISSUE, but in summary flag it as 'Possible bug — was passing recently, UI may have changed",
    "  or app element is missing'. Do NOT assign ACTUAL_BUG for element-not-found alone — that label is",
    "  reserved for confirmed bugs after human evaluation.",
    "- If history shows frequent pass/fail switching (high transition rate, both outcomes present):",
    "  flag in summary as 'Possible flaky test' regardless of the chosen category.",
    "- If always failing from day one: lean toward SCRIPT_ISSUE.",
    "- True network/infra errors (ECONNREFUSED, DNS, browser crash, grid unreachable, session not",
    "  created, 503): ENVIRONMENT_ISSUE.",
    "- Assertion mismatch on app behavior with recent passes: ACTUAL_BUG (possible product regression).",
    "- Wrong value / unexpected behavior after a release: FEATURE_CHANGE if intentional, ACTUAL_BUG if not.",
    "- Prefer SCRIPT_ISSUE over ACTUAL_BUG when failure is clearly in locator/wait code.",
    "- Prefer ENVIRONMENT_ISSUE over SCRIPT_ISSUE only for genuine connection/DNS/service infra failures,",
    "  never for element-wait timeouts.",
    "",
    "Return strict JSON only with exactly these keys: category, summary, confidence.",
    'Example: {"category":"SCRIPT_ISSUE","summary":"Locator for submit button is outdated after recent UI refactor","confidence":82}',
    "Rules: category must be one of ACTUAL_BUG, FEATURE_CHANGE, SCRIPT_ISSUE, ENVIRONMENT_ISSUE.",
    "summary must be under 220 characters. confidence is 0-100.",
    "",
    JSON.stringify(payload),
  ].join("\n");
}

function buildHistorySummary(history) {
  if (!history || history.length === 0) return "No previous runs available.";
  const counts = { Passed: 0, Failed: 0, Skipped: 0 };
  for (const h of history) {
    counts[h.status] = (counts[h.status] || 0) + 1;
  }
  const parts = [];
  if (counts.Passed) parts.push(`${counts.Passed} passed`);
  if (counts.Failed) parts.push(`${counts.Failed} failed`);
  if (counts.Skipped) parts.push(`${counts.Skipped} skipped`);
  const recentStatuses = history.slice(0, 5).map((h) => h.status).join(", ");
  return `Last ${history.length} runs: ${parts.join(", ")}. Most recent: [${recentStatuses}].`;
}

function truncateText(value, maxLength) {
  if (!value || typeof value !== "string") return null;
  if (value.length <= maxLength) return value;
  return value.slice(0, maxLength) + "\n...[truncated]";
}

async function callAiProvider({ provider, apiKey, model, prompt }) {
  if (provider === "openai") {
    return callOpenAi({ apiKey, model, prompt });
  }
  if (provider === "anthropic") {
    return callAnthropic({ apiKey, model, prompt });
  }
  throw new Error(`Unsupported AI provider: ${provider}`);
}

async function callOpenAi({ apiKey, model, prompt }) {
  const resolvedModel = model || OPENAI_DEFAULT_MODEL;
  const data = await fetchJsonWithTimeout("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: resolvedModel,
      temperature: 0.1,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: "Return strict JSON only.",
        },
        {
          role: "user",
          content: prompt,
        },
      ],
    }),
  });

  const text = data?.choices?.[0]?.message?.content;
  if (!text) throw new Error("OpenAI response did not include content");
  return { text, model: data?.model || resolvedModel };
}

async function callAnthropic({ apiKey, model, prompt }) {
  const resolvedModel = model || ANTHROPIC_DEFAULT_MODEL;
  const data = await fetchJsonWithTimeout("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: resolvedModel,
      max_tokens: 300,
      temperature: 0.1,
      messages: [
        {
          role: "user",
          content: prompt,
        },
      ],
    }),
  });

  const content = data?.content;
  const text = Array.isArray(content)
    ? content.find((part) => part?.type === "text")?.text
    : null;
  if (!text) throw new Error("Anthropic response did not include text content");
  return { text, model: data?.model || resolvedModel };
}

async function fetchJsonWithTimeout(url, options) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), AI_ANALYSIS_TIMEOUT_MS);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      const detail =
        payload?.error?.message || payload?.error?.type || JSON.stringify(payload || {});
      throw new Error(`AI provider error (${response.status}): ${detail}`);
    }
    return payload;
  } finally {
    clearTimeout(timeout);
  }
}

function parseAiClassification(rawText) {
  if (!rawText || typeof rawText !== "string") return null;
  const jsonPayload = extractJsonObject(rawText);
  if (!jsonPayload) return null;
  try {
    const parsed = JSON.parse(jsonPayload);
    const category = normalizeCategory(parsed?.category);
    const summary = String(parsed?.summary || "").trim();
    const confidence = clampConfidence(parsed?.confidence);

    if (!category || !summary) return null;
    return { category, summary: summary.slice(0, 220), confidence };
  } catch {
    return null;
  }
}

function extractJsonObject(rawText) {
  const trimmed = String(rawText || "").trim();
  if (!trimmed) return null;
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  const source = fenceMatch?.[1] || trimmed;
  const firstBrace = source.indexOf("{");
  const lastBrace = source.lastIndexOf("}");
  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) return null;
  return source.slice(firstBrace, lastBrace + 1);
}

const VALID_AI_CATEGORIES = new Set([
  "ACTUAL_BUG",
  "FEATURE_CHANGE",
  "SCRIPT_ISSUE",
  "ENVIRONMENT_ISSUE",
]);

function normalizeCategory(value) {
  const normalized = String(value || "")
    .toUpperCase()
    .trim()
    .replace(/[\s-]+/g, "_");
  if (VALID_AI_CATEGORIES.has(normalized)) return normalized;
  if (normalized === "ACTUALBUG" || normalized === "PRODUCT_BUG") return "ACTUAL_BUG";
  if (normalized === "FEATURE_UPDATE" || normalized === "INTENDED_CHANGE") return "FEATURE_CHANGE";
  if (normalized === "SCRIPT_FAILURE" || normalized === "AUTOMATION_ISSUE") return "SCRIPT_ISSUE";
  if (normalized === "ENV_ISSUE" || normalized === "INFRA_ISSUE") return "ENVIRONMENT_ISSUE";
  // Legacy fallback: map old TEST_FAILURE to SCRIPT_ISSUE
  if (normalized === "TEST_FAILURE") return "SCRIPT_ISSUE";
  return null;
}

function clampConfidence(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(100, Math.round(n)));
}

// Selenium / WebDriver element-wait signals. Order matters: we MUST check these
// before any generic "timeout" / "504" / "command duration" pattern, because a
// `findElement` that exceeds its wait surfaces as a gateway timeout from the
// grid — the bare word "timeout" in the message is not an infrastructure signal
// in that case, it's an unfound element. Misclassifying it as ENVIRONMENT_ISSUE
// hides real script breakage behind an infra label.
const ELEMENT_NOT_FOUND_RE =
  /(no such element|element not found|could not be located|element is not (?:visible|interactable|attached|displayed)|stale element|detached from dom|waiting for (?:selector|locator|element)|element click intercepted|invalid selector|findelement|nosuchelementexception|elementnotvisibleexception|elementnotinteractableexception|staleelementreferenceexception|timeoutexception.*element|wait_until_element|verify.*display|verify.*visible)/i;

// Real infrastructure / environment signals only. Deliberately excludes the
// bare token "timeout" — that word also appears in element-wait failures, which
// are SCRIPT_ISSUE not ENVIRONMENT_ISSUE.
const INFRA_RE =
  /(econnrefused|connection refused|enotfound|getaddrinfo|dns(?:\s+lookup)?|service unavailable|\b503\b|browser (?:crashed|disconnected|window closed)|session (?:not created|deleted|expired|id is null)|chromedriver (?:not found|crashed|not reachable)|webdriver (?:not reachable|exception.*unreachable)|grid (?:unreachable|down|not available)|unable to connect|connection reset|net::err|certificate|out of memory|\boom\b|node not available|no available node)/i;

// Network-level timeouts that are NOT element waits. Requires the timeout to
// be qualified by a network/IO context word so we don't catch Selenium's
// "Command duration or timeout" string for findElement.
const NETWORK_TIMEOUT_RE =
  /(etimedout|connection timed out|tunnel timeout|fetch timeout|request timed out|read timeout|socket hang up|socket timeout|gateway timeout(?!.*findelement)|upstream timeout)/i;

function computeStatusTransitions(statuses) {
  let transitions = 0;
  for (let i = 1; i < statuses.length; i += 1) {
    if (statuses[i] !== statuses[i - 1]) transitions += 1;
  }
  return transitions;
}

function summarizeHistorySignals(history) {
  const statuses = (history || []).map((h) => h.status).filter(Boolean);
  const passed = statuses.filter((s) => s === "Passed").length;
  const failed = statuses.filter((s) => s === "Failed").length;
  const transitions = computeStatusTransitions(statuses);
  const transitionRatio =
    statuses.length > 1 ? transitions / (statuses.length - 1) : 0;
  // Flaky: enough samples, both outcomes present, switches often.
  const isFlaky =
    statuses.length >= 4 && passed > 0 && failed > 0 && transitionRatio > 0.4;
  // Recently passing: at least 2 of the last 3 runs (excluding current) passed.
  const recentlyPassing =
    statuses.slice(0, 3).filter((s) => s === "Passed").length >= 2;
  return { passed, failed, isFlaky, recentlyPassing, sampleSize: statuses.length };
}

function classifyFailureDeterministically(test, history = []) {
  const message = String(test.error_message || "");
  const stack = String(test.error_stack || "");
  const merged = `${message}\n${stack}`;

  const signals = summarizeHistorySignals(history);
  const isElementIssue = ELEMENT_NOT_FOUND_RE.test(merged);
  const isInfraIssue = INFRA_RE.test(merged);
  const isNetworkTimeout = !isElementIssue && NETWORK_TIMEOUT_RE.test(merged);

  if (isElementIssue) {
    if (signals.isFlaky) {
      return {
        category: "SCRIPT_ISSUE",
        summary:
          "Possible flaky test — element locator pass/fails intermittently across recent runs. Investigate sync/wait strategy.",
        confidence: 60,
      };
    }
    if (signals.recentlyPassing) {
      return {
        category: "SCRIPT_ISSUE",
        summary:
          "Possible bug — test was passing in recent runs but element is no longer found. UI may have changed or the app element is missing.",
        confidence: 65,
      };
    }
    return {
      category: "SCRIPT_ISSUE",
      summary:
        "Element not found / locator failure — automation script issue (stale selector or wait strategy).",
      confidence: 72,
    };
  }

  if (isInfraIssue || isNetworkTimeout) {
    return {
      category: "ENVIRONMENT_ISSUE",
      summary: signals.isFlaky
        ? "Intermittent infrastructure failure — network/grid/browser session unstable across recent runs."
        : "Infrastructure failure — environment unavailable, browser crashed, or grid not reachable.",
      confidence: 68,
    };
  }

  if (/expected|to equal|assert|assertion|mismatch|received/i.test(merged)) {
    if (signals.isFlaky) {
      return {
        category: "SCRIPT_ISSUE",
        summary:
          "Possible flaky assertion — pass/fail switches frequently in recent history.",
        confidence: 58,
      };
    }
    if (signals.passed > signals.failed) {
      return {
        category: "ACTUAL_BUG",
        summary:
          "Possible bug — recent pass history with a fresh assertion mismatch points to a product regression.",
        confidence: 64,
      };
    }
    return {
      category: "SCRIPT_ISSUE",
      summary:
        "Assertion mismatch likely originates from brittle test expectations or data setup.",
      confidence: 58,
    };
  }

  return null;
}

function buildRunUrl(projectId, runId) {
  const base = (config.frontendUrl || "").replace(/\/+$/, "");
  if (!base || !projectId || !runId) return null;
  return `${base}/projects/${projectId}/tesbo-reports/runs/${runId}`;
}

function formatRun(r) {
  return {
    id: r.id,
    executionRunId: r.execution_run_id,
    runName: r.run_name,
    sourceType: r.source_type,
    status: r.status,
    totalTests: r.total_tests,
    passed: r.passed,
    failed: r.failed,
    skipped: r.skipped,
    durationMs: r.duration_ms,
    startedAt: r.started_at,
    completedAt: r.completed_at,
    createdAt: r.created_at,
    aiAnalysisEnabled: r.ai_analysis_enabled,
    releaseRiskScore: r.release_risk_score,
    releaseRiskLevel: r.release_risk_level,
    releaseRiskBreakdown: r.release_risk_breakdown,
    releaseRiskUpdatedAt: r.release_risk_updated_at,
    publicShareEnabled: r.public_share_enabled || false,
    publicShareToken: r.public_share_token || null,
  };
}

function formatTest(t) {
  return {
    id: t.id,
    spec: t.spec,
    name: t.name,
    fullTitle: t.full_title,
    status: t.status,
    durationMs: t.duration_ms,
    errorMessage: t.error_message,
    errorStack: t.error_stack,
    attempt: t.attempt,
    projectName: t.project_name,
    tags: t.tags,
    traceUrl: t.trace_url,
    screenshotUrl: t.screenshot_url,
    videoUrl: t.video_url,
    steps: t.steps,
    createdAt: t.created_at,
    aiAnalysisStatus: t.ai_analysis_status,
    aiAnalysisCategory: t.ai_analysis_category,
    aiAnalysisSummary: t.ai_analysis_summary,
    aiAnalysisConfidence: t.ai_analysis_confidence,
    aiAnalysisModel: t.ai_analysis_model,
    aiAnalysisUpdatedAt: t.ai_analysis_updated_at,
    aiAnalysisPromptVersion: t.ai_analysis_prompt_version,
    isProbableRegression: t.is_probable_regression === true,
    regressionConfidence: t.regression_confidence,
    regressionPassStreakBeforeFail: t.regression_pass_streak_before_fail,
    regressionFirstSeenRunId: t.regression_first_seen_run_id,
    regressionHint: t.regression_hint,
    // Selenium session linkage — null on tests we couldn't correlate.
    seleniumSessionId: t.selenium_session_id || null,
    seleniumSessionStatus: t.selenium_session_status || null,
    seleniumSessionVideoUrl: t.selenium_session_video_url || null,
    // True iff the linked session is still active AND a node has been
    // discovered (so the live VNC tunnel will succeed). Defaults to false.
    seleniumSessionLiveAvailable: false,
  };
}

/**
 * Hydrates `formatTest` output with the latest Selenium session status.
 * `byId` maps `selenium_session_id` -> session DTO (the same shape returned
 * by the runner-api). For tests with no link or no fresh status we fall back
 * to whatever was cached on the row at ingest time.
 */
function formatTestWithSession(row, byId) {
  const dto = formatTest(row);
  if (!dto.seleniumSessionId) return dto;
  const live = byId.get(dto.seleniumSessionId) || null;
  if (live) {
    dto.seleniumSessionStatus = live.status || dto.seleniumSessionStatus;
    dto.seleniumSessionLiveAvailable = !!live.liveAvailable;
    // Sessions only get a recorded mp4 once they're finalised — overwrite
    // any cached URL so we never advertise a 404 link to the user.
    dto.seleniumSessionVideoUrl =
      live.videoUrl || buildSeleniumSessionVideoUrl(dto.seleniumSessionId);
  } else if (!dto.seleniumSessionVideoUrl) {
    // Live lookup failed — best-effort fallback to the conventional URL,
    // but only when artifact storage is actually configured (the helper
    // returns null otherwise).
    dto.seleniumSessionVideoUrl = buildSeleniumSessionVideoUrl(
      dto.seleniumSessionId
    );
  }
  return dto;
}

/**
 * Fetch fresh status for every distinct Selenium session referenced by the
 * given test rows. We do one HTTP request per session; if you find this is
 * the bottleneck on huge runs (>1000 distinct sessions) the runner-api can
 * grow a bulk endpoint. Today most CI runs reuse a handful of sessions.
 */
async function refreshSeleniumSessionStatuses(projectId, testRows) {
  const ids = new Set();
  for (const row of testRows) {
    if (row.selenium_session_id) ids.add(String(row.selenium_session_id));
  }
  if (ids.size === 0 || !config.executionApiUrl) return new Map();

  const out = new Map();
  await Promise.all(
    Array.from(ids).map(async (seleniumId) => {
      try {
        const upstream = await fetch(
          `${config.executionApiUrl}/api/internal/selenium-sessions/${encodeURIComponent(
            seleniumId
          )}?projectId=${encodeURIComponent(projectId)}`,
          {
            method: "GET",
            headers: {
              ...(config.executionApiSharedToken
                ? { "x-agent-token": config.executionApiSharedToken }
                : {}),
            },
          }
        );
        if (!upstream.ok) return;
        const payload = await upstream.json().catch(() => null);
        const session = payload?.session;
        if (!session) return;
        // Decorate with a videoUrl mirroring the live-session BFF logic so
        // ended sessions get a replay link without a second round-trip.
        if (
          session.status === "ended" ||
          session.status === "abandoned" ||
          session.status === "failed"
        ) {
          session.videoUrl =
            session.videoUrl || buildSeleniumSessionVideoUrl(seleniumId);
        }
        out.set(seleniumId, session);
      } catch (err) {
        logger.debug("session_status_refresh_failed", {
          error: err instanceof Error ? err.message : String(err),
          seleniumId,
        });
      }
    })
  );
  return out;
}

// ── Public sharing endpoints ──────────────────────────────────────────────

// Enable/disable public sharing for a run
router.patch("/:projectId/tesbo-reports/runs/:runId/public-share", requireAuth, async (req, res) => {
  try {
    const { projectId, runId } = req.params;
    const { enabled } = req.body;
    
    if (typeof enabled !== 'boolean') {
      return res.status(400).json({ error: "enabled field is required and must be a boolean" });
    }

    // Check if run exists and belongs to project
    const runResult = await query(
      "SELECT id, public_share_enabled, public_share_token FROM report_runs WHERE id = $1 AND project_id = $2",
      [runId, projectId]
    );
    
    if (runResult.rows.length === 0) {
      return res.status(404).json({ error: "Run not found" });
    }

    const run = runResult.rows[0];
    let token = run.public_share_token;

    if (enabled) {
      // Generate a new token if enabling and no token exists
      if (!token) {
        token = crypto.randomBytes(32).toString('hex');
      }
      
      await query(
        "UPDATE report_runs SET public_share_enabled = TRUE, public_share_token = $1 WHERE id = $2",
        [token, runId]
      );
    } else {
      // Disable public sharing
      await query(
        "UPDATE report_runs SET public_share_enabled = FALSE WHERE id = $1",
        [runId]
      );
    }

    res.json({
      enabled,
      publicUrl: enabled ? `${config.frontendUrl || 'http://localhost:3000'}/public/runs/${token}` : null
    });
  } catch (err) {
    logger.error("Toggle public share error:", err);
    res.status(500).json({ error: "Failed to toggle public sharing" });
  }
});

// Public endpoint to view run details without authentication
router.get("/public/runs/:token", async (req, res) => {
  try {
    const { token } = req.params;
    
    if (!token || typeof token !== 'string' || token.length !== 64) {
      return res.status(404).json({ error: "Invalid or missing token" });
    }

    const runResult = await query(
      `SELECT id, project_id, execution_run_id, run_name, source_type, status,
              total_tests, passed, failed, skipped, duration_ms,
              started_at, completed_at, created_at
       FROM report_runs
       WHERE public_share_token = $1 AND public_share_enabled = TRUE`,
      [token]
    );
    
    if (runResult.rows.length === 0) {
      return res.status(404).json({ error: "Run not found or sharing not enabled" });
    }

    const run = runResult.rows[0];

    // Get tests for the run (excluding sensitive information)
    const testsResult = await query(
      `SELECT id, spec, name, full_title, status, duration_ms,
              error_message, error_stack, attempt, project_name,
              tags, trace_url, screenshot_url, video_url, steps, created_at
       FROM report_tests
       WHERE report_run_id = $1
       ORDER BY spec, name`,
      [run.id]
    );

    res.json({
      ...formatRun(run),
      tests: testsResult.rows.map(formatTest),
      isPublicView: true
    });
  } catch (err) {
    logger.error("Public run view error:", err);
    res.status(500).json({ error: "Failed to load run" });
  }
});

export default router;
