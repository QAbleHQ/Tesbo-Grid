import { query } from "../../db/database.js";
import { logger } from "../../logger.js";
import {
  listPullRequestFiles,
  createPRComment,
  updatePRComment,
} from "./client.js";
import {
  discoverSuitesForIntegration,
  listSuitesForIntegration,
} from "./suiteDiscovery.js";
import { selectTestsForDiff } from "./aiSuiteSelector.js";

export async function triggerGithubRun({
  integrationId,
  scheduleId = null,
  pr = null,
  suiteMode,
  fixedSuiteIds = [],
  runAllTests = false,
  repoRef,
  triggerSource = "automated",
}) {
  const integration = await loadIntegration(integrationId);
  if (!integration) throw new Error("Integration not found");

  const project = await loadProject(integration.execute_project_id);
  if (!project) throw new Error("Project not found");

  let suites;
  let aiReasoning = null;
  if (suiteMode === "dynamic") {
    const aiKey = await loadAiKeyForProject(project.id);
    if (!aiKey) throw new Error("Dynamic suite mode requires an AI key allocated to the project");
    if (!pr) throw new Error("Dynamic suite mode requires a pull request context");
    await discoverSuitesForIntegration({
      integrationId,
      installationId: Number(integration.installation_id),
      testRepoFullName: integration.test_repo_full_name,
      repoRef,
    });
    const available = await listSuitesForIntegration(integrationId, repoRef);
    const changed = await listPullRequestFiles(
      Number(integration.installation_id),
      integration.dev_repo_full_name,
      pr.number
    );
    const selection = await selectTestsForDiff({
      aiKey,
      changedFiles: changed,
      availableSuites: available,
    });
    suites = available.filter((s) => selection.suiteIds.includes(s.id));
    aiReasoning = selection.reasoning;
  } else if (runAllTests) {
    await discoverSuitesForIntegration({
      integrationId,
      installationId: Number(integration.installation_id),
      testRepoFullName: integration.test_repo_full_name,
      repoRef,
    });
    suites = await listSuitesForIntegration(integrationId, repoRef);
  } else {
    if (!fixedSuiteIds || fixedSuiteIds.length === 0) {
      throw new Error("Fixed suite mode requires at least one suite id or runAllTests=true");
    }
    const rows = await query(
      `SELECT * FROM github_repo_suites
       WHERE id = ANY($1::uuid[]) AND integration_id = $2`,
      [fixedSuiteIds, integrationId]
    );
    if (!rows.rows.length) throw new Error("No matching suites found");
    suites = rows.rows;
  }

  if (suites.length === 0) {
    logger.warn(`GitHub run trigger: no suites resolved for integration ${integrationId}`);
    if (pr) await postNoSuitesComment({ integration, pr, reasoning: aiReasoning });
    if (scheduleId) {
      await insertRunLog({ integrationId, scheduleId, triggerSource, suiteMode, pr, suites: [], status: "no_suites" });
    }
    return null;
  }

  const externalRef = pr ? `gh:${pr.number}:${pr.headSha}` : `gh-cron:${scheduleId}:${Date.now()}`;

  let commentId = null;
  if (pr) {
    const body = renderStartingComment({ suites, aiReasoning, integration });
    commentId = await createPRComment(
      Number(integration.installation_id),
      integration.dev_repo_full_name,
      pr.number,
      body
    );
  }

  const prRunRow = pr
    ? await insertPrRun({
        integrationId,
        scheduleId,
        pr,
        suiteMode,
        selectedSuites: suites,
        aiReasoning,
        commentId,
      })
    : null;

  // Runner dispatch is intentionally skipped in this iteration: the runner
  // workers do not yet support cloning a customer's GitHub repo and running
  // a discovered suite from it. Schedule + PR-comment lifecycle is fully
  // wired so the worker extension can plug in by calling postRunToExecutionApi
  // and then UPDATE github_pr_runs.execution_run_id once the bundle pipeline
  // exists.
  logger.info(
    `GitHub run intent recorded: integration=${integrationId} suites=${suites.length} ` +
    `mode=${suiteMode} pr=${pr?.number ?? "none"} ref=${externalRef}`
  );

  if (prRunRow) {
    await query(
      `UPDATE github_pr_runs SET status = 'recorded', updated_at = now() WHERE id = $1`,
      [prRunRow.id]
    );
  }

  const runLogRow = scheduleId
    ? await insertRunLog({ integrationId, scheduleId, triggerSource, suiteMode, pr, suites, status: "recorded" })
    : null;

  return { runId: null, externalRef, prRunId: prRunRow?.id || null, runLogId: runLogRow?.id || null };
}

async function loadIntegration(id) {
  const r = await query(`SELECT * FROM github_integrations WHERE id = $1`, [id]);
  return r.rows[0] || null;
}

async function loadProject(id) {
  const r = await query(
    `SELECT id, organization_id, settings FROM execute_projects WHERE id = $1`,
    [id]
  );
  return r.rows[0] || null;
}

async function loadAiKeyForProject(projectId) {
  const r = await query(
    `SELECT k.id, k.provider, k.api_key, k.default_model
     FROM execute_project_ai_key_allocations a
     JOIN workspace_ai_keys k ON k.id = a.workspace_ai_key_id
     WHERE a.execute_project_id = $1 AND k.is_active = TRUE`,
    [projectId]
  );
  return r.rows[0] || null;
}

async function insertPrRun({ integrationId, scheduleId, pr, suiteMode, selectedSuites, aiReasoning, commentId }) {
  const r = await query(
    `INSERT INTO github_pr_runs
       (integration_id, schedule_id, pr_number, head_sha, base_sha, comment_id, suite_mode, selected_tests, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, 'pending')
     RETURNING id`,
    [
      integrationId,
      scheduleId,
      pr.number,
      pr.headSha,
      pr.baseSha || null,
      commentId,
      suiteMode,
      JSON.stringify({
        suites: selectedSuites.map((s) => ({ id: s.id, key: s.suite_key, label: s.suite_label })),
        reasoning: aiReasoning,
      }),
    ]
  );
  return r.rows[0];
}

function renderStartingComment({ suites, aiReasoning, integration }) {
  const lines = [
    "### Tesbo Grid — test plan recorded",
    "",
    `Test repo: \`${integration.test_repo_full_name}\``,
    "",
    `Selected ${suites.length} suite(s):`,
    ...suites.map((s) => `- \`${s.suite_label}\` (\`${s.suite_kind}\`)`),
  ];
  if (aiReasoning) {
    lines.push("", "_AI selection rationale:_ " + aiReasoning);
  }
  lines.push(
    "",
    "_Execution will start automatically once the Tesbo runner finishes provisioning for this repo._"
  );
  return lines.join("\n");
}

async function postNoSuitesComment({ integration, pr, reasoning }) {
  try {
    await createPRComment(
      Number(integration.installation_id),
      integration.dev_repo_full_name,
      pr.number,
      `### Tesbo Grid — no suites to run\n\nNo matching test suites were resolved for this change.\n\n${reasoning || ""}`
    );
  } catch (err) {
    logger.warn("Failed to post no-suites comment:", err.message);
  }
}

async function insertRunLog({ integrationId, scheduleId, triggerSource, suiteMode, pr, suites, status }) {
  const selectedTests = suites.length
    ? JSON.stringify({ suites: suites.map((s) => ({ id: s.id, key: s.suite_key, label: s.suite_label })) })
    : null;
  const r = await query(
    `INSERT INTO github_schedule_run_log
       (schedule_id, integration_id, trigger_source, suite_mode, pr_number, head_sha, status, selected_tests)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
     RETURNING id`,
    [scheduleId, integrationId, triggerSource, suiteMode, pr?.number || null, pr?.headSha || null, status, selectedTests]
  );
  return r.rows[0];
}

export async function handleRunCompletion({ executionRunId, status, summary }) {
  const r = await query(
    `SELECT pr.*, gi.installation_id, gi.dev_repo_full_name
     FROM github_pr_runs pr
     JOIN github_integrations gi ON gi.id = pr.integration_id
     WHERE pr.execution_run_id = $1`,
    [executionRunId]
  );
  const prRun = r.rows[0];
  if (!prRun || !prRun.comment_id) return;
  const body = renderCompletionComment({ status, summary });
  await updatePRComment(
    Number(prRun.installation_id),
    prRun.dev_repo_full_name,
    Number(prRun.comment_id),
    body
  );
  await query(
    `UPDATE github_pr_runs SET status = $1, updated_at = now() WHERE id = $2`,
    [status, prRun.id]
  );
  await query(
    `UPDATE github_schedule_run_log
     SET status = $1, execution_run_id = $2, updated_at = now()
     WHERE execution_run_id = $2 OR (pr_number = $3 AND integration_id = $4 AND status NOT IN ('completed','failed','cancelled'))`,
    [status, executionRunId, prRun.pr_number, prRun.integration_id]
  );
}

function renderCompletionComment({ status, summary }) {
  const icon = status === "completed" ? "✅" : status === "cancelled" ? "⏹" : "❌";
  const lines = [`### ${icon} Tesbo Grid — run ${status}`];
  if (summary) {
    if (summary.totalTests != null) {
      lines.push("", `Tests: ${summary.passed ?? 0} passed · ${summary.failed ?? 0} failed · ${summary.skipped ?? 0} skipped (of ${summary.totalTests})`);
    }
    if (summary.durationMs != null) {
      lines.push(`Duration: ${Math.round(summary.durationMs / 1000)}s`);
    }
    if (summary.reportUrl) {
      lines.push("", `[View report](${summary.reportUrl})`);
    }
  }
  return lines.join("\n");
}
