import { Router } from "express";
import { requireAuth } from "../middleware/session.js";
import { query } from "../db/database.js";
import { config } from "../config.js";
import { logger } from "../logger.js";

const router = Router();

/**
 * Authenticate via x-project-access-key header (tesbo_ keys).
 * Validates the key against the project's stored ingestionApiKey.
 */
async function authenticateAccessKey(req, res, next) {
  const accessKey = req.header("x-project-access-key");
  if (!accessKey) {
    return requireAuth(req, res, next);
  }

  try {
    const result = await query(
      `SELECT id FROM execute_projects
       WHERE id = $1
       AND settings ->> 'ingestionApiKey' = $2
       AND archived_at IS NULL`,
      [req.params.projectId, accessKey]
    );
    if (result.rows.length === 0) {
      return res.status(401).json({ error: "Invalid access key for this project" });
    }
    req.accessKeyProjectId = result.rows[0].id;
    next();
  } catch (err) {
    logger.error("Access key auth error:", err);
    res.status(500).json({ error: "Authentication failed" });
  }
}

/**
 * Proxy tesbo-reports requests to TesboX backend.
 * Accepts either session auth or x-project-access-key auth.
 */
router.use("/:projectId/tesbo-reports", authenticateAccessKey, async (req, res) => {
  try {
    let targetProjectId = req.params.projectId;

    if (req.accessKeyProjectId) {
      const linkResult = await query(
        `SELECT tesbox_project_id FROM tesbox_execute_project_links
         WHERE execute_project_id = $1 AND status = 'linked' LIMIT 1`,
        [req.accessKeyProjectId]
      );
      if (linkResult.rows.length > 0) {
        targetProjectId = linkResult.rows[0].tesbox_project_id;
      }
    }

    const subPath = req.url.replace(/^\/[^/]+\/tesbo-reports/, "");
    const targetUrl = `${config.tesboxApiUrl}/api/projects/${targetProjectId}/tesbo-reports${subPath}`;

    const headers = {
      "Content-Type": "application/json",
    };

    if (req.header("x-project-access-key")) {
      headers["x-project-access-key"] = req.header("x-project-access-key");
    }

    const fetchOpts = {
      method: req.method,
      headers,
    };

    if (req.method !== "GET" && req.method !== "HEAD" && req.body) {
      fetchOpts.body = JSON.stringify(req.body);
    }

    const upstream = await fetch(targetUrl, fetchOpts);
    const contentType = upstream.headers.get("content-type") || "";

    if (contentType.includes("application/json")) {
      const data = await upstream.json();
      res.status(upstream.status).json(data);
    } else {
      const text = await upstream.text();
      res.status(upstream.status).type(contentType).send(text);
    }
  } catch (err) {
    logger.error("Reports proxy error:", err);
    res.status(502).json({ error: "Failed to reach TesboX reports service" });
  }
});

export default router;
