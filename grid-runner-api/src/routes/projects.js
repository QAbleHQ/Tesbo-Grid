import { Router } from "express";
import { query } from "../db/database.js";
import { apiKeyAuth } from "../middleware/auth.js";
import { logError } from "../logger.js";

const router = Router();

// GET /api/projects/me/stack
//
// Returns the framework / language / defaultBrowser for the project bound to
// the authenticating API key. Used by the CLI to fill in defaults for
// `--framework` / `--language` / `--browser` when the user does not pass them
// explicitly.
router.get("/me/stack", apiKeyAuth("runs:read"), async (req, res) => {
  const projectId = req.apiKeyProjectId;
  if (!projectId) {
    return res.status(400).json({
      error:
        "API key is not bound to a project; pass --framework/--language/--browser explicitly.",
    });
  }
  try {
    const result = await query(
      `SELECT settings FROM execute_projects WHERE id = $1 AND archived_at IS NULL`,
      [projectId]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Project not found" });
    }
    const settings = result.rows[0].settings || {};
    res.json({
      projectId,
      framework: settings.framework || null,
      language: settings.language || null,
      defaultBrowser: settings.defaultBrowser || null,
    });
  } catch (err) {
    logError("projects_me_stack_error", {
      error: err instanceof Error ? err.message : String(err),
    });
    res.status(500).json({ error: "Failed to read project settings" });
  }
});

export default router;
