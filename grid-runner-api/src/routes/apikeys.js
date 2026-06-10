import { Router } from "express";
import crypto from "node:crypto";
import { query } from "../db/database.js";
import { apiKeyAuth, internalAuth } from "../middleware/auth.js";

const router = Router();

function generateApiKey() {
  return "txe_" + crypto.randomBytes(24).toString("hex");
}

function hashKey(key) {
  return crypto.createHash("sha256").update(key).digest("hex");
}

function maskKey(rawPrefix) {
  return rawPrefix.slice(0, 8) + "..." + rawPrefix.slice(-4);
}

function extractTesboConfig(meta) {
  const cfg = meta?.tesboConfig || {};
  const scheduler = meta?.schedulerPolicy || {};
  return {
    tesboApiUrl: cfg.tesboApiUrl || null,
    tesboUiUrl: cfg.tesboUiUrl || null,
    hasTesboAccessKey: Boolean(cfg.tesboAccessKey),
    schedulerPolicy: {
      tenantConcurrencyLimit: scheduler.tenantConcurrencyLimit || null,
      tenantWeight: scheduler.tenantWeight || null,
      burstConcurrencyLimit: scheduler.burstConcurrencyLimit || null,
      reservedConcurrency: scheduler.reservedConcurrency || null,
    },
  };
}

router.get("/", internalAuth(process.env.INTERNAL_SHARED_TOKEN || ""), async (req, res) => {
  const { projectId } = req.query;
  if (!projectId) {
    return res.status(400).json({ error: "projectId query parameter is required" });
  }
  const { rows } = await query(
    `SELECT id, name, project_id, scopes, metadata_json, created_at, last_used_at, revoked_at
     FROM api_keys WHERE project_id = $1 ORDER BY created_at DESC`,
    [projectId]
  );
  res.json({
    keys: rows.map((r) => ({
      ...r,
      masked: maskKey(r.name),
      ...extractTesboConfig(r.metadata_json || {}),
      metadata_json: undefined,
    })),
  });
});

router.post("/", internalAuth(process.env.INTERNAL_SHARED_TOKEN || ""), async (req, res) => {
  const {
    projectId,
    name,
    tesboApiUrl,
    tesboUiUrl,
    tesboAccessKey,
    tenantConcurrencyLimit,
    tenantWeight,
    burstConcurrencyLimit,
    reservedConcurrency,
  } = req.body;
  if (!projectId) {
    return res.status(400).json({ error: "projectId is required" });
  }
  const keyName = name || "Default key";
  const rawKey = generateApiKey();
  const keyHash = hashKey(rawKey);

  const metadata = {
    tesboConfig: {
      tesboApiUrl: tesboApiUrl || null,
      tesboUiUrl: tesboUiUrl || null,
      tesboAccessKey: tesboAccessKey || null,
    },
    schedulerPolicy: {
      tenantConcurrencyLimit: tenantConcurrencyLimit || null,
      tenantWeight: tenantWeight || null,
      burstConcurrencyLimit: burstConcurrencyLimit || null,
      reservedConcurrency: reservedConcurrency || null,
    },
  };

  await query(
    `INSERT INTO api_keys (key_hash, name, project_id, scopes, metadata_json)
     VALUES ($1, $2, $3, $4, $5::jsonb)`,
    [keyHash, keyName, projectId, ["runs:write", "runs:read", "queue:read"], JSON.stringify(metadata)]
  );

  const { rows } = await query(
    `SELECT id, name, project_id, scopes, metadata_json, created_at FROM api_keys WHERE key_hash = $1`,
    [keyHash]
  );

  const out = rows[0];
  res.status(201).json({
    key: rawKey,
    ...out,
    ...extractTesboConfig(out.metadata_json || {}),
    metadata_json: undefined,
  });
});

router.put("/self/tesbo", apiKeyAuth("runs:write"), async (req, res) => {
  if (!req.apiKeyId) {
    return res.status(400).json({ error: "This endpoint is only available for execution API keys (txe_...)." });
  }
  const { tesboApiUrl, tesboUiUrl, tesboAccessKey } = req.body || {};
  if (!tesboApiUrl || !tesboAccessKey) {
    return res.status(400).json({ error: "tesboApiUrl and tesboAccessKey are required" });
  }

  const metadata = {
    tesboConfig: {
      tesboApiUrl: String(tesboApiUrl),
      tesboUiUrl: tesboUiUrl ? String(tesboUiUrl) : null,
      tesboAccessKey: String(tesboAccessKey),
    },
  };
  await query(
    `UPDATE api_keys
     SET metadata_json = COALESCE(metadata_json, '{}'::jsonb) || $1::jsonb
     WHERE id = $2`,
    [JSON.stringify(metadata), req.apiKeyId]
  );

  res.json({ configured: true, ...extractTesboConfig(metadata) });
});

router.delete("/self/tesbo", apiKeyAuth("runs:write"), async (req, res) => {
  if (!req.apiKeyId) {
    return res.status(400).json({ error: "This endpoint is only available for execution API keys (txe_...)." });
  }
  await query(
    `UPDATE api_keys
     SET metadata_json = metadata_json - 'tesboConfig'
     WHERE id = $1`,
    [req.apiKeyId]
  );
  res.json({ disconnected: true });
});

router.delete("/:keyId", internalAuth(process.env.INTERNAL_SHARED_TOKEN || ""), async (req, res) => {
  const { keyId } = req.params;
  const { rows } = await query(
    `UPDATE api_keys SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL RETURNING id`,
    [keyId]
  );
  if (!rows.length) {
    return res.status(404).json({ error: "API key not found or already revoked" });
  }
  res.json({ revoked: true, id: keyId });
});

export default router;
