import { Router } from "express";
import crypto from "node:crypto";
import { query } from "../db/database.js";
import { requireAuth } from "../middleware/session.js";
import { logger } from "../logger.js";

const router = Router();

async function getUserOrgId(userId) {
  const result = await query(
    "SELECT organization_id FROM organization_members WHERE user_id = $1 LIMIT 1",
    [userId]
  );
  return result.rows[0]?.organization_id ?? null;
}

async function requireOrgAdmin(req, res, next) {
  const orgId = await getUserOrgId(req.userId);
  if (!orgId) return res.status(404).json({ error: "No workspace found" });
  const role = await query(
    "SELECT role FROM organization_members WHERE organization_id = $1 AND user_id = $2",
    [orgId, req.userId]
  );
  if (!role.rows[0] || !["owner", "admin"].includes(role.rows[0].role)) {
    return res.status(403).json({ error: "Admin access required" });
  }
  req.orgId = orgId;
  next();
}

router.get("/", requireAuth, async (req, res) => {
  try {
    const orgId = await getUserOrgId(req.userId);
    if (!orgId) return res.json(null);
    const result = await query(
      `SELECT o.id, o.name, o.slug, o.created_at, om.role
       FROM organizations o
       JOIN organization_members om ON om.organization_id = o.id
       WHERE om.user_id = $1 AND o.id = $2`,
      [req.userId, orgId]
    );
    if (result.rows.length === 0) return res.json(null);
    const r = result.rows[0];
    res.json({
      id: r.id,
      name: r.name,
      slug: r.slug,
      role: r.role,
      createdAt: r.created_at,
    });
  } catch (err) {
    logger.error("GET workspace error:", err);
    res.status(500).json({ error: "Failed to get workspace" });
  }
});

router.get("/members", requireAuth, async (req, res) => {
  try {
    const orgId = await getUserOrgId(req.userId);
    if (!orgId) return res.status(404).json({ error: "No workspace found" });
    const result = await query(
      `SELECT om.user_id AS "userId", u.email, u.name, om.role, om.created_at AS "joinedAt"
       FROM organization_members om
       JOIN users u ON u.id = om.user_id
       WHERE om.organization_id = $1
       ORDER BY om.created_at`,
      [orgId]
    );
    res.json(result.rows);
  } catch (err) {
    logger.error("GET workspace/members error:", err);
    res.status(500).json({ error: "Failed to list members" });
  }
});

router.post("/members", requireAuth, requireOrgAdmin, async (req, res) => {
  try {
    const { email, userId: targetUserId, role = "member" } = req.body || {};
    let uid = targetUserId;
    if (!uid && email) {
      const u = await query("SELECT id FROM users WHERE email = $1", [
        email.trim().toLowerCase(),
      ]);
      if (u.rows.length === 0) {
        return res.status(404).json({ error: "User not found" });
      }
      uid = u.rows[0].id;
    }
    if (!uid) return res.status(400).json({ error: "email or userId required" });

    await query(
      `INSERT INTO organization_members (organization_id, user_id, role)
       VALUES ($1, $2, $3)
       ON CONFLICT (organization_id, user_id) DO UPDATE SET role = $3`,
      [req.orgId, uid, role]
    );
    res.json({ ok: true });
  } catch (err) {
    logger.error("POST workspace/members error:", err);
    res.status(500).json({ error: "Failed to add member" });
  }
});

router.delete("/members/:userId", requireAuth, requireOrgAdmin, async (req, res) => {
  try {
    if (req.params.userId === req.userId) {
      return res.status(400).json({ error: "Cannot remove yourself" });
    }
    await query(
      "DELETE FROM organization_members WHERE organization_id = $1 AND user_id = $2",
      [req.orgId, req.params.userId]
    );
    res.json({ ok: true });
  } catch (err) {
    logger.error("DELETE workspace/members error:", err);
    res.status(500).json({ error: "Failed to remove member" });
  }
});

// --- AI Keys ---

router.get("/ai-keys", requireAuth, async (req, res) => {
  try {
    const orgId = await getUserOrgId(req.userId);
    if (!orgId) return res.status(404).json({ error: "No workspace found" });

    const keys = await query(
      `SELECT id, name, provider, default_model, is_active, created_at, updated_at,
              LEFT(api_key, 4) || '...' || RIGHT(api_key, 4) AS masked_key
       FROM workspace_ai_keys
       WHERE organization_id = $1 ORDER BY created_at`,
      [orgId]
    );

    const allocs = await query(
      `SELECT epa.execute_project_id AS "projectId", ep.key AS "projectKey",
              ep.name AS "projectName", epa.workspace_ai_key_id AS "workspaceAiKeyId"
       FROM execute_project_ai_key_allocations epa
       JOIN execute_projects ep ON ep.id = epa.execute_project_id
       WHERE ep.organization_id = $1`,
      [orgId]
    );

    res.json({
      keys: keys.rows.map((k) => ({
        id: k.id,
        name: k.name,
        provider: k.provider,
        defaultModel: k.default_model,
        active: k.is_active,
        maskedKey: k.masked_key,
        createdAt: k.created_at,
        updatedAt: k.updated_at,
      })),
      projects: allocs.rows,
    });
  } catch (err) {
    logger.error("GET ai-keys error:", err);
    res.status(500).json({ error: "Failed to list AI keys" });
  }
});

router.post("/ai-keys", requireAuth, requireOrgAdmin, async (req, res) => {
  try {
    const { name, provider, apiKey, defaultModel } = req.body || {};
    if (!name || !provider || !apiKey) {
      return res.status(400).json({ error: "name, provider, and apiKey are required" });
    }
    const result = await query(
      `INSERT INTO workspace_ai_keys (organization_id, name, provider, api_key, default_model, created_by)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, name, provider, default_model, is_active, created_at, updated_at`,
      [req.orgId, name, provider, apiKey, defaultModel || null, req.userId]
    );
    const k = result.rows[0];
    res.json({
      id: k.id,
      name: k.name,
      provider: k.provider,
      defaultModel: k.default_model,
      active: k.is_active,
      maskedKey: apiKey.slice(0, 4) + "..." + apiKey.slice(-4),
      createdAt: k.created_at,
      updatedAt: k.updated_at,
    });
  } catch (err) {
    logger.error("POST ai-keys error:", err);
    res.status(500).json({ error: "Failed to create AI key" });
  }
});

router.delete("/ai-keys/:keyId", requireAuth, requireOrgAdmin, async (req, res) => {
  try {
    await query(
      "DELETE FROM workspace_ai_keys WHERE id = $1 AND organization_id = $2",
      [req.params.keyId, req.orgId]
    );
    res.json({ ok: true });
  } catch (err) {
    logger.error("DELETE ai-keys error:", err);
    res.status(500).json({ error: "Failed to delete AI key" });
  }
});

router.post("/ai-keys/allocations", requireAuth, requireOrgAdmin, async (req, res) => {
  try {
    const { projectId, workspaceAiKeyId } = req.body || {};
    if (!projectId) {
      return res.status(400).json({ error: "projectId is required" });
    }
    if (workspaceAiKeyId) {
      await query(
        `INSERT INTO execute_project_ai_key_allocations (execute_project_id, workspace_ai_key_id, allocated_by)
         VALUES ($1, $2, $3)
         ON CONFLICT (execute_project_id) DO UPDATE SET
           workspace_ai_key_id = $2, allocated_by = $3, updated_at = now()`,
        [projectId, workspaceAiKeyId, req.userId]
      );
    } else {
      await query(
        "DELETE FROM execute_project_ai_key_allocations WHERE execute_project_id = $1",
        [projectId]
      );
    }
    res.json({ ok: true });
  } catch (err) {
    logger.error("POST ai-keys/allocations error:", err);
    res.status(500).json({ error: "Failed to allocate AI key" });
  }
});

// --- Invitations ---

router.get("/invitations", requireAuth, async (req, res) => {
  try {
    const orgId = await getUserOrgId(req.userId);
    if (!orgId) return res.status(404).json({ error: "No workspace" });
    const result = await query(
      `SELECT id, email, role, expires_at AS "expiresAt", created_at AS "createdAt"
       FROM workspace_invitations
       WHERE organization_id = $1 AND accepted_at IS NULL
       ORDER BY created_at DESC`,
      [orgId]
    );
    res.json(result.rows);
  } catch (err) {
    logger.error("GET invitations error:", err);
    res.status(500).json({ error: "Failed to list invitations" });
  }
});

router.post("/invitations", requireAuth, requireOrgAdmin, async (req, res) => {
  try {
    const { email, role = "member" } = req.body || {};
    if (!email) return res.status(400).json({ error: "email is required" });

    const token = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + 7 * 86400 * 1000);
    const result = await query(
      `INSERT INTO workspace_invitations (organization_id, email, role, token, expires_at, created_by)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, email, role, expires_at AS "expiresAt", created_at AS "createdAt"`,
      [req.orgId, email.trim().toLowerCase(), role, token, expiresAt, req.userId]
    );
    res.json(result.rows[0]);
  } catch (err) {
    logger.error("POST invitations error:", err);
    res.status(500).json({ error: "Failed to create invitation" });
  }
});

router.delete("/invitations/:id", requireAuth, requireOrgAdmin, async (req, res) => {
  try {
    await query(
      "DELETE FROM workspace_invitations WHERE id = $1 AND organization_id = $2",
      [req.params.id, req.orgId]
    );
    res.json({ ok: true });
  } catch (err) {
    logger.error("DELETE invitations error:", err);
    res.status(500).json({ error: "Failed to revoke invitation" });
  }
});

export default router;
