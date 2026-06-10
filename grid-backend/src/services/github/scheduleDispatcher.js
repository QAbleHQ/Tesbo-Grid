// Dispatches a schedule's GitHub Actions workflow and records the run.
//
// Tesbo Grid controls *all* scheduled-run triggering from its own scheduler:
// the generated workflow only exposes `workflow_dispatch` (see
// workflowGenerator.js), and both the manual "Run now" route and the backend
// cron scheduler call dispatchScheduleRun() here. Dispatching ourselves lets us
// capture the GitHub Actions run URL at trigger time and attach it to the
// schedule's run-log row, so the user can open the build and view its logs —
// for automated runs exactly like a manual one.

import { query } from "../../db/database.js";
import { config } from "../../config.js";
import { logger } from "../../logger.js";
import {
  getDefaultBranch,
  getWorkflowByPath,
  dispatchWorkflow,
  listRecentWorkflowRuns,
  updateFileOnBranch,
  createOrUpdateRepoSecret,
} from "./client.js";
import { generateWorkflowYaml } from "./workflowGenerator.js";

export async function loadSuiteRows(suiteIds) {
  if (!suiteIds || suiteIds.length === 0) return [];
  const r = await query(
    `SELECT * FROM github_repo_suites WHERE id = ANY($1::uuid[])`,
    [suiteIds]
  );
  return r.rows;
}

// Load the AUT environment attached to a schedule (or null). Shape matches
// what workflowGenerator.generateWorkflowYaml() expects under args.environment.
export async function loadScheduleEnvironment(environmentId) {
  if (!environmentId) return null;
  const r = await query(
    `SELECT id, name, base_url, variables FROM project_environments WHERE id = $1`,
    [environmentId]
  );
  if (!r.rows.length) return null;
  const row = r.rows[0];
  return {
    id: row.id,
    name: row.name,
    baseUrl: row.base_url,
    variables: Array.isArray(row.variables) ? row.variables : [],
  };
}

// Push each secret-flagged variable of the environment to the test repo as a
// GitHub Actions secret. Non-secret vars are inlined in the YAML by the
// generator, so they don't need a secret push. Returns { pushed, failed } —
// failures are non-fatal; the user can re-add the secret manually.
export async function syncEnvironmentSecrets(installationId, repo, environment) {
  if (!environment) return { pushed: 0, failed: [] };
  const secretVars = (environment.variables || []).filter((v) => v?.isSecret && v?.key);
  let pushed = 0;
  const failed = [];
  for (const v of secretVars) {
    try {
      await createOrUpdateRepoSecret(installationId, repo, v.key, v.value ?? "");
      pushed += 1;
    } catch (err) {
      failed.push({ key: v.key, message: err.message });
      logger.warn("Failed to push environment secret", {
        repo,
        key: v.key,
        message: err.message,
        status: err.status,
      });
    }
  }
  return { pushed, failed };
}

export async function loadProjectForScheduleWorkflow(projectId) {
  const r = await query(
    `SELECT id, settings FROM execute_projects WHERE id = $1`,
    [projectId]
  );
  return r.rows[0] || null;
}

export function inferFrameworkAndLanguage(project) {
  const settings = project?.settings || {};
  return {
    framework: String(settings.framework || "playwright").toLowerCase(),
    language: String(settings.language || "javascript").toLowerCase(),
    browser: String(settings.browser || "chrome").toLowerCase(),
  };
}

// Refresh the committed workflow file from the current schedule + project
// configuration before dispatching. The schedule's workflow file is written
// once at setup time; if the generator changes (e.g. dropping the `schedule:`
// cron, fixing a wrong --api-url) existing schedules would otherwise keep
// running the stale YAML. Idempotent — no commit when the file already matches.
// Failures are swallowed: the existing file may still work, and we don't want a
// refresh hiccup to block the dispatch.
async function refreshWorkflowFile({ installationId, repo, defaultBranch, schedule, projectId }) {
  try {
    const project = await loadProjectForScheduleWorkflow(projectId);
    const { framework, language, browser } = inferFrameworkAndLanguage(project);
    const suiteRows = await loadSuiteRows(schedule.discovered_suite_ids);
    const environment = await loadScheduleEnvironment(schedule.environment_id);
    // Refresh GitHub Secrets too — if the user updated a secret value in the
    // environment, we want it live before the next run.
    await syncEnvironmentSecrets(installationId, repo, environment);
    const freshYaml = generateWorkflowYaml({
      schedule,
      suites: suiteRows,
      runAllTests: Boolean(schedule.run_all_tests),
      apiBaseUrl: config.runnerPublicApiUrl,
      projectId,
      framework,
      language,
      browser,
      environment,
    });
    const syncResult = await updateFileOnBranch(installationId, repo, {
      filePath: schedule.workflow_file_path,
      branch: defaultBranch,
      fileContent: freshYaml,
      commitMessage: `chore(tesbo-grid): refresh workflow for ${schedule.name}`,
    });
    if (syncResult.updated) {
      logger.info("Refreshed workflow file before dispatch", {
        scheduleId: schedule.id,
        repo,
        filePath: schedule.workflow_file_path,
      });
    }
  } catch (err) {
    logger.warn("Workflow file refresh before dispatch failed", {
      scheduleId: schedule.id,
      message: err.message,
      status: err.status,
    });
  }
}

/**
 * Dispatch a schedule's workflow via workflow_dispatch, poll briefly for the
 * created run, and record a github_schedule_run_log row carrying the GitHub
 * Actions run URL.
 *
 * @param {object} args
 * @param {object} args.integration   — github_integrations row
 * @param {object} args.schedule      — github_run_schedules row
 * @param {"manual"|"automated"} args.triggerSource
 * @returns {Promise<object>} On success: { ok:true, runLogId, githubActionsRunUrl,
 *   githubActionsRunId, githubActionsRunNumber }. On a precondition failure:
 *   { ok:false, code, error, workflowStatus?, setupPrUrl? }. Throws only on an
 *   unexpected GitHub API / dispatch error.
 */
export async function dispatchScheduleRun({ integration, schedule, triggerSource = "automated" }) {
  if (schedule.suite_mode === "dynamic") {
    return {
      ok: false,
      code: "dynamic_unsupported",
      error: "Dynamic schedules require a pull request context — use the PR trigger instead.",
    };
  }
  if (!schedule.workflow_file_path) {
    return {
      ok: false,
      code: "no_workflow_file",
      error: "This schedule has no GitHub Actions workflow file yet. Re-create the schedule so Tesbo Grid can open the setup PR.",
    };
  }
  if (schedule.workflow_status !== "active") {
    return {
      ok: false,
      code: "workflow_not_active",
      workflowStatus: schedule.workflow_status,
      setupPrUrl: schedule.setup_pr_url || null,
      error: schedule.workflow_status === "pending_workflow_merge"
        ? "Merge the Tesbo Grid setup PR first — the workflow file isn't on the default branch yet."
        : schedule.workflow_status === "workflow_missing"
          ? "The GitHub Actions workflow file was removed from the repo. Re-create the schedule to add it back."
          : `Workflow is not active (status: ${schedule.workflow_status}). ${schedule.workflow_status_detail || ""}`.trim(),
    };
  }

  const installationId = Number(integration.installation_id);
  const repo = integration.test_repo_full_name;
  const projectId = integration.execute_project_id;
  const defaultBranch = await getDefaultBranch(installationId, repo).catch(() => "main");

  // Resolve workflow_id from the file path. GitHub assigns this once the file
  // lands on the default branch — if it's missing, the merge hasn't happened
  // yet (or the file was deleted).
  const workflow = await getWorkflowByPath(installationId, repo, schedule.workflow_file_path);
  if (!workflow) {
    await query(
      `UPDATE github_run_schedules SET workflow_status = 'workflow_missing',
         workflow_status_detail = $2, updated_at = now() WHERE id = $1`,
      [schedule.id, "Workflow file not found on default branch when a run was triggered."]
    );
    return {
      ok: false,
      code: "workflow_missing",
      workflowStatus: "workflow_missing",
      error: "Workflow file isn't present on the default branch. Merge the setup PR or re-create the schedule.",
    };
  }

  await refreshWorkflowFile({ installationId, repo, defaultBranch, schedule, projectId });

  await dispatchWorkflow(installationId, repo, {
    workflowId: workflow.id,
    ref: defaultBranch,
    inputs: {},
  });

  // workflow_dispatch returns 204 with no body; poll briefly for the new run so
  // we can record its URL on the run-log row immediately.
  let dispatched = null;
  for (let i = 0; i < 5; i += 1) {
    await new Promise((r) => setTimeout(r, 1500));
    const runs = await listRecentWorkflowRuns(installationId, repo, workflow.id, 5).catch(() => []);
    dispatched = runs.find((r) =>
      r.event === "workflow_dispatch" && Date.now() - new Date(r.created_at).getTime() < 60_000
    );
    if (dispatched) break;
  }

  const runLog = await query(
    `INSERT INTO github_schedule_run_log
       (schedule_id, integration_id, trigger_source, suite_mode, status,
        github_actions_run_id, github_actions_run_url, github_actions_run_number)
     VALUES ($1, $2, $3, $4, 'running', $5, $6, $7)
     RETURNING id`,
    [
      schedule.id,
      integration.id,
      triggerSource,
      schedule.suite_mode,
      dispatched?.id || null,
      dispatched?.html_url || null,
      dispatched?.run_number || null,
    ]
  );

  return {
    ok: true,
    runLogId: runLog.rows[0].id,
    githubActionsRunUrl: dispatched?.html_url || null,
    githubActionsRunId: dispatched?.id || null,
    githubActionsRunNumber: dispatched?.run_number || null,
  };
}
