import { Router } from "express";
import crypto from "node:crypto";
import { query } from "../db/database.js";
import { requireAuth } from "../middleware/session.js";
import { config } from "../config.js";
import { logger } from "../logger.js";

// Read the per-project Selenium concurrency cap out of execute_projects.settings.
// Returns a non-negative integer when the project has explicitly opted into a
// cap, or `null` to mean "no project-level override".
//
// The grid-selenium-proxy treats both `null` (no override) and `0` (explicit
// unlimited) as "no proxy-side cap" — only the cluster's node capacity
// applies. We still preserve the null-vs-zero distinction here so the
// dashboard can render the correct copy and so an operator can tell at a
// glance whether the project was explicitly configured for unlimited or
// just hasn't been touched.
function readMaxConcurrentSessions(settings) {
  if (!settings || typeof settings !== "object") return null;
  const raw = settings.maxConcurrentSessions;
  if (raw === null || raw === undefined || raw === "") return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) return null;
  return n;
}

function generateTesboKey() {
  return `tesbo_${crypto.randomBytes(24).toString("hex")}`;
}

// --- Project-scoped routes (mounted at /api/projects) ---

const projectRouter = Router();

projectRouter.get("/:id/access-key", requireAuth, async (req, res) => {
  try {
    const result = await query(
      `SELECT ep.settings
       FROM execute_projects ep
       JOIN execute_project_members epm ON epm.execute_project_id = ep.id AND epm.user_id = $1
       WHERE ep.id = $2 AND ep.archived_at IS NULL`,
      [req.userId, req.params.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Project not found" });
    }
    const settings = result.rows[0].settings || {};
    res.json({ ingestionApiKey: settings.ingestionApiKey || null });
  } catch (err) {
    logger.error("GET access-key error:", err);
    res.status(500).json({ error: "Failed to get access key" });
  }
});

projectRouter.post("/:id/access-key/rotate", requireAuth, async (req, res) => {
  try {
    const check = await query(
      `SELECT ep.id
       FROM execute_projects ep
       JOIN execute_project_members epm ON epm.execute_project_id = ep.id AND epm.user_id = $1
       WHERE ep.id = $2 AND ep.archived_at IS NULL
       AND epm.role IN ('admin', 'owner')`,
      [req.userId, req.params.id]
    );
    if (check.rows.length === 0) {
      return res.status(403).json({ error: "Admin access required" });
    }

    const newKey = generateTesboKey();
    await query(
      `UPDATE execute_projects
       SET settings = jsonb_set(COALESCE(settings, '{}'::jsonb), '{ingestionApiKey}', to_jsonb($1::text), true),
           updated_at = now()
       WHERE id = $2`,
      [newKey, req.params.id]
    );
    res.json({ ingestionApiKey: newKey });
  } catch (err) {
    logger.error("POST access-key/rotate error:", err);
    res.status(500).json({ error: "Failed to rotate access key" });
  }
});

// --- Key resolution route (mounted at /api/tesbo-reports) ---
// Called by grid-runner-api auth middleware to resolve tesbo_ keys to project IDs

const keyResolutionRouter = Router();

keyResolutionRouter.get("/project-by-key", async (req, res) => {
  const accessKey = req.header("x-project-access-key");
  if (!accessKey || !accessKey.startsWith("tesbo_")) {
    return res.status(401).json({ error: "Missing or invalid access key" });
  }
  try {
    const result = await query(
      `SELECT id, organization_id, settings FROM execute_projects
       WHERE settings ->> 'ingestionApiKey' = $1
       AND archived_at IS NULL
       LIMIT 1`,
      [accessKey]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: "No project found for this key" });
    }
    // We piggy-back the per-project Selenium concurrency cap on this response
    // because the selenium-proxy already calls /project-by-key on every
    // tesbo_ session-create. Returning the cap here lets the proxy enforce
    // the limit without an extra round-trip.
    const limits = {
      maxConcurrentSessions: readMaxConcurrentSessions(result.rows[0].settings),
    };
    // organizationId lets grid-runner-api stamp the owning org onto each run
    // for per-org concurrency, WITHOUT querying execute_projects directly —
    // that table lives only in this (grid-backend) database, so the runner
    // cannot reach it cross-database.
    res.json({
      projectId: result.rows[0].id,
      organizationId: result.rows[0].organization_id || null,
      limits,
    });
  } catch (err) {
    logger.error("project-by-key error:", err);
    res.status(500).json({ error: "Failed to resolve key" });
  }
});

// --- Internal limits route (mounted at /api/internal) ---
//
// Used by grid-selenium-proxy (and any other in-cluster service that needs to
// know a project's resource limits) to fetch caps for projects authenticated
// via a `txe_*` API key — those keys are resolved in-database by the proxy and
// never hit /project-by-key, so the proxy needs a separate way to fetch the
// limits row.
//
// Authenticated by the same shared token grid-backend uses for its own
// internal calls — the proxy is expected to send `x-agent-token`.
const internalRouter = Router();

function requireAgentToken(req, res, next) {
  const expected = config.executionApiSharedToken;
  if (!expected) {
    // Token unset means we're in dev/local — fall open. Production deploys set
    // EXECUTION_API_SHARED_TOKEN so this path is never hit there.
    return next();
  }
  const provided = req.header("x-agent-token");
  if (provided !== expected) {
    return res.status(401).json({ error: "Invalid agent token" });
  }
  return next();
}

internalRouter.get("/projects/:id/limits", requireAgentToken, async (req, res) => {
  try {
    const result = await query(
      `SELECT settings FROM execute_projects
       WHERE id = $1 AND archived_at IS NULL
       LIMIT 1`,
      [req.params.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Project not found" });
    }
    res.json({
      projectId: req.params.id,
      maxConcurrentSessions: readMaxConcurrentSessions(result.rows[0].settings),
    });
  } catch (err) {
    logger.error("GET internal project limits error:", err);
    res.status(500).json({ error: "Failed to fetch project limits" });
  }
});

export {
  projectRouter as accessKeyProjectRoutes,
  keyResolutionRouter as keyResolutionRoutes,
  internalRouter as projectInternalRoutes,
};
