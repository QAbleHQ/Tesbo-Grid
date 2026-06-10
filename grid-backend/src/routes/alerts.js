import { Router } from "express";
import { query } from "../db/database.js";
import { requireAuth } from "../middleware/session.js";
import { logger } from "../logger.js";

const router = Router();

const ALLOWED_METRICS = new Set(["pass_ratio", "failure_rate", "flaky_tests"]);
const ALLOWED_OPERATORS = new Set(["below", "above"]);
const ALLOWED_CHANNELS = new Set(["email", "in_app", "slack"]);
const ALLOWED_UNITS = new Set(["%", "tests"]);

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function unitForMetric(metric) {
  if (metric === "flaky_tests") return "tests";
  return "%";
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
    const access = await getProjectAccess(req.params.projectId, req.userId);
    if (!access) return res.status(403).json({ error: "Project access required" });
    req.projectAccess = access;
    next();
  } catch (err) {
    logger.error("Alerts: project access check failed", err);
    res.status(500).json({ error: "Failed to validate access" });
  }
}

async function requireProjectAdmin(req, res, next) {
  try {
    const access = await getProjectAccess(req.params.projectId, req.userId);
    if (!access) return res.status(403).json({ error: "Project access required" });
    if (!["owner", "admin"].includes(access.role)) {
      return res.status(403).json({ error: "Admin access required" });
    }
    req.projectAccess = access;
    next();
  } catch (err) {
    logger.error("Alerts: project admin check failed", err);
    res.status(500).json({ error: "Failed to validate access" });
  }
}

function serializeAlert(row) {
  return {
    id: row.id,
    name: row.name,
    metric: row.metric,
    operator: row.operator,
    threshold: row.threshold != null ? Number(row.threshold) : 0,
    unit: row.unit,
    channel: row.channel,
    recipients: Array.isArray(row.recipients) ? row.recipients : [],
    enabled: row.enabled,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function sanitizeRecipients(value) {
  if (!Array.isArray(value)) return null;
  const out = [];
  const seen = new Set();
  for (const raw of value) {
    if (typeof raw !== "string") continue;
    const trimmed = raw.trim().toLowerCase();
    if (!trimmed || !EMAIL_REGEX.test(trimmed)) continue;
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

function validatePayload(body, { partial = false } = {}) {
  const errors = [];
  const data = {};

  if (body.name !== undefined) {
    if (typeof body.name !== "string" || !body.name.trim()) {
      errors.push("name is required");
    } else {
      data.name = body.name.trim().slice(0, 200);
    }
  } else if (!partial) {
    errors.push("name is required");
  }

  if (body.metric !== undefined) {
    if (!ALLOWED_METRICS.has(body.metric)) {
      errors.push("metric is invalid");
    } else {
      data.metric = body.metric;
    }
  } else if (!partial) {
    errors.push("metric is required");
  }

  if (body.operator !== undefined) {
    if (!ALLOWED_OPERATORS.has(body.operator)) {
      errors.push("operator is invalid");
    } else {
      data.operator = body.operator;
    }
  } else if (!partial) {
    errors.push("operator is required");
  }

  if (body.threshold !== undefined) {
    const numeric = Number(body.threshold);
    if (!Number.isFinite(numeric) || numeric < 0) {
      errors.push("threshold must be a non-negative number");
    } else {
      data.threshold = numeric;
    }
  } else if (!partial) {
    errors.push("threshold is required");
  }

  if (body.unit !== undefined) {
    if (!ALLOWED_UNITS.has(body.unit)) {
      errors.push("unit is invalid");
    } else {
      data.unit = body.unit;
    }
  }
  if (data.unit == null && data.metric != null) {
    data.unit = unitForMetric(data.metric);
  }

  if (body.channel !== undefined) {
    if (!ALLOWED_CHANNELS.has(body.channel)) {
      errors.push("channel is invalid");
    } else {
      data.channel = body.channel;
    }
  } else if (!partial) {
    data.channel = "email";
  }

  if (body.recipients !== undefined) {
    const recipients = sanitizeRecipients(body.recipients);
    if (recipients == null) {
      errors.push("recipients must be an array of emails");
    } else {
      data.recipients = recipients;
    }
  } else if (!partial) {
    data.recipients = [];
  }

  if (body.enabled !== undefined) {
    data.enabled = Boolean(body.enabled);
  } else if (!partial) {
    data.enabled = true;
  }

  // Threshold range constraint when % unit
  if (data.unit === "%" && data.threshold != null && data.threshold > 100) {
    errors.push("threshold for % metrics must be ≤ 100");
  }

  return { errors, data };
}

// ── List alert rules ────────────────────────────────────────────────────────
router.get("/:projectId/alerts", requireAuth, requireProjectMember, async (req, res) => {
  try {
    const result = await query(
      `SELECT id, name, metric, operator, threshold, unit, channel, recipients,
              enabled, created_at, updated_at
       FROM project_alerts
       WHERE execute_project_id = $1
       ORDER BY created_at DESC`,
      [req.params.projectId]
    );
    res.json({ alerts: result.rows.map(serializeAlert) });
  } catch (err) {
    logger.error("GET alerts error:", err);
    res.status(500).json({ error: "Failed to list alerts" });
  }
});

// ── Create alert rule ───────────────────────────────────────────────────────
router.post("/:projectId/alerts", requireAuth, requireProjectAdmin, async (req, res) => {
  try {
    const { errors, data } = validatePayload(req.body || {}, { partial: false });
    if (errors.length > 0) {
      return res.status(400).json({ error: errors[0], detail: errors.join("; ") });
    }

    const result = await query(
      `INSERT INTO project_alerts
         (execute_project_id, name, metric, operator, threshold, unit, channel,
          recipients, enabled, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10)
       RETURNING id, name, metric, operator, threshold, unit, channel, recipients,
                 enabled, created_at, updated_at`,
      [
        req.params.projectId,
        data.name,
        data.metric,
        data.operator,
        data.threshold,
        data.unit,
        data.channel,
        JSON.stringify(data.recipients),
        data.enabled,
        req.userId,
      ]
    );
    res.status(201).json({ alert: serializeAlert(result.rows[0]) });
  } catch (err) {
    logger.error("POST alerts error:", err);
    res.status(500).json({ error: "Failed to create alert" });
  }
});

// ── Update alert rule ───────────────────────────────────────────────────────
router.patch(
  "/:projectId/alerts/:alertId",
  requireAuth,
  requireProjectAdmin,
  async (req, res) => {
    try {
      const { errors, data } = validatePayload(req.body || {}, { partial: true });
      if (errors.length > 0) {
        return res.status(400).json({ error: errors[0], detail: errors.join("; ") });
      }

      const sets = [];
      const params = [];
      let idx = 1;
      for (const [column, value] of [
        ["name", data.name],
        ["metric", data.metric],
        ["operator", data.operator],
        ["threshold", data.threshold],
        ["unit", data.unit],
        ["channel", data.channel],
        ["enabled", data.enabled],
      ]) {
        if (value !== undefined) {
          sets.push(`${column} = $${idx++}`);
          params.push(value);
        }
      }
      if (data.recipients !== undefined) {
        sets.push(`recipients = $${idx++}::jsonb`);
        params.push(JSON.stringify(data.recipients));
      }
      if (sets.length === 0) {
        return res.status(400).json({ error: "No fields to update" });
      }
      sets.push(`updated_at = now()`);
      params.push(req.params.alertId);
      params.push(req.params.projectId);

      const result = await query(
        `UPDATE project_alerts
         SET ${sets.join(", ")}
         WHERE id = $${idx++}
           AND execute_project_id = $${idx}
         RETURNING id, name, metric, operator, threshold, unit, channel, recipients,
                   enabled, created_at, updated_at`,
        params
      );

      if (result.rows.length === 0) {
        return res.status(404).json({ error: "Alert not found" });
      }
      res.json({ alert: serializeAlert(result.rows[0]) });
    } catch (err) {
      logger.error("PATCH alert error:", err);
      res.status(500).json({ error: "Failed to update alert" });
    }
  }
);

// ── Delete alert rule ───────────────────────────────────────────────────────
router.delete(
  "/:projectId/alerts/:alertId",
  requireAuth,
  requireProjectAdmin,
  async (req, res) => {
    try {
      const result = await query(
        `DELETE FROM project_alerts
         WHERE id = $1 AND execute_project_id = $2`,
        [req.params.alertId, req.params.projectId]
      );
      if (result.rowCount === 0) {
        return res.status(404).json({ error: "Alert not found" });
      }
      res.json({ ok: true });
    } catch (err) {
      logger.error("DELETE alert error:", err);
      res.status(500).json({ error: "Failed to delete alert" });
    }
  }
);

// ── List triggered alert events (history) ──────────────────────────────────
router.get(
  "/:projectId/alerts/events",
  requireAuth,
  requireProjectMember,
  async (req, res) => {
    try {
      const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
      const result = await query(
        `SELECT id, alert_id, rule_title, summary, severity, run_id, run_name,
                metric, observed_value, threshold, triggered_at
         FROM project_alert_events
         WHERE execute_project_id = $1
         ORDER BY triggered_at DESC
         LIMIT $2`,
        [req.params.projectId, limit]
      );
      res.json({
        events: result.rows.map((row) => ({
          id: row.id,
          alertId: row.alert_id,
          ruleTitle: row.rule_title,
          summary: row.summary,
          severity: row.severity,
          runId: row.run_id,
          runName: row.run_name,
          metric: row.metric,
          observedValue: row.observed_value != null ? Number(row.observed_value) : null,
          threshold: row.threshold != null ? Number(row.threshold) : null,
          triggeredAt: row.triggered_at,
        })),
      });
    } catch (err) {
      logger.error("GET alert events error:", err);
      res.status(500).json({ error: "Failed to list alert history" });
    }
  }
);

export default router;
