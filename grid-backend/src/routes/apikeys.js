import { Router } from "express";
import { requireAuth } from "../middleware/session.js";
import { config } from "../config.js";
import { logger } from "../logger.js";

const router = Router();

function proxyHeaders() {
  const h = { "Content-Type": "application/json" };
  if (config.executionApiSharedToken) {
    h["x-agent-token"] = config.executionApiSharedToken;
  }
  return h;
}

// List API keys for a project
router.get("/:projectId/apikeys", requireAuth, async (req, res) => {
  try {
    const url = `${config.executionApiUrl}/api/apikeys?projectId=${req.params.projectId}`;
    const response = await fetch(url, { headers: proxyHeaders() });
    const data = await response.json();
    res.status(response.status).json(data);
  } catch (err) {
    logger.error("GET apikeys proxy error:", err);
    res.status(502).json({ error: "Failed to reach execution service" });
  }
});

// Create API key for a project
router.post("/:projectId/apikeys", requireAuth, async (req, res) => {
  try {
    const { name } = req.body || {};
    const url = `${config.executionApiUrl}/api/apikeys`;
    const response = await fetch(url, {
      method: "POST",
      headers: proxyHeaders(),
      body: JSON.stringify({
        name: name || "Default",
        projectId: req.params.projectId,
        scopes: ["runs:write", "runs:read", "queue:read"],
      }),
    });
    const data = await response.json();
    res.status(response.status).json(data);
  } catch (err) {
    logger.error("POST apikeys proxy error:", err);
    res.status(502).json({ error: "Failed to reach execution service" });
  }
});

// Revoke API key
router.delete("/:projectId/apikeys/:keyId", requireAuth, async (req, res) => {
  try {
    const url = `${config.executionApiUrl}/api/apikeys/${req.params.keyId}`;
    const response = await fetch(url, {
      method: "DELETE",
      headers: proxyHeaders(),
    });
    if (response.status === 204) return res.status(204).end();
    const data = await response.json().catch(() => ({}));
    res.status(response.status).json(data);
  } catch (err) {
    logger.error("DELETE apikeys proxy error:", err);
    res.status(502).json({ error: "Failed to reach execution service" });
  }
});

export default router;
