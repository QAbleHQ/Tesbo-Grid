import { Router } from "express";
import crypto from "node:crypto";
import { query, transaction } from "../db/database.js";
import { requireAuth } from "../middleware/session.js";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { buildSeleniumSessionVideoUrl } from "../artifactStorage.js";

const router = Router();

// Once a project is created, framework/language/defaultBrowser are immutable.
// PATCH requests that try to change them are silently stripped and logged.
// To allow legacy projects (settings = {}) to set these once, callers can pass
// `lockMissingStackKeys: true` and only the still-absent keys will be written.
export const SETTINGS_IMMUTABLE_KEYS = ["framework", "language", "defaultBrowser"];

// Hard upper bound for the per-project Selenium concurrency cap. Keeps a
// runaway PATCH from setting absurd values that the cluster could never serve
// anyway (today: 60 chrome pods × 4 sessions = 240 slots — see
// infra/kubernetes/selenium-node-chrome-scaledobject.yaml). Also gives us a
// single place to bump if the underlying cluster ceiling changes.
export const MAX_CONCURRENT_SESSIONS_CEILING = 1000;

// Validate the optional `maxConcurrentSessions` field on PATCH bodies. Returns
// `{ ok: true, value }` where `value` is a non-negative integer (0 means
// "unlimited" — same convention as the proxy's env-var default), or
// `{ ok: false, error }` for malformed input.
export function validateMaxConcurrentSessions(input) {
  if (input === null) return { ok: true, value: null };
  const n = Number(input);
  if (!Number.isInteger(n) || n < 0) {
    return { ok: false, error: "maxConcurrentSessions must be a non-negative integer (0 = unlimited)" };
  }
  if (n > MAX_CONCURRENT_SESSIONS_CEILING) {
    return {
      ok: false,
      error: `maxConcurrentSessions cannot exceed ${MAX_CONCURRENT_SESSIONS_CEILING}`,
    };
  }
  return { ok: true, value: n };
}

const ALLOWED_FRAMEWORKS = new Set(["playwright", "selenium"]);
const ALLOWED_LANGUAGES_BY_FRAMEWORK = {
  playwright: new Set(["javascript", "typescript", "python", "java"]),
  selenium: new Set(["java", "python"]),
};
const ALLOWED_BROWSERS = new Set(["chrome", "firefox", "edge"]);

function normalizeStackInput(input) {
  if (!input || typeof input !== "object") return null;
  const framework = typeof input.framework === "string" ? input.framework.toLowerCase() : null;
  const language = typeof input.language === "string" ? input.language.toLowerCase() : null;
  const defaultBrowser = typeof input.defaultBrowser === "string"
    ? input.defaultBrowser.toLowerCase()
    : null;
  return { framework, language, defaultBrowser };
}

export function validateProjectStack(stack) {
  if (!stack) return { ok: false, error: "framework, language, and defaultBrowser are required" };
  const { framework, language, defaultBrowser } = stack;
  if (!framework || !ALLOWED_FRAMEWORKS.has(framework)) {
    return { ok: false, error: "framework must be one of: playwright, selenium" };
  }
  const allowedLanguages = ALLOWED_LANGUAGES_BY_FRAMEWORK[framework];
  if (!language || !allowedLanguages.has(language)) {
    return {
      ok: false,
      error: `language for ${framework} must be one of: ${Array.from(allowedLanguages).join(", ")}`,
    };
  }
  if (!defaultBrowser || !ALLOWED_BROWSERS.has(defaultBrowser)) {
    return { ok: false, error: "defaultBrowser must be one of: chrome, firefox, edge" };
  }
  return { ok: true, value: { framework, language, defaultBrowser } };
}

async function getUserOrgId(userId) {
  const result = await query(
    "SELECT organization_id FROM organization_members WHERE user_id = $1 LIMIT 1",
    [userId]
  );
  return result.rows[0]?.organization_id ?? null;
}

async function getProjectAccess(projectId, userId) {
  const result = await query(
    `SELECT ep.id, ep.organization_id, epm.role
     FROM execute_projects ep
     JOIN execute_project_members epm
       ON epm.execute_project_id = ep.id
      AND epm.user_id = $2
     WHERE ep.id = $1
       AND ep.archived_at IS NULL
     LIMIT 1`,
    [projectId, userId]
  );
  return result.rows[0] ?? null;
}

async function requireProjectMember(req, res, next) {
  try {
    const access = await getProjectAccess(req.params.id, req.userId);
    if (!access) return res.status(403).json({ error: "Project access required" });
    req.projectAccess = access;
    next();
  } catch (err) {
    logger.error("Project member access check error:", err);
    res.status(500).json({ error: "Failed to validate access" });
  }
}

async function requireProjectAdmin(req, res, next) {
  try {
    const access = await getProjectAccess(req.params.id, req.userId);
    if (!access) return res.status(403).json({ error: "Project access required" });
    if (!["owner", "admin"].includes(access.role)) {
      return res.status(403).json({ error: "Admin access required" });
    }
    req.projectAccess = access;
    next();
  } catch (err) {
    logger.error("Project admin access check error:", err);
    res.status(500).json({ error: "Failed to validate access" });
  }
}

function generateProjectKey(name) {
  return (
    name
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, "")
      .slice(0, 6) || "EXEC"
  );
}

async function provisionApiKey(projectId, projectName) {
  if (!config.executionApiUrl) return null;
  try {
    const res = await fetch(`${config.executionApiUrl}/api/apikeys`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(config.executionApiSharedToken
          ? { "x-agent-token": config.executionApiSharedToken }
          : {}),
      },
      body: JSON.stringify({
        name: `${projectName} - Default`,
        projectId,
        scopes: ["runs:write", "runs:read", "queue:read"],
      }),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch (err) {
    logger.warn("Failed to provision execution API key:", err.message);
    return null;
  }
}

// --- List projects ---
router.get("/", requireAuth, async (req, res) => {
  try {
    const orgId = await getUserOrgId(req.userId);
    if (!orgId) return res.json([]);

    const result = await query(
      `SELECT ep.id, ep.key, ep.name, ep.description, ep.settings, ep.is_demo, epm.role, ep.created_at,
              (SELECT COUNT(*) FROM tesbox_execute_project_links tl WHERE tl.execute_project_id = ep.id) AS linked_tesbox_projects
       FROM execute_projects ep
       JOIN execute_project_members epm ON epm.execute_project_id = ep.id AND epm.user_id = $1
       WHERE ep.organization_id = $2 AND ep.archived_at IS NULL
       ORDER BY ep.created_at DESC`,
      [req.userId, orgId]
    );
    res.json(
      result.rows.map((r) => ({
        id: r.id,
        key: r.key,
        name: r.name,
        description: r.description,
        settings: r.settings,
        isDemo: r.is_demo,
        role: r.role,
        linkedTesboxProjects: Number(r.linked_tesbox_projects),
        createdAt: r.created_at,
      }))
    );
  } catch (err) {
    logger.error("GET projects error:", err);
    res.status(500).json({ error: "Failed to list projects" });
  }
});

// --- Create project ---
router.post("/", requireAuth, async (req, res) => {
  try {
    const orgId = await getUserOrgId(req.userId);
    if (!orgId) {
      return res.status(400).json({ error: "Create a workspace first" });
    }
    const { key, name, description } = req.body || {};
    if (!name || typeof name !== "string") {
      return res.status(400).json({ error: "Project name is required" });
    }
    const stackValidation = validateProjectStack(normalizeStackInput(req.body));
    if (!stackValidation.ok) {
      return res.status(400).json({ error: stackValidation.error });
    }
    const projectKey = (key || generateProjectKey(name)).toUpperCase().trim();
    const initialSettings = { ...stackValidation.value };

    const result = await transaction(async (client) => {
      const proj = await client.query(
        `INSERT INTO execute_projects (organization_id, key, name, description, settings)
         VALUES ($1, $2, $3, $4, $5) RETURNING id, key, name, description, settings, created_at`,
        [orgId, projectKey, name.trim(), description || null, JSON.stringify(initialSettings)]
      );
      const p = proj.rows[0];

      await client.query(
        `INSERT INTO execute_project_members (execute_project_id, user_id, role)
         VALUES ($1, $2, 'admin')`,
        [p.id, req.userId]
      );

      return p;
    });

    const apiKey = await provisionApiKey(result.id, result.name);

    res.json({
      id: result.id,
      key: result.key,
      name: result.name,
      description: result.description,
      settings: result.settings,
      createdAt: result.created_at,
      ...(apiKey ? { initialApiKey: apiKey } : {}),
    });
  } catch (err) {
    if (err.code === "23505") {
      return res.status(409).json({ error: "Project key already exists" });
    }
    logger.error("POST projects error:", err);
    res.status(500).json({ error: "Failed to create project" });
  }
});

// --- Get project ---
router.get("/:id", requireAuth, async (req, res) => {
  try {
    const result = await query(
      `SELECT ep.id, ep.key, ep.name, ep.description, ep.settings, ep.created_at, ep.updated_at,
              epm.role, ep.organization_id
       FROM execute_projects ep
       JOIN execute_project_members epm ON epm.execute_project_id = ep.id AND epm.user_id = $1
       WHERE ep.id = $2 AND ep.archived_at IS NULL`,
      [req.userId, req.params.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Project not found" });
    }
    const r = result.rows[0];
    res.json({
      id: r.id,
      key: r.key,
      name: r.name,
      description: r.description,
      settings: r.settings,
      role: r.role,
      organizationId: r.organization_id,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    });
  } catch (err) {
    logger.error("GET project error:", err);
    res.status(500).json({ error: "Failed to get project" });
  }
});

// --- Update project ---
router.patch("/:id", requireAuth, async (req, res) => {
  try {
    const { name, description, settings, lockMissingStackKeys } = req.body || {};
    const sets = [];
    const params = [];
    let idx = 1;
    if (name !== undefined) {
      sets.push(`name = $${idx++}`);
      params.push(name);
    }
    if (description !== undefined) {
      sets.push(`description = $${idx++}`);
      params.push(description);
    }

    if (settings !== undefined) {
      let parsedIncoming = settings;
      if (typeof parsedIncoming === "string") {
        try {
          parsedIncoming = JSON.parse(parsedIncoming);
        } catch {
          parsedIncoming = {};
        }
      }
      if (!parsedIncoming || typeof parsedIncoming !== "object") parsedIncoming = {};

      const existing = await query(
        `SELECT settings FROM execute_projects ep
         WHERE ep.id = $1
           AND ep.id IN (SELECT execute_project_id FROM execute_project_members
                         WHERE user_id = $2 AND role IN ('admin', 'owner'))`,
        [req.params.id, req.userId]
      );
      const existingSettings = existing.rows[0]?.settings || {};

      const droppedKeys = [];
      for (const key of SETTINGS_IMMUTABLE_KEYS) {
        if (!(key in parsedIncoming)) continue;
        const isMissing = existingSettings[key] === undefined || existingSettings[key] === null;
        if (lockMissingStackKeys && isMissing) {
          continue;
        }
        droppedKeys.push(key);
        delete parsedIncoming[key];
      }
      if (droppedKeys.length > 0) {
        logger.warn(
          `PATCH project ${req.params.id}: stripped immutable keys ${droppedKeys.join(", ")}`
        );
      }

      if ("maxConcurrentSessions" in parsedIncoming) {
        const capValidation = validateMaxConcurrentSessions(parsedIncoming.maxConcurrentSessions);
        if (!capValidation.ok) {
          return res.status(400).json({ error: capValidation.error });
        }
        // Normalise null → field removed (so the proxy falls back to the env
        // default rather than enforcing 0 = unlimited unintentionally).
        if (capValidation.value === null) {
          delete parsedIncoming.maxConcurrentSessions;
          delete existingSettings.maxConcurrentSessions;
        } else {
          parsedIncoming.maxConcurrentSessions = capValidation.value;
        }
      }

      let mergedSettings = { ...existingSettings, ...parsedIncoming };

      if (lockMissingStackKeys) {
        const stackCandidate = {
          framework: mergedSettings.framework,
          language: mergedSettings.language,
          defaultBrowser: mergedSettings.defaultBrowser,
        };
        const validation = validateProjectStack(normalizeStackInput(stackCandidate));
        if (!validation.ok) {
          return res.status(400).json({ error: validation.error });
        }
        mergedSettings = { ...mergedSettings, ...validation.value };
      }

      sets.push(`settings = $${idx++}`);
      params.push(JSON.stringify(mergedSettings));
    }

    if (sets.length === 0) {
      return res.status(400).json({ error: "No fields to update" });
    }
    sets.push(`updated_at = now()`);
    params.push(req.params.id);
    params.push(req.userId);

    await query(
      `UPDATE execute_projects SET ${sets.join(", ")}
       WHERE id = $${idx++}
       AND id IN (SELECT execute_project_id FROM execute_project_members WHERE user_id = $${idx} AND role IN ('admin', 'owner'))`,
      params
    );
    res.json({ ok: true });
  } catch (err) {
    logger.error("PATCH project error:", err);
    res.status(500).json({ error: "Failed to update project" });
  }
});

// --- Delete project ---
router.delete("/:id", requireAuth, async (req, res) => {
  try {
    await query(
      `DELETE FROM execute_projects
       WHERE id = $1
       AND id IN (SELECT execute_project_id FROM execute_project_members WHERE user_id = $2 AND role IN ('admin', 'owner'))`,
      [req.params.id, req.userId]
    );
    res.json({ ok: true });
  } catch (err) {
    logger.error("DELETE project error:", err);
    res.status(500).json({ error: "Failed to delete project" });
  }
});

// --- Project members ---
router.get("/:id/members", requireAuth, requireProjectMember, async (req, res) => {
  try {
    const result = await query(
      `SELECT epm.user_id AS "userId", u.email, u.name, epm.role, epm.created_at AS "joinedAt"
       FROM execute_project_members epm
       JOIN users u ON u.id = epm.user_id
       WHERE epm.execute_project_id = $1
       ORDER BY epm.created_at`,
      [req.params.id]
    );
    res.json(result.rows);
  } catch (err) {
    logger.error("GET project members error:", err);
    res.status(500).json({ error: "Failed to list members" });
  }
});

router.post("/:id/members", requireAuth, requireProjectAdmin, async (req, res) => {
  try {
    const { userId: targetUserId, role = "member" } = req.body || {};
    if (!targetUserId) {
      return res.status(400).json({ error: "userId is required" });
    }
    await query(
      `INSERT INTO execute_project_members (execute_project_id, user_id, role)
       VALUES ($1, $2, $3)
       ON CONFLICT (execute_project_id, user_id) DO UPDATE SET role = $3`,
      [req.params.id, targetUserId, role]
    );
    res.json({ ok: true });
  } catch (err) {
    logger.error("POST project members error:", err);
    res.status(500).json({ error: "Failed to add member" });
  }
});

router.delete("/:id/members/:userId", requireAuth, requireProjectAdmin, async (req, res) => {
  try {
    if (req.params.userId === req.userId) {
      return res.status(400).json({ error: "Cannot remove yourself" });
    }
    await query(
      "DELETE FROM execute_project_members WHERE execute_project_id = $1 AND user_id = $2",
      [req.params.id, req.params.userId]
    );
    res.json({ ok: true });
  } catch (err) {
    logger.error("DELETE project member error:", err);
    res.status(500).json({ error: "Failed to remove member" });
  }
});

router.get("/:id/invitations", requireAuth, requireProjectMember, async (req, res) => {
  try {
    const result = await query(
      `SELECT id, email, role, expires_at AS "expiresAt", created_at AS "createdAt"
       FROM execute_project_invitations
       WHERE execute_project_id = $1
         AND accepted_at IS NULL
       ORDER BY created_at DESC`,
      [req.params.id]
    );
    res.json(result.rows);
  } catch (err) {
    logger.error("GET project invitations error:", err);
    res.status(500).json({ error: "Failed to list invitations" });
  }
});

router.post("/:id/invitations", requireAuth, requireProjectAdmin, async (req, res) => {
  try {
    const { email, role = "member" } = req.body || {};
    if (!email || typeof email !== "string") {
      return res.status(400).json({ error: "email is required" });
    }

    const normalizedEmail = email.trim().toLowerCase();
    if (!normalizedEmail) {
      return res.status(400).json({ error: "email is required" });
    }

    const requestedRole = ["member", "admin"].includes(role) ? role : "member";
    const projectId = req.params.id;

    const existingMember = await query(
      `SELECT u.id
       FROM users u
       JOIN execute_project_members epm
         ON epm.user_id = u.id
        AND epm.execute_project_id = $1
       WHERE LOWER(u.email) = $2
       LIMIT 1`,
      [projectId, normalizedEmail]
    );
    if (existingMember.rows.length > 0) {
      return res.status(409).json({ error: "User is already a project member" });
    }

    const existingUser = await query(
      `SELECT id
       FROM users
       WHERE LOWER(email) = $1
       LIMIT 1`,
      [normalizedEmail]
    );
    if (existingUser.rows.length > 0) {
      const targetUserId = existingUser.rows[0].id;
      const organizationId = req.projectAccess.organization_id;

      await query(
        `INSERT INTO organization_members (organization_id, user_id, role)
         VALUES ($1, $2, 'member')
         ON CONFLICT (organization_id, user_id) DO NOTHING`,
        [organizationId, targetUserId]
      );

      await query(
        `INSERT INTO execute_project_members (execute_project_id, user_id, role)
         VALUES ($1, $2, $3)
         ON CONFLICT (execute_project_id, user_id) DO UPDATE SET role = $3`,
        [projectId, targetUserId, requestedRole]
      );

      return res.json({ mode: "member_added" });
    }

    const expiresAt = new Date(Date.now() + 7 * 86400 * 1000);
    const token = crypto.randomUUID();

    const existingInvitation = await query(
      `SELECT id
       FROM execute_project_invitations
       WHERE execute_project_id = $1
         AND email = $2
         AND accepted_at IS NULL
       ORDER BY created_at DESC
       LIMIT 1`,
      [projectId, normalizedEmail]
    );

    let invitation;
    if (existingInvitation.rows.length > 0) {
      const refreshed = await query(
        `UPDATE execute_project_invitations
         SET role = $3, token = $4, expires_at = $5, created_by = $6
         WHERE id = $1
           AND execute_project_id = $2
         RETURNING id, email, role, expires_at AS "expiresAt", created_at AS "createdAt"`,
        [
          existingInvitation.rows[0].id,
          projectId,
          requestedRole,
          token,
          expiresAt,
          req.userId,
        ]
      );
      invitation = refreshed.rows[0];
    } else {
      const created = await query(
        `INSERT INTO execute_project_invitations
           (organization_id, execute_project_id, email, role, token, expires_at, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id, email, role, expires_at AS "expiresAt", created_at AS "createdAt"`,
        [
          req.projectAccess.organization_id,
          projectId,
          normalizedEmail,
          requestedRole,
          token,
          expiresAt,
          req.userId,
        ]
      );
      invitation = created.rows[0];
    }

    res.json({
      mode: "invited",
      invitation,
    });
  } catch (err) {
    logger.error("POST project invitations error:", err);
    res.status(500).json({ error: "Failed to invite member" });
  }
});

router.delete(
  "/:id/invitations/:invitationId",
  requireAuth,
  requireProjectAdmin,
  async (req, res) => {
    try {
      await query(
        `DELETE FROM execute_project_invitations
         WHERE id = $1
           AND execute_project_id = $2`,
        [req.params.invitationId, req.params.id]
      );
      res.json({ ok: true });
    } catch (err) {
      logger.error("DELETE project invitation error:", err);
      res.status(500).json({ error: "Failed to revoke invitation" });
    }
  }
);

// --- Live Selenium sessions (read-only proxy to grid-runner-api) ---
//
// The selenium_sessions table lives in the runner-api / proxy database.
// We forward read requests through grid-backend so the dashboard talks to a
// single API and the project-membership check stays here.
router.get("/:id/selenium-sessions", requireAuth, requireProjectMember, async (req, res) => {
  if (!config.executionApiUrl) {
    return res.json({ sessions: [], count: 0 });
  }
  try {
    const params = new URLSearchParams({ projectId: req.params.id });
    if (req.query.status) params.set("status", String(req.query.status));
    if (req.query.build) params.set("build", String(req.query.build));
    if (req.query.limit) params.set("limit", String(req.query.limit));
    // Date-range filter for the dashboard's Completed tab. Accepts ISO 8601
    // or YYYY-MM-DD; the upstream parses both. Forwarded verbatim — the
    // runner-api validates and clamps.
    if (req.query.from) params.set("from", String(req.query.from));
    if (req.query.to) params.set("to", String(req.query.to));

    const upstream = await fetch(
      `${config.executionApiUrl}/api/internal/selenium-sessions?${params.toString()}`,
      {
        method: "GET",
        headers: {
          ...(config.executionApiSharedToken
            ? { "x-agent-token": config.executionApiSharedToken }
            : {}),
        },
      }
    );

    if (!upstream.ok) {
      logger.warn(
        `selenium-sessions upstream returned ${upstream.status} for project ${req.params.id}`
      );
      return res.status(upstream.status === 401 || upstream.status === 403 ? 502 : upstream.status).json(
        await upstream.json().catch(() => ({ error: "Upstream error" }))
      );
    }

    const payload = await upstream.json().catch(() => ({ sessions: [], count: 0 }));
    // Decorate completed sessions with a recorded-video URL so the dashboard
    // can offer a "watch replay" for ended/abandoned/failed runs. The
    // selenium-node uploader writes one mp4 per sessionId, so we just build
    // the predictable Spaces URL here — no DB join needed.
    if (Array.isArray(payload?.sessions)) {
      payload.sessions = payload.sessions.map(decorateSessionWithVideo);
    }
    res.json(payload);
  } catch (err) {
    logger.error("GET selenium-sessions error:", err);
    res.status(502).json({ error: "Failed to reach execution API" });
  }
});

// Single live-session detail for the dashboard's session viewer.
router.get(
  "/:id/selenium-sessions/:seleniumId",
  requireAuth,
  requireProjectMember,
  async (req, res) => {
    if (!config.executionApiUrl) {
      return res.status(404).json({ error: "Execution API not configured" });
    }
    try {
      const upstream = await fetchExecutionApi(
        `/api/internal/selenium-sessions/${encodeURIComponent(
          req.params.seleniumId
        )}?projectId=${encodeURIComponent(req.params.id)}`
      );
      const payload = await upstream.json().catch(() => ({}));
      if (!upstream.ok) {
        return res.status(upstream.status).json(payload);
      }
      if (payload?.session) {
        payload.session = decorateSessionWithVideo(payload.session);
      }
      res.json(payload);
    } catch (err) {
      logger.error("GET selenium-session detail error:", err);
      res.status(502).json({ error: "Failed to reach execution API" });
    }
  }
);

// Tail of webdriver commands captured by grid-selenium-proxy. The frontend
// long-polls this every ~1.5s to render the live commands feed; using a
// `since` cursor keeps the response payload small.
router.get(
  "/:id/selenium-sessions/:seleniumId/commands",
  requireAuth,
  requireProjectMember,
  async (req, res) => {
    if (!config.executionApiUrl) {
      return res.json({ commands: [], seleniumId: req.params.seleniumId });
    }
    try {
      const params = new URLSearchParams({ projectId: req.params.id });
      if (req.query.since) params.set("since", String(req.query.since));
      if (req.query.limit) params.set("limit", String(req.query.limit));
      const upstream = await fetchExecutionApi(
        `/api/internal/selenium-sessions/${encodeURIComponent(
          req.params.seleniumId
        )}/commands?${params.toString()}`
      );
      const payload = await upstream
        .json()
        .catch(() => ({ commands: [], seleniumId: req.params.seleniumId }));
      if (!upstream.ok) {
        return res.status(upstream.status).json(payload);
      }
      res.json(payload);
    } catch (err) {
      logger.error("GET selenium-session commands error:", err);
      res.status(502).json({ error: "Failed to reach execution API" });
    }
  }
);

// Linked test artifacts for a Selenium session. Drives the screenshot strip
// on the session detail page: every report_test that the linker wired up to
// this session is returned in chronological order, so users can scrub through
// the run's failure evidence without bouncing into tesbo-reports.
router.get(
  "/:id/selenium-sessions/:seleniumId/tests",
  requireAuth,
  requireProjectMember,
  async (req, res) => {
    try {
      const result = await query(
        `SELECT t.id, t.name, t.full_title, t.spec, t.status, t.duration_ms,
                t.error_message, t.screenshot_url, t.video_url, t.trace_url,
                t.created_at, t.report_run_id
           FROM report_tests t
           JOIN report_runs r ON r.id = t.report_run_id
          WHERE t.selenium_session_id = $1
            AND r.project_id = $2
          ORDER BY t.created_at ASC NULLS LAST, t.id ASC`,
        [req.params.seleniumId, req.params.id]
      );
      res.json({
        seleniumId: req.params.seleniumId,
        tests: result.rows.map((t) => ({
          id: t.id,
          runId: t.report_run_id,
          name: t.name,
          fullTitle: t.full_title,
          spec: t.spec,
          status: t.status,
          durationMs: t.duration_ms,
          errorMessage: t.error_message,
          screenshotUrl: t.screenshot_url,
          videoUrl: t.video_url,
          traceUrl: t.trace_url,
          createdAt: t.created_at,
        })),
      });
    } catch (err) {
      logger.error("GET selenium-session tests error:", err);
      res.status(500).json({ error: "Failed to load linked tests" });
    }
  }
);

async function fetchExecutionApi(path) {
  return fetch(`${config.executionApiUrl}${path}`, {
    method: "GET",
    headers: {
      ...(config.executionApiSharedToken
        ? { "x-agent-token": config.executionApiSharedToken }
        : {}),
    },
  });
}

// Add a `videoUrl` field to a Selenium session DTO. Only set for sessions
// that have actually concluded — live sessions don't have a finalised .mp4
// yet, and exposing a URL that 404s would be confusing in the dashboard.
function decorateSessionWithVideo(session) {
  if (!session) return session;
  const isCompleted =
    session.status === "ended" ||
    session.status === "abandoned" ||
    session.status === "failed";
  if (!isCompleted || !session.seleniumId) {
    return { ...session, videoUrl: null };
  }
  return {
    ...session,
    videoUrl: buildSeleniumSessionVideoUrl(session.seleniumId),
  };
}

// --- Bridge links (from TesboX) ---
router.get("/:id/links", requireAuth, async (req, res) => {
  try {
    const result = await query(
      `SELECT tl.id, tl.tesbox_project_id, tl.execute_project_id,
              tl.execute_project_key, tl.execute_api_key_id, tl.execute_api_key_name,
              tl.execute_api_key_masked, tl.status, tl.created_at, tl.updated_at,
              p.name AS tesbox_project_name, p.key AS tesbox_project_code
       FROM tesbox_execute_project_links tl
       JOIN projects p ON p.id = tl.tesbox_project_id
       WHERE tl.execute_project_id = $1`,
      [req.params.id]
    );
    res.json(
      result.rows.map((r) => ({
        id: r.id,
        tesboxProjectId: r.tesbox_project_id,
        executeProjectId: r.execute_project_id,
        executeProjectKey: r.execute_project_key,
        executeApiKeyId: r.execute_api_key_id,
        executeApiKeyName: r.execute_api_key_name,
        executeApiKeyMasked: r.execute_api_key_masked,
        status: r.status,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
        tesboxProjectName: r.tesbox_project_name,
        tesboxProjectCode: r.tesbox_project_code,
      }))
    );
  } catch (err) {
    logger.error("GET project links error:", err);
    res.status(500).json({ error: "Failed to list links" });
  }
});

export default router;
