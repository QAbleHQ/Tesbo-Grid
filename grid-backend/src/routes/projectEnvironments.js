import { Router } from "express";
import { query } from "../db/database.js";
import { requireAuth } from "../middleware/session.js";
import { logger } from "../logger.js";

const router = Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ENV_VAR_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_VARS_PER_ENV = 50;
const MAX_NAME_LEN = 60;
const MAX_VALUE_LEN = 4000;

function asyncHandler(label, handler) {
  return async (req, res, next) => {
    try {
      await handler(req, res, next);
    } catch (err) {
      logger.error(`${label} failed`, {
        message: err.message,
        code: err.code,
        stack: err.stack,
        projectId: req.params?.projectId,
        userId: req.userId,
      });
      if (!res.headersSent) {
        res.status(500).json({ error: `${label} failed`, detail: err.message });
      }
    }
  };
}

async function resolveProjectAccess(req) {
  const projectId = req.params.projectId;
  if (!projectId || !UUID_RE.test(projectId)) {
    return { error: { status: 400, message: "Invalid projectId" } };
  }
  if (!req.userId) {
    return { error: { status: 401, message: "Authentication required" } };
  }
  const r = await query(
    `SELECT epm.role
     FROM execute_project_members epm
     JOIN execute_projects ep ON ep.id = epm.execute_project_id
     WHERE epm.execute_project_id = $1
       AND epm.user_id = $2
       AND ep.archived_at IS NULL
     LIMIT 1`,
    [projectId, req.userId]
  );
  return { projectId, role: r.rows[0]?.role || null };
}

async function requireProjectMember(req, res, next) {
  const access = await resolveProjectAccess(req);
  if (access.error) {
    return res.status(access.error.status).json({ error: access.error.message });
  }
  if (!access.role) {
    return res.status(403).json({ error: "You don't have access to this project" });
  }
  req.projectId = access.projectId;
  req.projectRole = access.role;
  next();
}

async function requireProjectAdmin(req, res, next) {
  const access = await resolveProjectAccess(req);
  if (access.error) {
    return res.status(access.error.status).json({ error: access.error.message });
  }
  if (!access.role) {
    return res.status(403).json({ error: "You don't have access to this project" });
  }
  if (!["owner", "admin"].includes(access.role)) {
    return res.status(403).json({ error: "Admin access required" });
  }
  req.projectId = access.projectId;
  req.projectRole = access.role;
  next();
}

// ── Validation ──────────────────────────────────────────────────────────────

// Returns { ok: true, value: cleanedVariables } or { ok: false, error }.
// A "variable" is { key: "FOO", value: "bar", isSecret: false }. We accept
// the body as either an array of these objects, or an object map
// { FOO: "bar", BAZ: { value: "x", isSecret: true } } for convenience.
function normalizeVariables(input) {
  if (input == null) return { ok: true, value: [] };
  const out = [];
  const seen = new Set();

  function push(key, raw) {
    const trimmedKey = String(key || "").trim();
    if (!ENV_VAR_KEY_RE.test(trimmedKey)) {
      return { ok: false, error: `Invalid variable name "${trimmedKey}". Use letters, digits, and underscores; must not start with a digit.` };
    }
    if (trimmedKey.length > MAX_NAME_LEN) {
      return { ok: false, error: `Variable name "${trimmedKey}" exceeds ${MAX_NAME_LEN} characters` };
    }
    if (seen.has(trimmedKey)) {
      return { ok: false, error: `Duplicate variable "${trimmedKey}"` };
    }
    seen.add(trimmedKey);

    let value;
    let isSecret = false;
    if (raw && typeof raw === "object") {
      value = String(raw.value ?? "");
      isSecret = Boolean(raw.isSecret || raw.is_secret);
    } else {
      value = String(raw ?? "");
    }
    if (value.length > MAX_VALUE_LEN) {
      return { ok: false, error: `Value for "${trimmedKey}" exceeds ${MAX_VALUE_LEN} characters` };
    }
    out.push({ key: trimmedKey, value, isSecret });
    return null;
  }

  if (Array.isArray(input)) {
    for (const item of input) {
      if (!item || typeof item !== "object") continue;
      const err = push(item.key, item);
      if (err) return err;
    }
  } else if (typeof input === "object") {
    for (const [k, v] of Object.entries(input)) {
      const err = push(k, v);
      if (err) return err;
    }
  } else {
    return { ok: false, error: "variables must be an array or object map" };
  }
  if (out.length > MAX_VARS_PER_ENV) {
    return { ok: false, error: `An environment can have at most ${MAX_VARS_PER_ENV} variables` };
  }
  return { ok: true, value: out };
}

function validateBaseUrl(input) {
  if (input == null || input === "") return { ok: true, value: null };
  if (typeof input !== "string") return { ok: false, error: "baseUrl must be a string" };
  const trimmed = input.trim();
  if (trimmed.length === 0) return { ok: true, value: null };
  // Allow http(s) only — workflow injects this as PLAYWRIGHT_BASE_URL etc.
  if (!/^https?:\/\//i.test(trimmed)) {
    return { ok: false, error: "baseUrl must start with http:// or https://" };
  }
  try {
    // Round-trip through URL to reject obvious garbage.
    // eslint-disable-next-line no-new
    new URL(trimmed);
  } catch {
    return { ok: false, error: "baseUrl is not a valid URL" };
  }
  if (trimmed.length > 2048) return { ok: false, error: "baseUrl exceeds 2048 characters" };
  return { ok: true, value: trimmed };
}

function validateName(input) {
  if (typeof input !== "string") return { ok: false, error: "name is required" };
  const trimmed = input.trim();
  if (trimmed.length === 0) return { ok: false, error: "name is required" };
  if (trimmed.length > MAX_NAME_LEN) return { ok: false, error: `name exceeds ${MAX_NAME_LEN} characters` };
  return { ok: true, value: trimmed };
}

// ── Serialization ──────────────────────────────────────────────────────────

function serializeEnvironment(row) {
  // Stored variables are { key, value, isSecret }. We never redact in API
  // responses — anyone who can read the row can see the values. (Secrets
  // here are "secret to the test repo" — i.e., should be pushed to GitHub
  // Secrets rather than inlined into committed YAML.) Tighten later if
  // we add a read-only "viewer" role.
  return {
    id: row.id,
    projectId: row.execute_project_id,
    name: row.name,
    baseUrl: row.base_url,
    variables: Array.isArray(row.variables) ? row.variables : [],
    isDefault: Boolean(row.is_default),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ── Routes ──────────────────────────────────────────────────────────────────

router.get(
  "/:projectId/environments",
  requireAuth,
  requireProjectMember,
  asyncHandler("List environments", async (req, res) => {
    const r = await query(
      `SELECT * FROM project_environments
       WHERE execute_project_id = $1
       ORDER BY is_default DESC, name ASC`,
      [req.projectId]
    );
    res.json({
      environments: r.rows.map(serializeEnvironment),
      canManage: ["owner", "admin"].includes(req.projectRole),
    });
  })
);

router.post(
  "/:projectId/environments",
  requireAuth,
  requireProjectAdmin,
  asyncHandler("Create environment", async (req, res) => {
    const { name, baseUrl, variables, isDefault } = req.body || {};
    const nameCheck = validateName(name);
    if (!nameCheck.ok) return res.status(400).json({ error: nameCheck.error });
    const urlCheck = validateBaseUrl(baseUrl);
    if (!urlCheck.ok) return res.status(400).json({ error: urlCheck.error });
    const varsCheck = normalizeVariables(variables);
    if (!varsCheck.ok) return res.status(400).json({ error: varsCheck.error });

    try {
      if (isDefault) {
        await query(
          `UPDATE project_environments SET is_default = FALSE
           WHERE execute_project_id = $1`,
          [req.projectId]
        );
      }
      const inserted = await query(
        `INSERT INTO project_environments
           (execute_project_id, name, base_url, variables, is_default, created_by)
         VALUES ($1, $2, $3, $4::jsonb, $5, $6)
         RETURNING *`,
        [
          req.projectId,
          nameCheck.value,
          urlCheck.value,
          JSON.stringify(varsCheck.value),
          Boolean(isDefault),
          req.userId,
        ]
      );
      res.json(serializeEnvironment(inserted.rows[0]));
    } catch (err) {
      if (err.code === "23505") {
        return res.status(409).json({ error: `An environment named "${nameCheck.value}" already exists in this project` });
      }
      throw err;
    }
  })
);

router.patch(
  "/:projectId/environments/:id",
  requireAuth,
  requireProjectAdmin,
  asyncHandler("Update environment", async (req, res) => {
    const envId = req.params.id;
    if (!UUID_RE.test(envId)) return res.status(400).json({ error: "Invalid environment id" });

    const { name, baseUrl, variables, isDefault } = req.body || {};
    const sets = [];
    const params = [];
    let idx = 1;

    if (name !== undefined) {
      const c = validateName(name);
      if (!c.ok) return res.status(400).json({ error: c.error });
      sets.push(`name = $${idx++}`);
      params.push(c.value);
    }
    if (baseUrl !== undefined) {
      const c = validateBaseUrl(baseUrl);
      if (!c.ok) return res.status(400).json({ error: c.error });
      sets.push(`base_url = $${idx++}`);
      params.push(c.value);
    }
    if (variables !== undefined) {
      const c = normalizeVariables(variables);
      if (!c.ok) return res.status(400).json({ error: c.error });
      sets.push(`variables = $${idx++}::jsonb`);
      params.push(JSON.stringify(c.value));
    }
    if (isDefault === true) {
      // Clear other defaults first (in the same transaction would be safer;
      // collision window is tiny here so we accept the simpler 2-step).
      await query(
        `UPDATE project_environments SET is_default = FALSE
         WHERE execute_project_id = $1 AND id <> $2`,
        [req.projectId, envId]
      );
      sets.push(`is_default = $${idx++}`);
      params.push(true);
    } else if (isDefault === false) {
      sets.push(`is_default = $${idx++}`);
      params.push(false);
    }

    if (sets.length === 0) return res.status(400).json({ error: "No fields to update" });
    sets.push(`updated_at = now()`);
    params.push(envId);
    params.push(req.projectId);

    try {
      const r = await query(
        `UPDATE project_environments SET ${sets.join(", ")}
         WHERE id = $${idx++} AND execute_project_id = $${idx}
         RETURNING *`,
        params
      );
      if (!r.rows.length) return res.status(404).json({ error: "Environment not found" });
      res.json(serializeEnvironment(r.rows[0]));
    } catch (err) {
      if (err.code === "23505") {
        return res.status(409).json({ error: "Another environment with that name already exists" });
      }
      throw err;
    }
  })
);

router.delete(
  "/:projectId/environments/:id",
  requireAuth,
  requireProjectAdmin,
  asyncHandler("Delete environment", async (req, res) => {
    const envId = req.params.id;
    if (!UUID_RE.test(envId)) return res.status(400).json({ error: "Invalid environment id" });
    // Schedules referencing this env will have environment_id set to NULL by
    // the FK ON DELETE SET NULL — they keep firing but stop injecting the
    // env vars. The user can re-assign in the schedule edit UI.
    const r = await query(
      `DELETE FROM project_environments
       WHERE id = $1 AND execute_project_id = $2`,
      [envId, req.projectId]
    );
    if (r.rowCount === 0) return res.status(404).json({ error: "Environment not found" });
    res.json({ ok: true });
  })
);

export default router;
