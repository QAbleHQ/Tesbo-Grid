import { Router } from "express";
import crypto from "node:crypto";
import express from "express";
import { query } from "../db/database.js";
import { requireAuth } from "../middleware/session.js";
import { config } from "../config.js";
import { logger } from "../logger.js";
import {
  buildInstallUrl,
  createFilePullRequest,
  createOrUpdateRepoSecret,
  getDefaultBranch,
  getInstallation,
  getInstallationByOwner,
  getRepoFile,
  getWorkflowByPath,
  isGithubAppConfigured,
  listInstallationRepos,
} from "../services/github/client.js";
import {
  discoverSuitesForIntegration,
  listSuitesForIntegration,
} from "../services/github/suiteDiscovery.js";
import {
  triggerGithubRun,
  handleRunCompletion,
} from "../services/github/runTrigger.js";
import { computeNextFire } from "../services/github/cronScheduler.js";
import {
  generateWorkflowYaml,
  workflowFilePathForSchedule,
  WORKFLOW_API_KEY_SECRET_NAME,
} from "../services/github/workflowGenerator.js";
import {
  dispatchScheduleRun,
  loadSuiteRows,
  loadScheduleEnvironment,
  syncEnvironmentSecrets,
  loadProjectForScheduleWorkflow,
  inferFrameworkAndLanguage,
} from "../services/github/scheduleDispatcher.js";

const router = Router();
export const githubWebhookRouter = Router();

const STATE_SECRET = process.env.GH_OAUTH_STATE_SECRET || "tesbo-grid-github-state";

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
        res.status(500).json({
          error: `${label} failed`,
          detail: err.message,
        });
      }
    }
  };
}

function signState(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = crypto.createHmac("sha256", STATE_SECRET).update(body).digest("base64url");
  return `${body}.${sig}`;
}

function verifyState(state) {
  if (typeof state !== "string" || !state.includes(".")) return null;
  const [body, sig] = state.split(".");
  const expected = crypto.createHmac("sha256", STATE_SECRET).update(body).digest("base64url");
  if (sig !== expected) return null;
  try {
    return JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function resolveProjectAccess(req) {
  const projectId = req.params.projectId || req.body?.projectId || req.query?.projectId;
  if (!projectId) return { error: { status: 400, message: "projectId required" } };
  if (!UUID_RE.test(String(projectId))) {
    return { error: { status: 400, message: "Invalid projectId format" } };
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
  const role = r.rows[0]?.role || null;
  return { projectId, role };
}

async function requireProjectMember(req, res, next) {
  try {
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
  } catch (err) {
    logger.error("requireProjectMember error", {
      message: err.message,
      code: err.code,
      stack: err.stack,
      projectId: req.params.projectId,
      userId: req.userId,
    });
    res.status(500).json({
      error: "Failed to verify project access",
      detail: err.message,
    });
  }
}

async function requireProjectAdmin(req, res, next) {
  try {
    const access = await resolveProjectAccess(req);
    if (access.error) {
      return res.status(access.error.status).json({ error: access.error.message });
    }
    if (!access.role) {
      return res.status(403).json({ error: "You don't have access to this project" });
    }
    if (!["owner", "admin"].includes(access.role)) {
      return res.status(403).json({ error: "Admin access required to modify this resource" });
    }
    req.projectId = access.projectId;
    req.projectRole = access.role;
    next();
  } catch (err) {
    logger.error("requireProjectAdmin error", {
      message: err.message,
      code: err.code,
      stack: err.stack,
      projectId: req.params.projectId,
      userId: req.userId,
    });
    res.status(500).json({
      error: "Failed to verify project access",
      detail: err.message,
    });
  }
}

function requireGithubConfigured(_req, res, next) {
  if (!isGithubAppConfigured()) {
    return res.status(503).json({ error: "GitHub App is not configured on this deployment" });
  }
  next();
}

router.get("/status", requireAuth, async (_req, res) => {
  res.json({ configured: isGithubAppConfigured(), appName: config.github.appName || null });
});

router.get("/app-install-url", requireAuth, requireGithubConfigured, async (req, res) => {
  const projectId = req.query.projectId;
  if (!projectId || typeof projectId !== "string") {
    return res.status(400).json({ error: "projectId is required" });
  }
  const state = signState({ projectId, userId: req.userId, t: Date.now() });
  const url = buildInstallUrl(state);
  res.json({ url });
});

router.get("/callback", async (req, res) => {
  const { installation_id, state } = req.query;
  const parsed = verifyState(state);
  if (!parsed) return res.status(400).send("Invalid state");
  if (!installation_id) return res.status(400).send("Missing installation_id");
  const redirect = new URL(`${config.frontendUrl}/projects/${parsed.projectId}/settings`);
  redirect.searchParams.set("github_installation_id", String(installation_id));
  redirect.searchParams.set("github_connected", "1");
  redirect.hash = "github";
  res.redirect(redirect.toString());
});

router.get("/installation-by-owner", requireAuth, requireGithubConfigured, async (req, res) => {
  const owner = req.query.owner;
  if (!owner || typeof owner !== "string") {
    return res.status(400).json({ error: "owner is required" });
  }
  try {
    const installation = await getInstallationByOwner(owner.trim());
    if (!installation) return res.json({ installation: null });
    res.json({
      installation: {
        id: String(installation.id),
        accountLogin: installation.account?.login || owner.trim(),
      },
    });
  } catch (err) {
    logger.warn("Lookup GitHub installation by owner failed:", err.message);
    res.status(502).json({ error: "Failed to look up GitHub installation" });
  }
});

router.get("/installations/:installationId/repos", requireAuth, requireGithubConfigured, async (req, res) => {
  try {
    const id = Number(req.params.installationId);
    if (!Number.isFinite(id)) return res.status(400).json({ error: "Invalid installationId" });
    const repos = await listInstallationRepos(id);
    res.json({ repos });
  } catch (err) {
    logger.error("List installation repos error:", err.message);
    res.status(502).json({ error: "Failed to list repos from GitHub" });
  }
});

router.post("/integrations", requireAuth, requireGithubConfigured, async (req, res) => {
  const { projectId, installationId, devRepo, testRepo } = req.body || {};
  if (!projectId || !installationId || !testRepo) {
    return res.status(400).json({ error: "projectId, installationId, testRepo are required" });
  }
  const access = await query(
    `SELECT role FROM execute_project_members WHERE execute_project_id = $1 AND user_id = $2`,
    [projectId, req.userId]
  );
  if (!access.rows[0] || !["owner", "admin"].includes(access.rows[0].role)) {
    return res.status(403).json({ error: "Project admin access required" });
  }
  try {
    const installation = await getInstallation(Number(installationId));
    const accountLogin = installation.account?.login || "unknown";
    const webhookSecret = crypto.randomBytes(24).toString("base64url");
    const result = await query(
      `INSERT INTO github_integrations
         (execute_project_id, installation_id, github_account_login,
          dev_repo_full_name, dev_repo_id, test_repo_full_name, test_repo_id,
          webhook_secret, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (execute_project_id) DO UPDATE SET
         installation_id = EXCLUDED.installation_id,
         github_account_login = EXCLUDED.github_account_login,
         dev_repo_full_name = EXCLUDED.dev_repo_full_name,
         dev_repo_id = EXCLUDED.dev_repo_id,
         test_repo_full_name = EXCLUDED.test_repo_full_name,
         test_repo_id = EXCLUDED.test_repo_id,
         updated_at = now()
       RETURNING *`,
      [
        projectId,
        Number(installationId),
        accountLogin,
        devRepo?.fullName || null,
        devRepo?.id || null,
        testRepo.fullName,
        testRepo.id,
        webhookSecret,
        req.userId,
      ]
    );
    const integration = result.rows[0];
    discoverSuitesForIntegration({
      integrationId: integration.id,
      installationId: Number(installationId),
      testRepoFullName: testRepo.fullName,
      repoRef: testRepo.defaultBranch || "main",
    }).catch((err) => logger.warn("Initial suite discovery failed:", err.message));
    res.json(serializeIntegration(integration));
  } catch (err) {
    logger.error("Create github integration error:", err);
    res.status(500).json({ error: "Failed to create integration" });
  }
});

router.get("/integrations/:projectId", requireAuth, requireProjectMember, async (req, res) => {
  try {
    const integration = await query(
      `SELECT * FROM github_integrations WHERE execute_project_id = $1`,
      [req.projectId]
    );
    if (!integration.rows.length) return res.json(null);
    const row = integration.rows[0];
    const schedules = await query(
      `SELECT s.*,
              u.name AS run_as_user_name, u.email AS run_as_user_email,
              e.name AS environment_name, e.base_url AS environment_base_url
       FROM github_run_schedules s
       LEFT JOIN users u ON u.id = s.run_as_user_id
       LEFT JOIN project_environments e ON e.id = s.environment_id
       WHERE s.integration_id = $1
       ORDER BY s.created_at`,
      [row.id]
    );
    const aiKey = await query(
      `SELECT k.id, k.name, k.provider
       FROM execute_project_ai_key_allocations a
       JOIN workspace_ai_keys k ON k.id = a.workspace_ai_key_id
       WHERE a.execute_project_id = $1 AND k.is_active = TRUE`,
      [req.projectId]
    );
    res.json({
      ...serializeIntegration(row),
      schedules: await Promise.all(schedules.rows.map(serializeScheduleWithSuites)),
      aiKey: aiKey.rows[0] || null,
      viewerRole: req.projectRole,
      canManage: ["owner", "admin"].includes(req.projectRole),
    });
  } catch (err) {
    logger.error("Get github integration error", {
      message: err.message,
      code: err.code,
      stack: err.stack,
      projectId: req.projectId,
    });
    res.status(500).json({
      error: "Failed to load integration",
      detail: err.message,
    });
  }
});

router.delete("/integrations/:projectId", requireAuth, requireProjectAdmin, asyncHandler("Delete integration", async (req, res) => {
  await query(`DELETE FROM github_integrations WHERE execute_project_id = $1`, [req.projectId]);
  res.json({ ok: true });
}));

router.get("/integrations/:projectId/setup-check", requireAuth, requireProjectMember, async (req, res) => {
  const integration = await loadIntegrationForProject(req.projectId);
  if (!integration) return res.status(404).json({ error: "Integration not found" });
  try {
    const content = await getRepoFile(
      Number(integration.installation_id),
      integration.test_repo_full_name,
      ".tesbo-grid.json",
      "HEAD"
    );
    res.json({ configured: content !== null, testRepo: integration.test_repo_full_name });
  } catch (err) {
    logger.warn("Setup check failed:", err.message);
    res.json({ configured: false, testRepo: integration.test_repo_full_name });
  }
});

router.post("/integrations/:projectId/raise-setup-pr", requireAuth, requireProjectAdmin, async (req, res) => {
  const integration = await loadIntegrationForProject(req.projectId);
  if (!integration) return res.status(404).json({ error: "Integration not found" });

  const configContent = JSON.stringify({
    framework: "playwright",
    language: "typescript",
    browser: "chrome",
    testDir: "tests",
  }, null, 2);

  try {
    const installationId = Number(integration.installation_id);
    const testRepo = integration.test_repo_full_name;
    const defaultBranch = await getDefaultBranch(installationId, testRepo);

    const result = await createFilePullRequest(installationId, testRepo, {
      baseBranch: defaultBranch,
      branchName: "tesbo-grid/add-config",
      filePath: ".tesbo-grid.json",
      fileContent: configContent,
      commitMessage: "chore: add Tesbo Grid configuration",
      prTitle: "Add Tesbo Grid configuration",
      prBody: [
        "This PR adds the `.tesbo-grid.json` configuration file required by Tesbo Grid to discover and run your test suites.",
        "",
        "Review the settings and merge when ready. You can customise `framework`, `language`, `browser`, and `testDir` to match your project.",
      ].join("\n"),
    });

    res.json(result);
  } catch (err) {
    const msg = String(err?.message || "");
    const status = err?.status || err?.response?.status;
    const isPermissionError =
      status === 403 ||
      msg.includes("Resource not accessible by integration") ||
      msg.includes("must have admin rights") ||
      msg.includes("Not authorized");

    if (isPermissionError) {
      logger.warn("Raise setup PR blocked by App permissions", {
        repo: integration.test_repo_full_name,
        installationId: integration.installation_id,
        message: msg,
      });
      const accountLogin = integration.github_account_login;
      return res.status(403).json({
        error: "GitHub App can't open a pull request on this repository",
        detail:
          "The Tesbo Grid GitHub App needs Contents (Read & Write) and Pull requests (Read & Write) permissions. " +
          "A GitHub org owner can update these in the App's settings, then re-accept the install. " +
          "Or click 'Setup manually' below to add the .tesbo-grid.json file yourself.",
        code: "GH_APP_INSUFFICIENT_PERMISSIONS",
        manualSetup: {
          filePath: ".tesbo-grid.json",
          fileContent: configContent,
          repo: integration.test_repo_full_name,
        },
        appPermissionsUrl: accountLogin
          ? `https://github.com/organizations/${encodeURIComponent(accountLogin)}/settings/installations/${integration.installation_id}/permissions/update`
          : `https://github.com/settings/installations/${integration.installation_id}/permissions/update`,
      });
    }

    logger.error("Raise setup PR failed:", { message: msg, status, stack: err?.stack });
    res.status(502).json({
      error: "Failed to raise setup PR",
      detail: msg,
    });
  }
});

router.post("/integrations/:projectId/suites/rescan", requireAuth, requireProjectAdmin, async (req, res) => {
  const ref = (req.body?.ref || "main").toString();
  const integration = await loadIntegrationForProject(req.projectId);
  if (!integration) return res.status(404).json({ error: "Integration not found" });
  try {
    const suites = await discoverSuitesForIntegration({
      integrationId: integration.id,
      installationId: Number(integration.installation_id),
      testRepoFullName: integration.test_repo_full_name,
      repoRef: ref,
    });
    res.json({ ref, count: suites.length });
  } catch (err) {
    logger.error("Suite rescan failed:", err);
    res.status(502).json({ error: "Failed to scan test repo" });
  }
});

router.get("/integrations/:projectId/suites", requireAuth, requireProjectMember, asyncHandler("List suites", async (req, res) => {
  const ref = (req.query.ref || "main").toString();
  const integration = await loadIntegrationForProject(req.projectId);
  if (!integration) return res.status(404).json({ error: "Integration not found" });
  const rows = await listSuitesForIntegration(integration.id, ref);
  res.json({
    ref,
    suites: rows.map((r) => ({
      id: r.id,
      key: r.suite_key,
      label: r.suite_label,
      kind: r.suite_kind,
      metadata: r.metadata,
      discoveredAt: r.discovered_at,
    })),
  });
}));

router.post("/integrations/:projectId/schedules", requireAuth, requireProjectAdmin, asyncHandler("Create schedule", async (req, res) => {
  const integration = await loadIntegrationForProject(req.projectId);
  if (!integration) return res.status(404).json({ error: "Integration not found" });
  const {
    name,
    triggerType,
    cronExpression,
    scheduleTimezone,
    testRepoRef,
    suiteMode,
    discoveredSuiteIds,
    runAllTests,
    runAsUserId,
    environmentId,
  } = req.body || {};
  if (!name || !triggerType || !suiteMode) {
    return res.status(400).json({ error: "name, triggerType, suiteMode are required" });
  }
  if (!["cron", "pr"].includes(triggerType)) {
    return res.status(400).json({ error: "triggerType must be 'cron' or 'pr'" });
  }
  if (!["fixed", "dynamic"].includes(suiteMode)) {
    return res.status(400).json({ error: "suiteMode must be 'fixed' or 'dynamic'" });
  }
  if (triggerType === "cron" && !cronExpression) {
    return res.status(400).json({ error: "cronExpression is required for cron triggerType" });
  }
  const suiteIds = Array.isArray(discoveredSuiteIds) ? discoveredSuiteIds.filter(Boolean) : [];
  if (suiteMode === "fixed" && !runAllTests && suiteIds.length === 0) {
    return res.status(400).json({ error: "Select at least one spec file or enable runAllTests for fixed suite mode" });
  }
  if (triggerType === "pr" && !integration.dev_repo_id) {
    return res.status(400).json({ error: "PR trigger requires a development repo to be connected. Add the dev repo in Settings → GitHub or use a cron schedule instead." });
  }
  if (suiteMode === "dynamic" && !integration.dev_repo_id) {
    return res.status(400).json({ error: "Dynamic test selection requires a development repo to be connected. Add the dev repo in Settings → GitHub." });
  }
  if (suiteMode === "dynamic" && triggerType !== "pr") {
    return res.status(400).json({ error: "Dynamic suite mode is only valid with PR trigger" });
  }
  if (suiteMode === "dynamic") {
    const aiKey = await query(
      `SELECT 1 FROM execute_project_ai_key_allocations a
       JOIN workspace_ai_keys k ON k.id = a.workspace_ai_key_id AND k.is_active = TRUE
       WHERE a.execute_project_id = $1`,
      [req.projectId]
    );
    if (!aiKey.rows.length) {
      return res.status(400).json({ error: "Allocate an AI key to this project before enabling dynamic suite selection" });
    }
  }
  const nextFire = triggerType === "cron" ? computeNextFire(cronExpression) : null;
  if (triggerType === "cron" && !nextFire) {
    return res.status(400).json({ error: "Invalid cronExpression" });
  }

  // Validate environmentId belongs to this project (FK only constrains existence,
  // not project scope — a determined caller could pass another project's UUID).
  if (environmentId) {
    if (!UUID_RE.test(String(environmentId))) {
      return res.status(400).json({ error: "Invalid environmentId" });
    }
    const envCheck = await query(
      `SELECT 1 FROM project_environments WHERE id = $1 AND execute_project_id = $2`,
      [environmentId, req.projectId]
    );
    if (!envCheck.rows.length) {
      return res.status(400).json({ error: "Environment not found in this project" });
    }
  }

  const result = await query(
    `INSERT INTO github_run_schedules
       (integration_id, name, trigger_type, cron_expression, schedule_timezone, test_repo_ref, suite_mode,
        discovered_suite_ids, run_all_tests, next_fire_at, created_by, run_as_user_id, environment_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::uuid[], $9, $10, $11, $12, $13)
     RETURNING *`,
    [
      integration.id,
      name,
      triggerType,
      cronExpression || null,
      scheduleTimezone || null,
      testRepoRef || "main",
      suiteMode,
      suiteIds,
      Boolean(runAllTests),
      nextFire,
      req.userId,
      runAsUserId || null,
      environmentId || null,
    ]
  );
  const newSchedule = result.rows[0];

  // Open a PR adding the GitHub Actions workflow file. The schedule is in
  // 'pending_workflow_merge' state until the customer merges this PR.
  // We do this opportunistically — if the App is missing permissions or the
  // PR creation fails, we record the failure on the schedule and continue.
  // The customer can retry from the UI.
  const workflowFilePath = await openWorkflowPrForSchedule({
    integration,
    schedule: newSchedule,
    suiteRows: await loadSuiteRows(newSchedule.discovered_suite_ids),
    project: await loadProjectForScheduleWorkflow(req.projectId),
  }).catch((err) => {
    logger.warn("Workflow PR creation failed (schedule remains in pending state)", {
      message: err.message,
      scheduleId: newSchedule.id,
    });
    return null;
  });

  // Fetch with user + environment join for consistent serialization
  const withUser = await query(
    `SELECT s.*,
            u.name AS run_as_user_name, u.email AS run_as_user_email,
            e.name AS environment_name, e.base_url AS environment_base_url
     FROM github_run_schedules s
     LEFT JOIN users u ON u.id = s.run_as_user_id
     LEFT JOIN project_environments e ON e.id = s.environment_id
     WHERE s.id = $1`,
    [newSchedule.id]
  );
  res.json(await serializeScheduleWithSuites(withUser.rows[0]));
}));

router.post("/integrations/:projectId/schedules/:id/trigger", requireAuth, requireProjectAdmin, async (req, res) => {
  const integration = await loadIntegrationForProject(req.projectId);
  if (!integration) return res.status(404).json({ error: "Integration not found" });
  const sched = await query(
    `SELECT * FROM github_run_schedules WHERE id = $1 AND integration_id = $2`,
    [req.params.id, integration.id]
  );
  if (!sched.rows.length) return res.status(404).json({ error: "Schedule not found" });
  const schedule = sched.rows[0];

  try {
    // "Run now" and the backend cron scheduler share one dispatch path
    // (scheduleDispatcher.dispatchScheduleRun): refresh the workflow file,
    // workflow_dispatch it, poll for the run, and record its URL. The only
    // difference is the trigger_source we stamp on the run-log row.
    const result = await dispatchScheduleRun({ integration, schedule, triggerSource: "manual" });
    if (!result.ok) {
      const status = result.code === "dynamic_unsupported" ? 400 : 409;
      return res.status(status).json({
        error: result.error,
        ...(result.workflowStatus ? { workflowStatus: result.workflowStatus } : {}),
        ...(result.setupPrUrl ? { setupPrUrl: result.setupPrUrl } : {}),
      });
    }
    res.json({
      ok: true,
      runLogId: result.runLogId,
      githubActionsRunUrl: result.githubActionsRunUrl,
      githubActionsRunId: result.githubActionsRunId,
    });
  } catch (err) {
    logger.error("Manual schedule trigger failed", {
      message: err.message,
      status: err.status,
      scheduleId: schedule.id,
    });
    res.status(502).json({
      error: "Failed to trigger workflow",
      detail: err.message,
    });
  }
});

router.get("/integrations/:projectId/schedules/:id/runs", requireAuth, requireProjectMember, asyncHandler("List schedule runs", async (req, res) => {
  const integration = await loadIntegrationForProject(req.projectId);
  if (!integration) return res.status(404).json({ error: "Integration not found" });
  const limit = Math.min(Number(req.query.limit) || 20, 100);
  const runs = await query(
    `SELECT id, trigger_source, suite_mode, pr_number, head_sha,
            execution_run_id, status, selected_tests, error_message, created_at, updated_at
     FROM github_schedule_run_log
     WHERE schedule_id = $1
     ORDER BY created_at DESC
     LIMIT $2`,
    [req.params.id, limit]
  );
  res.json({ runs: runs.rows.map(serializeRunLog) });
}));

router.patch("/integrations/:projectId/schedules/:id", requireAuth, requireProjectAdmin, asyncHandler("Update schedule", async (req, res) => {
  const integration = await loadIntegrationForProject(req.projectId);
  if (!integration) return res.status(404).json({ error: "Integration not found" });
  const {
    enabled,
    cronExpression,
    scheduleTimezone,
    discoveredSuiteIds,
    runAllTests,
    testRepoRef,
    name,
    runAsUserId,
    environmentId,
  } = req.body || {};
  const sets = [];
  const params = [];
  let idx = 1;
  if (enabled !== undefined) { sets.push(`enabled = $${idx++}`); params.push(!!enabled); }
  if (cronExpression !== undefined) {
    sets.push(`cron_expression = $${idx++}`);
    params.push(cronExpression);
    const next = cronExpression ? computeNextFire(cronExpression) : null;
    sets.push(`next_fire_at = $${idx++}`);
    params.push(next);
  }
  if (scheduleTimezone !== undefined) {
    sets.push(`schedule_timezone = $${idx++}`);
    params.push(scheduleTimezone || null);
  }
  if (discoveredSuiteIds !== undefined) {
    const ids = Array.isArray(discoveredSuiteIds) ? discoveredSuiteIds.filter(Boolean) : [];
    sets.push(`discovered_suite_ids = $${idx++}::uuid[]`);
    params.push(ids);
  }
  if (runAllTests !== undefined) { sets.push(`run_all_tests = $${idx++}`); params.push(!!runAllTests); }
  if (testRepoRef !== undefined) { sets.push(`test_repo_ref = $${idx++}`); params.push(testRepoRef); }
  if (name !== undefined) { sets.push(`name = $${idx++}`); params.push(name); }
  if (runAsUserId !== undefined) { sets.push(`run_as_user_id = $${idx++}`); params.push(runAsUserId || null); }
  if (environmentId !== undefined) {
    if (environmentId === null || environmentId === "") {
      sets.push(`environment_id = $${idx++}`);
      params.push(null);
    } else {
      if (!UUID_RE.test(String(environmentId))) {
        return res.status(400).json({ error: "Invalid environmentId" });
      }
      const envCheck = await query(
        `SELECT 1 FROM project_environments WHERE id = $1 AND execute_project_id = $2`,
        [environmentId, req.projectId]
      );
      if (!envCheck.rows.length) {
        return res.status(400).json({ error: "Environment not found in this project" });
      }
      sets.push(`environment_id = $${idx++}`);
      params.push(environmentId);
    }
  }
  if (sets.length === 0) return res.status(400).json({ error: "No fields to update" });
  sets.push(`updated_at = now()`);
  params.push(req.params.id);
  params.push(integration.id);
  await query(
    `UPDATE github_run_schedules SET ${sets.join(", ")}
     WHERE id = $${idx++} AND integration_id = $${idx}`,
    params
  );
  const updated = await query(
    `SELECT s.*,
            u.name AS run_as_user_name, u.email AS run_as_user_email,
            e.name AS environment_name, e.base_url AS environment_base_url
     FROM github_run_schedules s
     LEFT JOIN users u ON u.id = s.run_as_user_id
     LEFT JOIN project_environments e ON e.id = s.environment_id
     WHERE s.id = $1`,
    [req.params.id]
  );
  if (!updated.rows.length) return res.status(404).json({ error: "Schedule not found" });
  res.json(await serializeScheduleWithSuites(updated.rows[0]));
}));

/**
 * Recovery endpoint: (re)create the GitHub Actions workflow PR + repo secret
 * for an existing schedule. Used when:
 *   - schedule was created before Phase 1 (no workflow_file_path)
 *   - the original PR creation failed mid-Phase-1 (permissions, transient error)
 *   - user wants a fresh PR after deleting the workflow file
 */
router.post("/integrations/:projectId/schedules/:id/setup-workflow", requireAuth, requireProjectAdmin, asyncHandler("Setup workflow", async (req, res) => {
  const integration = await loadIntegrationForProject(req.projectId);
  if (!integration) return res.status(404).json({ error: "Integration not found" });
  const sched = await query(
    `SELECT * FROM github_run_schedules WHERE id = $1 AND integration_id = $2`,
    [req.params.id, integration.id]
  );
  if (!sched.rows.length) return res.status(404).json({ error: "Schedule not found" });
  const schedule = sched.rows[0];

  const filePath = await openWorkflowPrForSchedule({
    integration,
    schedule,
    suiteRows: await loadSuiteRows(schedule.discovered_suite_ids),
    project: await loadProjectForScheduleWorkflow(req.projectId),
  });

  const updated = await query(
    `SELECT s.*,
            u.name AS run_as_user_name, u.email AS run_as_user_email,
            e.name AS environment_name, e.base_url AS environment_base_url
     FROM github_run_schedules s
     LEFT JOIN users u ON u.id = s.run_as_user_id
     LEFT JOIN project_environments e ON e.id = s.environment_id
     WHERE s.id = $1`,
    [schedule.id]
  );
  res.json({ schedule: await serializeScheduleWithSuites(updated.rows[0]), workflowFilePath: filePath });
}));

/**
 * Recovery endpoint: check GitHub directly for the workflow file's presence
 * and update workflow_status accordingly. Used when the push webhook never
 * fired (e.g., the App isn't subscribed to push events yet) so the schedule
 * is stuck in 'pending_workflow_merge' even though the PR is merged.
 */
router.post("/integrations/:projectId/schedules/:id/resync-workflow", requireAuth, requireProjectAdmin, asyncHandler("Resync workflow status", async (req, res) => {
  const integration = await loadIntegrationForProject(req.projectId);
  if (!integration) return res.status(404).json({ error: "Integration not found" });
  const sched = await query(
    `SELECT * FROM github_run_schedules WHERE id = $1 AND integration_id = $2`,
    [req.params.id, integration.id]
  );
  if (!sched.rows.length) return res.status(404).json({ error: "Schedule not found" });
  const schedule = sched.rows[0];

  if (!schedule.workflow_file_path) {
    return res.status(409).json({
      error: "No workflow file path on this schedule. Use 'Setup workflow' first to open a PR.",
      code: "NO_WORKFLOW_FILE_PATH",
    });
  }

  const installationId = Number(integration.installation_id);
  const repo = integration.test_repo_full_name;
  const workflow = await getWorkflowByPath(installationId, repo, schedule.workflow_file_path);

  const newStatus = workflow ? "active" : "workflow_missing";
  const newDetail = workflow
    ? null
    : "Workflow file not found on default branch (re-detected on resync).";
  const mergedAtPatch = workflow
    ? `setup_pr_merged_at = COALESCE(setup_pr_merged_at, now()),`
    : "";

  await query(
    `UPDATE github_run_schedules
     SET workflow_status = $2,
         workflow_status_detail = $3,
         ${mergedAtPatch}
         updated_at = now()
     WHERE id = $1`,
    [schedule.id, newStatus, newDetail]
  );

  const updated = await query(
    `SELECT s.*,
            u.name AS run_as_user_name, u.email AS run_as_user_email,
            e.name AS environment_name, e.base_url AS environment_base_url
     FROM github_run_schedules s
     LEFT JOIN users u ON u.id = s.run_as_user_id
     LEFT JOIN project_environments e ON e.id = s.environment_id
     WHERE s.id = $1`,
    [schedule.id]
  );
  res.json({
    schedule: await serializeScheduleWithSuites(updated.rows[0]),
    workflowFound: Boolean(workflow),
  });
}));

// Re-attempt the TESBO_GRID_API_KEY repo-secret push for a single schedule.
// Used when the original openWorkflowPrForSchedule call couldn't write the
// secret (App lacked Secrets: Write, runner-api unavailable, etc.) and the
// user has since fixed the underlying cause. Mints a fresh project API key
// and encrypts+uploads it via the GitHub App. On success, flips
// repo_secret_configured to TRUE; on failure, returns the GitHub error so
// the UI can show what's still wrong.
router.post(
  "/integrations/:projectId/schedules/:id/retry-secret-config",
  requireAuth,
  requireProjectAdmin,
  asyncHandler("Retry repo secret config", async (req, res) => {
    const integration = await loadIntegrationForProject(req.projectId);
    if (!integration) return res.status(404).json({ error: "Integration not found" });
    const sched = await query(
      `SELECT * FROM github_run_schedules WHERE id = $1 AND integration_id = $2`,
      [req.params.id, integration.id]
    );
    if (!sched.rows.length) return res.status(404).json({ error: "Schedule not found" });
    const schedule = sched.rows[0];

    const rawApiKey = await provisionScheduleApiKey(
      integration.execute_project_id,
      schedule.name
    );
    if (!rawApiKey) {
      return res.status(502).json({
        error: "Tesbo Grid couldn't mint a project API key. Try again in a moment, or contact support if it persists.",
        code: "API_KEY_MINT_FAILED",
      });
    }

    try {
      await createOrUpdateRepoSecret(
        Number(integration.installation_id),
        integration.test_repo_full_name,
        WORKFLOW_API_KEY_SECRET_NAME,
        rawApiKey
      );
    } catch (err) {
      logger.warn("Retry: failed to push TESBO_GRID_API_KEY secret", {
        repo: integration.test_repo_full_name,
        message: err.message,
        status: err.status,
      });
      // 403 from GitHub almost always means the App lacks "Secrets: Read & Write"
      // on the repo. Surface that specifically so the user knows to re-authorize
      // the App rather than retry forever.
      const hint = err.status === 403
        ? "The GitHub App doesn't have permission to write repo secrets. Re-authorize the Tesbo Grid GitHub App and grant 'Secrets: Read & Write', then retry — or add the secret manually."
        : "Add the TESBO_GRID_API_KEY secret manually under repo Settings → Secrets and variables → Actions.";
      return res.status(502).json({
        error: `Couldn't push the repo secret: ${err.message}`,
        hint,
        code: "SECRET_PUSH_FAILED",
      });
    }

    // Clear the inline error from workflow_status_detail if it's the
    // "Repo secret …" string; leave other detail messages intact.
    const detailClause = "CASE WHEN workflow_status_detail LIKE 'Repo secret%' THEN NULL ELSE workflow_status_detail END";
    await query(
      `UPDATE github_run_schedules
         SET repo_secret_configured = TRUE,
             workflow_status_detail = ${detailClause},
             updated_at = now()
       WHERE id = $1`,
      [schedule.id]
    );

    const updated = await query(
      `SELECT s.*,
              u.name AS run_as_user_name, u.email AS run_as_user_email,
              e.name AS environment_name, e.base_url AS environment_base_url
       FROM github_run_schedules s
       LEFT JOIN users u ON u.id = s.run_as_user_id
       LEFT JOIN project_environments e ON e.id = s.environment_id
       WHERE s.id = $1`,
      [schedule.id]
    );
    res.json({ schedule: await serializeScheduleWithSuites(updated.rows[0]) });
  })
);

router.delete("/integrations/:projectId/schedules/:id", requireAuth, requireProjectAdmin, asyncHandler("Delete schedule", async (req, res) => {
  const integration = await loadIntegrationForProject(req.projectId);
  if (!integration) return res.status(404).json({ error: "Integration not found" });
  await query(
    `DELETE FROM github_run_schedules WHERE id = $1 AND integration_id = $2`,
    [req.params.id, integration.id]
  );
  res.json({ ok: true });
}));

githubWebhookRouter.post(
  "/",
  express.raw({ type: "*/*", limit: "5mb" }),
  async (req, res) => {
    const eventType = req.header("x-github-event");
    const sig = req.header("x-hub-signature-256");
    const deliveryId = req.header("x-github-delivery");
    if (!eventType) return res.status(400).send("missing event header");
    const rawBody = req.body;
    let payload;
    try { payload = JSON.parse(rawBody.toString("utf8")); }
    catch { return res.status(400).send("invalid json"); }

    if (eventType === "ping") {
      return res.json({ pong: true, deliveryId });
    }

    // ── push events: detect setup-PR merge or workflow-file deletion ────────
    if (eventType === "push") {
      return handlePushEvent(payload, rawBody, sig, res);
    }

    // ── workflow_run: link GitHub Actions runs to schedule_run_log ──────────
    if (eventType === "workflow_run") {
      return handleWorkflowRunEvent(payload, rawBody, sig, res);
    }

    if (eventType !== "pull_request") {
      return res.json({ ignored: eventType });
    }

    const action = payload.action;
    if (!["opened", "reopened", "synchronize"].includes(action)) {
      return res.json({ ignored: action });
    }

    const repoId = payload.repository?.id;
    const repoFullName = payload.repository?.full_name;
    if (!repoId) return res.status(400).send("missing repository");

    const integ = await query(
      `SELECT * FROM github_integrations WHERE dev_repo_id = $1`,
      [repoId]
    );
    const integration = integ.rows[0];
    if (!integration) return res.json({ ignored: "no integration for repo", repoFullName });

    if (!verifyWebhookSignature(rawBody, sig, integration.webhook_secret)) {
      return res.status(401).send("invalid signature");
    }

    const schedules = await query(
      `SELECT * FROM github_run_schedules
       WHERE integration_id = $1 AND trigger_type = 'pr' AND enabled = TRUE`,
      [integration.id]
    );
    if (!schedules.rows.length) return res.json({ ignored: "no PR schedules" });

    const pr = {
      number: payload.pull_request?.number,
      headSha: payload.pull_request?.head?.sha,
      baseSha: payload.pull_request?.base?.sha,
    };
    if (!pr.number || !pr.headSha) return res.status(400).send("malformed pull_request payload");

    res.json({ accepted: true, schedules: schedules.rows.length });

    for (const sched of schedules.rows) {
      triggerGithubRun({
        integrationId: integration.id,
        scheduleId: sched.id,
        pr,
        suiteMode: sched.suite_mode,
        fixedSuiteIds: sched.discovered_suite_ids || [],
        runAllTests: Boolean(sched.run_all_tests),
        repoRef: sched.test_repo_ref,
      }).catch((err) =>
        logger.error(`PR-triggered run failed (integration=${integration.id} schedule=${sched.id}): ${err.message}`)
      );
    }
  }
);

router.post(
  "/internal/run-events",
  async (req, res) => {
    if (!config.executionApiSharedToken || req.header("x-agent-token") !== config.executionApiSharedToken) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    const { event, runId } = req.body || {};
    if (!event || !runId) return res.status(400).json({ error: "event and runId are required" });
    if (event === "run.completed" || event === "run.cancelled" || event === "run.failed") {
      const status = event === "run.completed" ? "completed" : event === "run.cancelled" ? "cancelled" : "failed";
      handleRunCompletion({
        executionRunId: runId,
        status,
        summary: req.body.summary || null,
      }).catch((err) => logger.error("handleRunCompletion failed:", err.message));
    }
    res.json({ ok: true });
  }
);

function verifyWebhookSignature(rawBody, sigHeader, secret) {
  if (!sigHeader || !secret) return false;
  const expected = "sha256=" + crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  const a = Buffer.from(sigHeader);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

async function loadIntegrationForProject(projectId) {
  const r = await query(
    `SELECT * FROM github_integrations WHERE execute_project_id = $1`,
    [projectId]
  );
  return r.rows[0] || null;
}

function serializeIntegration(row) {
  return {
    id: row.id,
    projectId: row.execute_project_id,
    installationId: String(row.installation_id),
    accountLogin: row.github_account_login,
    devRepo: row.dev_repo_full_name
      ? { id: String(row.dev_repo_id), fullName: row.dev_repo_full_name }
      : null,
    testRepo: { id: String(row.test_repo_id), fullName: row.test_repo_full_name },
    webhookUrl: buildWebhookUrl(),
    createdAt: row.created_at,
  };
}

async function serializeScheduleWithSuites(row) {
  const suiteIds = row.discovered_suite_ids || [];
  const suiteRows = await loadSuiteRows(suiteIds);
  const orderedSuites = suiteIds
    .map((id) => suiteRows.find((s) => s.id === id))
    .filter(Boolean);
  return {
    id: row.id,
    name: row.name,
    triggerType: row.trigger_type,
    cronExpression: row.cron_expression,
    scheduleTimezone: row.schedule_timezone || null,
    testRepoRef: row.test_repo_ref,
    suiteMode: row.suite_mode,
    discoveredSuiteIds: suiteIds,
    runAllTests: Boolean(row.run_all_tests),
    selectedSuites: orderedSuites.map((s) => ({
      id: s.id,
      key: s.suite_key,
      label: s.suite_label,
      kind: s.suite_kind,
      path: s.metadata?.path || null,
    })),
    enabled: row.enabled,
    lastFiredAt: row.last_fired_at,
    nextFireAt: row.next_fire_at,
    createdAt: row.created_at,
    runAsUserId: row.run_as_user_id || null,
    runAsUserName: row.run_as_user_name || null,
    runAsUserEmail: row.run_as_user_email || null,
    environmentId: row.environment_id || null,
    environmentName: row.environment_name || null,
    environmentBaseUrl: row.environment_base_url || null,
    workflowFilePath: row.workflow_file_path || null,
    workflowStatus: row.workflow_status || null,
    workflowStatusDetail: row.workflow_status_detail || null,
    setupPrUrl: row.setup_pr_url || null,
    setupPrNumber: row.setup_pr_number || null,
    setupPrMergedAt: row.setup_pr_merged_at || null,
    repoSecretConfigured: Boolean(row.repo_secret_configured),
  };
}

function serializeRunLog(row) {
  return {
    id: row.id,
    triggerSource: row.trigger_source,
    suiteMode: row.suite_mode,
    prNumber: row.pr_number,
    headSha: row.head_sha,
    executionRunId: row.execution_run_id,
    status: row.status,
    selectedTests: row.selected_tests,
    errorMessage: row.error_message,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    githubActionsRunId: row.github_actions_run_id ? String(row.github_actions_run_id) : null,
    githubActionsRunUrl: row.github_actions_run_url || null,
    githubActionsRunNumber: row.github_actions_run_number || null,
  };
}

/**
 * Mint a project-scoped Tesbo Grid API key for use inside a GitHub Actions
 * workflow. Returns null if the runner-api isn't configured or returns an
 * error — caller should fall back to manual instructions.
 */
async function provisionScheduleApiKey(projectId, scheduleName) {
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
        name: `GitHub Actions — ${scheduleName}`.slice(0, 80),
        projectId,
        scopes: ["runs:write", "runs:read", "queue:read"],
      }),
    });
    if (!res.ok) {
      logger.warn("provisionScheduleApiKey: runner-api returned non-OK", { status: res.status });
      return null;
    }
    const body = await res.json();
    return body?.key || null;
  } catch (err) {
    logger.warn("provisionScheduleApiKey failed", { message: err.message });
    return null;
  }
}

async function openWorkflowPrForSchedule({ integration, schedule, suiteRows, project }) {
  const installationId = Number(integration.installation_id);
  const repo = integration.test_repo_full_name;
  const defaultBranch = await getDefaultBranch(installationId, repo);
  const { framework, language, browser } = inferFrameworkAndLanguage(project);
  const filePath = workflowFilePathForSchedule(schedule);
  const environment = await loadScheduleEnvironment(schedule.environment_id);
  // Push secret env vars to GitHub repo secrets BEFORE the workflow runs.
  // Inlined (non-secret) values land in the committed YAML and need no sync.
  await syncEnvironmentSecrets(installationId, repo, environment);
  const yaml = generateWorkflowYaml({
    schedule,
    suites: suiteRows,
    runAllTests: Boolean(schedule.run_all_tests),
    apiBaseUrl: config.runnerPublicApiUrl,
    projectId: integration.execute_project_id,
    framework,
    language,
    browser,
    environment,
  });

  // Try to mint an API key and push it as a repo secret BEFORE opening the
  // PR. This determines whether the PR body says "secret is configured" or
  // "please add the secret manually". Failures are non-fatal — the workflow
  // file still gets committed; the user can add the secret themselves.
  let secretConfigured = false;
  let secretConfigError = null;
  const rawApiKey = await provisionScheduleApiKey(
    integration.execute_project_id,
    schedule.name
  );
  if (rawApiKey) {
    try {
      await createOrUpdateRepoSecret(
        installationId,
        repo,
        WORKFLOW_API_KEY_SECRET_NAME,
        rawApiKey
      );
      secretConfigured = true;
    } catch (err) {
      secretConfigError = err.message;
      logger.warn("Failed to push TESBO_GRID_API_KEY secret", {
        repo,
        message: err.message,
        status: err.status,
      });
    }
  } else {
    secretConfigError = "Tesbo Grid couldn't mint an API key for this schedule.";
  }

  const branchName = `tesbo-grid/workflow-${schedule.id.toString().replace(/[^a-z0-9-]/gi, "").slice(0, 12)}`;
  const prTitle = `Add Tesbo Grid workflow: ${schedule.name}`;
  const prBody = [
    `This PR adds the GitHub Actions workflow for the Tesbo Grid scheduled run **${schedule.name}**.`,
    "",
    "Once merged, the workflow will:",
    schedule.trigger_type === "cron"
      ? `- Run on the cron schedule \`${schedule.cron_expression}\``
      : "- Be available as a manual workflow_dispatch",
    "- Invoke `@tesbox/cli`, which submits the run to Tesbo Grid",
    "- Stream live logs in GitHub Actions (your tests still execute on Tesbo Grid infrastructure)",
    "",
    secretConfigured
      ? `> ✅ The required \`${WORKFLOW_API_KEY_SECRET_NAME}\` repo secret has been set automatically by Tesbo Grid. No action needed.`
      : `> ⚠️ Tesbo Grid couldn't set the \`${WORKFLOW_API_KEY_SECRET_NAME}\` repo secret automatically${secretConfigError ? ` (${secretConfigError})` : ""}. Add it manually under **Settings → Secrets and variables → Actions** before the first run, using a Tesbo Grid project API key.`,
    "",
    "Tesbo Grid manages this file. To change the schedule, edit it from your project's Scheduled Runs page.",
  ].join("\n");

  const result = await createFilePullRequest(installationId, repo, {
    baseBranch: defaultBranch,
    branchName,
    filePath,
    fileContent: yaml,
    commitMessage: `chore: add Tesbo Grid workflow for ${schedule.name}`,
    prTitle,
    prBody,
  });

  const statusDetail = secretConfigured
    ? null
    : `Repo secret ${WORKFLOW_API_KEY_SECRET_NAME} not auto-configured: ${secretConfigError || "unknown"}`;

  await query(
    `UPDATE github_run_schedules
       SET workflow_file_path = $2,
           setup_pr_url = $3,
           setup_pr_number = $4,
           workflow_status = 'pending_workflow_merge',
           workflow_status_detail = $5,
           repo_secret_configured = $6,
           updated_at = now()
     WHERE id = $1`,
    [schedule.id, filePath, result.prUrl, result.prNumber, statusDetail, secretConfigured]
  );

  return filePath;
}

function buildWebhookUrl() {
  const base = process.env.PUBLIC_BACKEND_URL || `http://localhost:${config.port}`;
  return `${base.replace(/\/+$/, "")}/api/github/webhooks`;
}

// ── Webhook helpers ──────────────────────────────────────────────────────

async function findIntegrationForWebhookRepo(repoId) {
  if (!repoId) return null;
  // The test_repo and dev_repo may be the same or different; check both.
  const r = await query(
    `SELECT * FROM github_integrations
     WHERE test_repo_id = $1 OR dev_repo_id = $1
     LIMIT 1`,
    [repoId]
  );
  return r.rows[0] || null;
}

/**
 * push event: detect when a Tesbo Grid setup PR is merged (workflow becomes
 * active) or when someone removes the workflow file (workflow_missing).
 */
async function handlePushEvent(payload, rawBody, sig, res) {
  const repoId = payload.repository?.id;
  const refType = payload.ref || "";
  const defaultBranch = payload.repository?.default_branch || "";
  const integration = await findIntegrationForWebhookRepo(repoId);
  if (!integration) return res.json({ ignored: "no integration for repo" });
  if (!verifyWebhookSignature(rawBody, sig, integration.webhook_secret)) {
    return res.status(401).send("invalid signature");
  }
  if (refType !== `refs/heads/${defaultBranch}`) {
    return res.json({ ignored: "non-default-branch push" });
  }

  // Aggregate added/modified/removed file lists from all commits.
  const added = new Set();
  const modified = new Set();
  const removed = new Set();
  for (const commit of Array.isArray(payload.commits) ? payload.commits : []) {
    (commit.added || []).forEach((f) => added.add(f));
    (commit.modified || []).forEach((f) => modified.add(f));
    (commit.removed || []).forEach((f) => removed.add(f));
  }
  const touched = new Set([...added, ...modified, ...removed]);
  if (touched.size === 0) return res.json({ ignored: "no files touched" });

  // Find schedules whose workflow_file_path was touched by this push.
  const r = await query(
    `SELECT id, workflow_file_path, workflow_status
     FROM github_run_schedules
     WHERE integration_id = $1
       AND workflow_file_path = ANY($2::text[])`,
    [integration.id, [...touched]]
  );

  const updates = [];
  for (const sched of r.rows) {
    const wasRemoved = removed.has(sched.workflow_file_path);
    if (wasRemoved) {
      await query(
        `UPDATE github_run_schedules
         SET workflow_status = 'workflow_missing',
             workflow_status_detail = 'Workflow file removed from default branch.',
             updated_at = now()
         WHERE id = $1`,
        [sched.id]
      );
      updates.push({ scheduleId: sched.id, status: "workflow_missing" });
    } else if (sched.workflow_status !== "active") {
      // File added or re-added — flip to active and record merge time.
      await query(
        `UPDATE github_run_schedules
         SET workflow_status = 'active',
             workflow_status_detail = NULL,
             setup_pr_merged_at = COALESCE(setup_pr_merged_at, now()),
             updated_at = now()
         WHERE id = $1`,
        [sched.id]
      );
      updates.push({ scheduleId: sched.id, status: "active" });
    }
  }

  return res.json({ accepted: true, updates });
}

/**
 * workflow_run event: GitHub fires this when a workflow run is queued,
 * started, or completed. We attach the GitHub Actions run URL to the
 * corresponding github_schedule_run_log row so the user can click through.
 */
async function handleWorkflowRunEvent(payload, rawBody, sig, res) {
  const action = payload.action;
  const run = payload.workflow_run;
  if (!run) return res.json({ ignored: "no workflow_run" });
  const repoId = payload.repository?.id;
  const integration = await findIntegrationForWebhookRepo(repoId);
  if (!integration) return res.json({ ignored: "no integration for repo" });
  if (!verifyWebhookSignature(rawBody, sig, integration.webhook_secret)) {
    return res.status(401).send("invalid signature");
  }

  // Find the schedule via the workflow's file path (run.path is the
  // workflow file path relative to repo root).
  const workflowPath = run.path || "";
  const sched = await query(
    `SELECT id, suite_mode FROM github_run_schedules
     WHERE integration_id = $1 AND workflow_file_path = $2`,
    [integration.id, workflowPath]
  );
  const schedule = sched.rows[0];
  if (!schedule) return res.json({ ignored: "no schedule for workflow path" });

  const ghStatus = mapGithubRunStatus(run);
  const existing = await query(
    `SELECT id FROM github_schedule_run_log WHERE github_actions_run_id = $1 LIMIT 1`,
    [run.id]
  );

  if (existing.rows.length) {
    // A run we already track changed status — refresh it in place.
    await query(
      `UPDATE github_schedule_run_log
       SET status = $2,
           github_actions_run_url = $3,
           github_actions_run_number = $4,
           updated_at = now()
       WHERE id = $1`,
      [existing.rows[0].id, ghStatus, run.html_url, run.run_number]
    );
  } else {
    // No row carries this run id yet. Tesbo Grid dispatches every run itself
    // (manual "Run now" or the backend cron) and records a run-log row up front,
    // polling for this run id — so a row almost always exists. If the poll
    // missed it, that row is still unlinked: match the closest recent unlinked
    // row for this schedule and link it, rather than inserting a duplicate.
    const candidate = await query(
      `SELECT id FROM github_schedule_run_log
       WHERE schedule_id = $1
         AND github_actions_run_id IS NULL
         AND status NOT IN ('completed', 'failed', 'cancelled', 'no_suites')
         AND created_at BETWEEN ($2::timestamptz - interval '30 minutes')
                            AND ($2::timestamptz + interval '30 minutes')
       ORDER BY abs(extract(epoch FROM (created_at - $2::timestamptz)))
       LIMIT 1`,
      [schedule.id, run.created_at]
    );
    const targetId = candidate.rows[0]?.id || null;

    if (targetId) {
      await query(
        `UPDATE github_schedule_run_log
         SET status = $2,
             github_actions_run_id = $3,
             github_actions_run_url = $4,
             github_actions_run_number = $5,
             updated_at = now()
         WHERE id = $1`,
        [targetId, ghStatus, run.id, run.html_url, run.run_number]
      );
    } else {
      // Truly orphaned run we never recorded (e.g. dispatched straight from the
      // GitHub UI). Record it so it still shows up in history. The GH event
      // tells manual (workflow_dispatch) from scheduled (schedule).
      const triggerSource = run.event === "schedule" ? "automated" : "manual";
      await query(
        `INSERT INTO github_schedule_run_log
           (schedule_id, integration_id, trigger_source, suite_mode, status,
            github_actions_run_id, github_actions_run_url, github_actions_run_number)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [schedule.id, integration.id, triggerSource, schedule.suite_mode, ghStatus,
         run.id, run.html_url, run.run_number]
      );
    }
  }

  return res.json({ accepted: true, action, scheduleId: schedule.id });
}

function mapGithubRunStatus(run) {
  if (run.status === "completed") {
    return run.conclusion === "success" ? "completed"
      : run.conclusion === "cancelled" ? "cancelled"
      : "failed";
  }
  return "running";
}

export default router;
