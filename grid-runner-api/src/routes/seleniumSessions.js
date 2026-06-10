import { Router } from "express";
import { query } from "../db/database.js";
import { internalAuth } from "../middleware/auth.js";
import { logError } from "../logger.js";

// Live Sessions read API.
//
// The grid-selenium-proxy writes one row per WebDriver session into
// `selenium_sessions`. This endpoint surfaces those rows to the dashboard,
// gated by INTERNAL_SHARED_TOKEN so only grid-backend can call it on behalf
// of an authenticated dashboard user.
//
// Endpoints:
//   GET /                     — list sessions for a project
//   GET /:seleniumId          — single session detail
//   GET /:seleniumId/commands — recent webdriver commands captured by the proxy

const router = Router();

const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;
const MAX_COMMANDS_LIMIT = 500;
const DEFAULT_COMMANDS_LIMIT = 200;

const ALLOWED_STATUSES = new Set([
  "queued",
  "active",
  "ended",
  "abandoned",
  "failed",
]);

router.use(internalAuth(process.env.INTERNAL_SHARED_TOKEN || ""));

router.get("/", async (req, res) => {
  const projectId = String(req.query.projectId || "").trim();
  if (!projectId) {
    return res.status(400).json({ error: "projectId is required" });
  }

  const limit = clampLimit(req.query.limit, DEFAULT_LIMIT, MAX_LIMIT);
  // `status` accepts a single value OR a comma-separated list so the
  // dashboard can fetch "live" (queued,active) and "completed"
  // (ended,abandoned,failed) without two round-trips.
  const statuses = parseStatuses(req.query.status);
  const build = req.query.build ? String(req.query.build).trim() : null;
  const fromIso = parseIsoTimestamp(req.query.from);
  const toIso = parseIsoTimestamp(req.query.to);

  // List query filters apply on the rows we send back (status, date, build).
  // We keep a separate `countParams`/`countFilters` block (everything EXCEPT
  // status) so the per-status totals reflect the user's date/build selection
  // while ignoring the visible-status toggle. Without this the metric cards
  // would only ever count rows in the active tab and lose their cross-status
  // overview.
  const listFilters = ["project_id = $1"];
  const listParams = [projectId];
  const countFilters = ["project_id = $1"];
  const countParams = [projectId];

  if (statuses.length === 1) {
    listParams.push(statuses[0]);
    listFilters.push(`status = $${listParams.length}`);
  } else if (statuses.length > 1) {
    listParams.push(statuses);
    listFilters.push(`status = ANY($${listParams.length}::text[])`);
  }
  if (build) {
    listParams.push(build);
    listFilters.push(`tesbo_options->>'build' = $${listParams.length}`);
    countParams.push(build);
    countFilters.push(`tesbo_options->>'build' = $${countParams.length}`);
  }
  // Prefer `started_at` and fall back to `queued_at` so queued sessions
  // (which may not have started_at yet) show up in time-range scans.
  if (fromIso) {
    listParams.push(fromIso);
    listFilters.push(
      `COALESCE(started_at, queued_at) >= $${listParams.length}`
    );
    countParams.push(fromIso);
    countFilters.push(
      `COALESCE(started_at, queued_at) >= $${countParams.length}`
    );
  }
  if (toIso) {
    listParams.push(toIso);
    listFilters.push(
      `COALESCE(started_at, queued_at) <= $${listParams.length}`
    );
    countParams.push(toIso);
    countFilters.push(
      `COALESCE(started_at, queued_at) <= $${countParams.length}`
    );
  }

  listParams.push(limit);
  const limitIndex = listParams.length;

  try {
    const [listResult, countsResult] = await Promise.all([
      query(
        `SELECT id,
                selenium_id,
                request_id,
                project_id,
                api_key_id,
                started_at,
                queued_at,
                ended_at,
                status,
                capabilities,
                tesbo_options,
                duration_ms,
                end_reason,
                node_uri,
                last_activity_at
           FROM selenium_sessions
           WHERE ${listFilters.join(" AND ")}
           ORDER BY COALESCE(started_at, queued_at) DESC NULLS LAST
           LIMIT $${limitIndex}`,
        listParams
      ),
      // Status totals subject to the same date/build filters as the list,
      // but NOT the status filter — so the dashboard's metric cards reflect
      // the truth. Counting from a 100-row page made dead-but-not-yet-swept
      // rows dominate the cards.
      query(
        `SELECT status, COUNT(*)::int AS count
           FROM selenium_sessions
           WHERE ${countFilters.join(" AND ")}
           GROUP BY status`,
        countParams
      ),
    ]);

    const counts = { queued: 0, active: 0, ended: 0, abandoned: 0, failed: 0 };
    for (const row of countsResult.rows) {
      if (row.status in counts) counts[row.status] = Number(row.count) || 0;
    }

    res.json({
      sessions: listResult.rows.map(rowToDto),
      count: listResult.rowCount,
      counts,
    });
  } catch (err) {
    logError("selenium_sessions_list_error", {
      error: err instanceof Error ? err.message : String(err),
      projectId,
    });
    res.status(500).json({ error: "Failed to list selenium sessions" });
  }
});

router.get("/:seleniumId", async (req, res) => {
  const projectId = String(req.query.projectId || "").trim();
  const seleniumId = String(req.params.seleniumId || "").trim();
  if (!projectId || !seleniumId) {
    return res.status(400).json({ error: "projectId and seleniumId are required" });
  }
  try {
    const result = await query(
      `SELECT id,
              selenium_id,
              request_id,
              project_id,
              api_key_id,
              started_at,
              queued_at,
              ended_at,
              status,
              capabilities,
              tesbo_options,
              duration_ms,
              end_reason,
              node_uri,
              last_activity_at
         FROM selenium_sessions
        WHERE selenium_id = $1
          AND project_id  = $2`,
      [seleniumId, projectId]
    );
    if (!result.rows[0]) {
      return res.status(404).json({ error: "Session not found" });
    }
    res.json({ session: rowToDto(result.rows[0]) });
  } catch (err) {
    logError("selenium_session_detail_error", {
      error: err instanceof Error ? err.message : String(err),
      seleniumId,
    });
    res.status(500).json({ error: "Failed to load session" });
  }
});

router.get("/:seleniumId/commands", async (req, res) => {
  const projectId = String(req.query.projectId || "").trim();
  const seleniumId = String(req.params.seleniumId || "").trim();
  if (!projectId || !seleniumId) {
    return res.status(400).json({ error: "projectId and seleniumId are required" });
  }

  const limit = clampLimit(
    req.query.limit,
    DEFAULT_COMMANDS_LIMIT,
    MAX_COMMANDS_LIMIT
  );
  const since = Number(req.query.since);
  const sincePart = Number.isFinite(since) && since > 0
    ? `AND c.sequence > ${Math.floor(since)}`
    : "";

  try {
    // Verify session belongs to project.
    const ownership = await query(
      `SELECT 1 FROM selenium_sessions
        WHERE selenium_id = $1 AND project_id = $2 LIMIT 1`,
      [seleniumId, projectId]
    );
    if (!ownership.rows[0]) {
      return res.status(404).json({ error: "Session not found" });
    }

    const commandsResult = await query(
      `SELECT c.id,
              c.sequence,
              c.occurred_at,
              c.method,
              c.path,
              c.command,
              c.status,
              c.duration_ms,
              c.request_body,
              c.response_body,
              c.error
         FROM selenium_session_commands c
        WHERE c.selenium_id = $1
          ${sincePart}
        ORDER BY c.sequence ASC
        LIMIT $2`,
      [seleniumId, limit]
    );

    res.json({
      seleniumId,
      commands: commandsResult.rows.map((r) => ({
        id: String(r.id),
        sequence: r.sequence,
        occurredAt: r.occurred_at,
        method: r.method,
        path: r.path,
        command: r.command,
        status: r.status,
        durationMs: r.duration_ms,
        requestBody: r.request_body,
        responseBody: r.response_body,
        error: r.error,
      })),
    });
  } catch (err) {
    logError("selenium_session_commands_error", {
      error: err instanceof Error ? err.message : String(err),
      seleniumId,
    });
    res.status(500).json({ error: "Failed to load commands" });
  }
});

function clampLimit(raw, defaultValue, maxValue) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return defaultValue;
  return Math.min(Math.floor(n), maxValue);
}

// Accepts either a single status or a comma-separated list (e.g. "queued,active").
// Unknown entries are dropped silently rather than returning 400 — the dashboard
// occasionally sends shorthand group names ("live"/"completed") that we expand.
function parseStatuses(raw) {
  if (raw == null) return [];
  const tokens = String(raw)
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const expanded = [];
  for (const token of tokens) {
    if (token === "live") {
      expanded.push("queued", "active");
    } else if (token === "completed") {
      expanded.push("ended", "abandoned", "failed");
    } else if (ALLOWED_STATUSES.has(token)) {
      expanded.push(token);
    }
  }
  // De-dupe while preserving order so callers can rely on a stable shape.
  return Array.from(new Set(expanded));
}

// Allow either ISO 8601 strings ("2026-05-05T00:00:00Z") or YYYY-MM-DD dates
// (which we anchor at UTC midnight). Returns a Date instance suitable for
// passing to pg as a timestamptz, or null when the input is missing/invalid.
function parseIsoTimestamp(raw) {
  if (!raw) return null;
  const value = String(raw).trim();
  if (!value) return null;
  // YYYY-MM-DD is treated as UTC midnight rather than local — this keeps the
  // backend deterministic and matches the dashboard's ISO-day groupings.
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? `${value}T00:00:00Z`
    : value;
  const d = new Date(dateOnly);
  if (Number.isNaN(d.getTime())) return null;
  return d;
}

function rowToDto(r) {
  const tesboOptions = r.tesbo_options || {};
  const capabilities = r.capabilities || {};
  const startedAt = r.started_at;
  const endedAt = r.ended_at;
  const durationMs =
    r.duration_ms ??
    (endedAt && startedAt
      ? new Date(endedAt).getTime() - new Date(startedAt).getTime()
      : null);
  return {
    id: r.id,
    seleniumId: r.selenium_id,
    requestId: r.request_id,
    projectId: r.project_id,
    apiKeyId: r.api_key_id,
    startedAt: r.started_at,
    queuedAt: r.queued_at,
    endedAt: r.ended_at,
    lastActivityAt: r.last_activity_at || null,
    status: r.status,
    durationMs: typeof durationMs === "number" ? durationMs : null,
    endReason: r.end_reason,
    browser:
      capabilities.browserName ||
      capabilities.browser ||
      null,
    browserVersion: capabilities.browserVersion || null,
    platform: capabilities.platformName || capabilities.platform || null,
    build: tesboOptions.build || null,
    name: tesboOptions.name || null,
    tags: Array.isArray(tesboOptions.tags) ? tesboOptions.tags : [],
    // Live VNC is "available" whenever the session is active. We used to
    // additionally require `node_uri` to be populated here, but that
    // backfired: `node_uri` races the new-session response (the chromium
    // image doesn't always emit `se:vncLocalAddress` immediately, and the
    // hub's session-lookup API can be empty for the first few hundred ms).
    // The selenium-proxy's VNC upgrade handler does a *second* lazy
    // discovery on connect — so any active session is genuinely
    // watchable. Hiding the button until `node_uri` lands meant users
    // saw "Live view not available" indefinitely for sessions that the
    // proxy could have served fine. We surface `nodeUriKnown` as a hint
    // for the dashboard if it ever wants to show "discovering node…"
    // copy, but the gating is gone.
    liveAvailable: r.status === "active",
    nodeUriKnown: !!r.node_uri,
  };
}

export default router;
