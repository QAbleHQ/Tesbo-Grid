import { query } from "../db/database.js";
import { logger } from "../logger.js";
import { config } from "../config.js";
import { sendEmail } from "../email.js";

const METRIC_LABELS = {
  pass_ratio: "Pass ratio",
  failure_rate: "Failure rate",
  flaky_tests: "Flaky tests",
};

function metricLabel(metric) {
  return METRIC_LABELS[metric] || metric;
}

function severityFor(metric, observed, threshold) {
  // simple heuristic: bigger gap = higher severity
  const gap = Math.abs(Number(observed) - Number(threshold));
  if (metric === "flaky_tests") {
    if (gap >= 5) return "High";
    if (gap >= 2) return "Medium";
    return "Low";
  }
  if (gap >= 25) return "High";
  if (gap >= 10) return "Medium";
  return "Low";
}

function comparePasses(operator, observed, threshold) {
  if (operator === "below") return Number(observed) < Number(threshold);
  if (operator === "above") return Number(observed) > Number(threshold);
  return false;
}

function formatValue(metric, value, unit) {
  if (value == null) return "—";
  const numeric = Number(value);
  if (Number.isNaN(numeric)) return String(value);
  if (unit === "%") return `${numeric.toFixed(2)}%`;
  if (unit === "tests") return `${Math.round(numeric)} test${Math.round(numeric) === 1 ? "" : "s"}`;
  return String(numeric);
}

function buildRunUrl(projectId, runId) {
  const base = (config.frontendUrl || "").replace(/\/+$/, "");
  if (!base || !projectId || !runId) return null;
  return `${base}/projects/${projectId}/tesbo-reports/runs/${runId}`;
}

function formatDuration(ms) {
  if (ms == null) return null;
  const total = Math.max(0, Math.round(Number(ms) / 1000));
  if (Number.isNaN(total)) return null;
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function formatTimestamp(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toUTCString().replace("GMT", "UTC");
}

function severityColor(severity) {
  switch (severity) {
    case "High":
      return { bg: "#fee2e2", fg: "#991b1b", border: "#fca5a5" };
    case "Medium":
      return { bg: "#fef3c7", fg: "#92400e", border: "#fcd34d" };
    default:
      return { bg: "#dbeafe", fg: "#1e40af", border: "#93c5fd" };
  }
}

function escapeHtml(value) {
  if (value == null) return "";
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Compute the supported metrics for a given finalized run.
 * Returns null if the run cannot be measured (no tests).
 */
async function computeRunMetrics(runId) {
  const runRes = await query(
    `SELECT r.id, r.project_id, r.run_name, r.total_tests, r.passed, r.failed, r.skipped,
            r.duration_ms, r.started_at, r.completed_at, p.name AS project_name
     FROM report_runs r
     LEFT JOIN execute_projects p ON p.id = r.project_id
     WHERE r.id = $1`,
    [runId]
  );
  const run = runRes.rows[0];
  if (!run) return null;

  const total = Number(run.total_tests) || 0;
  const passed = Number(run.passed) || 0;
  const failed = Number(run.failed) || 0;
  const skipped = Number(run.skipped) || 0;

  const passRatio = total > 0 ? Number(((passed * 100) / total).toFixed(2)) : null;
  const failureRate = total > 0 ? Number(((failed * 100) / total).toFixed(2)) : null;

  // Flaky tests within this run: distinct test names with both Passed and Failed attempts.
  const flakyRes = await query(
    `SELECT COUNT(*)::int AS flaky_count
     FROM (
       SELECT name
       FROM report_tests
       WHERE report_run_id = $1
       GROUP BY name
       HAVING COUNT(*) FILTER (WHERE status = 'Passed') > 0
          AND COUNT(*) FILTER (WHERE status = 'Failed') > 0
     ) sub`,
    [runId]
  );
  const flakyTests = Number(flakyRes.rows[0]?.flaky_count) || 0;

  // Top failed tests for the summary block (latest attempt per test name).
  const failedRes = await query(
    `SELECT DISTINCT ON (full_title, name) full_title, name, spec, error_message
     FROM report_tests
     WHERE report_run_id = $1 AND status = 'Failed'
     ORDER BY full_title, name, attempt DESC NULLS LAST, created_at DESC
     LIMIT 5`,
    [runId]
  );
  const topFailures = failedRes.rows.map((r) => ({
    title: r.full_title || r.name || "(unnamed test)",
    spec: r.spec || null,
    error: r.error_message ? String(r.error_message).split("\n")[0].slice(0, 200) : null,
  }));

  return {
    runId: run.id,
    projectId: run.project_id,
    projectName: run.project_name || null,
    runName: run.run_name,
    total,
    passed,
    failed,
    skipped,
    durationMs: run.duration_ms == null ? null : Number(run.duration_ms),
    startedAt: run.started_at,
    completedAt: run.completed_at,
    topFailures,
    metrics: {
      pass_ratio: passRatio,
      failure_rate: failureRate,
      flaky_tests: flakyTests,
    },
  };
}

async function loadEnabledAlerts(projectId) {
  const res = await query(
    `SELECT id, name, metric, operator, threshold, unit, channel, recipients, enabled
     FROM project_alerts
     WHERE execute_project_id = $1
       AND enabled = TRUE`,
    [projectId]
  );
  return res.rows.map((r) => ({
    id: r.id,
    name: r.name,
    metric: r.metric,
    operator: r.operator,
    threshold: Number(r.threshold),
    unit: r.unit,
    channel: r.channel,
    recipients: Array.isArray(r.recipients) ? r.recipients : [],
    enabled: r.enabled,
  }));
}

async function recordEvent({
  projectId,
  alert,
  observed,
  runId,
  runName,
  severity,
  summary,
}) {
  const res = await query(
    `INSERT INTO project_alert_events
       (execute_project_id, alert_id, rule_title, summary, severity,
        run_id, run_name, metric, observed_value, threshold)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING id`,
    [
      projectId,
      alert.id,
      alert.name,
      summary,
      severity,
      runId,
      runName,
      alert.metric,
      observed,
      alert.threshold,
    ]
  );
  return res.rows[0]?.id || null;
}

function buildTextBody({ alert, summary, severity, runMetrics, runUrl, observed }) {
  const stats = [];
  if (runMetrics.total != null) stats.push(`Total: ${runMetrics.total}`);
  if (runMetrics.passed != null) stats.push(`Passed: ${runMetrics.passed}`);
  if (runMetrics.failed != null) stats.push(`Failed: ${runMetrics.failed}`);
  if (runMetrics.skipped != null) stats.push(`Skipped: ${runMetrics.skipped}`);
  const passRate = runMetrics.metrics?.pass_ratio;
  if (passRate != null) stats.push(`Pass rate: ${passRate}%`);
  const duration = formatDuration(runMetrics.durationMs);
  if (duration) stats.push(`Duration: ${duration}`);

  const lines = [
    `Alert "${alert.name}" triggered (${severity} severity).`,
    "",
    `Rule: ${metricLabel(alert.metric)} ${alert.operator} ${formatValue(
      alert.metric,
      alert.threshold,
      alert.unit
    )}`,
    `Observed: ${formatValue(alert.metric, observed, alert.unit)}`,
    summary,
    "",
    runMetrics.projectName ? `Project: ${runMetrics.projectName}` : null,
    runMetrics.runName ? `Run: ${runMetrics.runName}` : null,
    stats.length ? stats.join(" · ") : null,
    runUrl ? "" : null,
    runUrl ? `View full report: ${runUrl}` : null,
  ].filter((line) => line !== null);

  if (runMetrics.topFailures && runMetrics.topFailures.length > 0) {
    lines.push("");
    lines.push("Top failing tests:");
    for (const failure of runMetrics.topFailures) {
      const head = failure.spec ? `${failure.title} (${failure.spec})` : failure.title;
      lines.push(`  - ${head}`);
      if (failure.error) lines.push(`      ${failure.error}`);
    }
  }

  lines.push("");
  lines.push("— TesboGrid Alerts");
  return lines.join("\n");
}

function buildHtmlBody({ alert, summary, severity, runMetrics, runUrl, observed }) {
  const colors = severityColor(severity);
  const passRate = runMetrics.metrics?.pass_ratio;
  const failureRate = runMetrics.metrics?.failure_rate;
  const duration = formatDuration(runMetrics.durationMs);
  const completedAt = formatTimestamp(runMetrics.completedAt);

  const statCard = (label, value, accent) => `
    <td align="center" valign="top" style="padding:12px 8px;border:1px solid #e5e7eb;border-radius:8px;background:#ffffff;">
      <div style="font-size:11px;letter-spacing:0.04em;text-transform:uppercase;color:#6b7280;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">${escapeHtml(label)}</div>
      <div style="font-size:20px;font-weight:600;color:${accent || "#111827"};margin-top:4px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">${escapeHtml(value)}</div>
    </td>
  `;

  const failuresRows =
    runMetrics.topFailures && runMetrics.topFailures.length > 0
      ? runMetrics.topFailures
          .map(
            (f) => `
        <tr>
          <td style="padding:10px 12px;border-bottom:1px solid #f1f5f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
            <div style="font-size:14px;color:#111827;font-weight:500;">${escapeHtml(f.title)}</div>
            ${f.spec ? `<div style="font-size:12px;color:#6b7280;margin-top:2px;">${escapeHtml(f.spec)}</div>` : ""}
            ${f.error ? `<div style="font-size:12px;color:#b91c1c;margin-top:4px;font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;">${escapeHtml(f.error)}</div>` : ""}
          </td>
        </tr>`
          )
          .join("")
      : "";

  const detailRow = (label, value) =>
    value
      ? `<tr>
          <td style="padding:6px 0;font-size:13px;color:#6b7280;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;width:140px;">${escapeHtml(label)}</td>
          <td style="padding:6px 0;font-size:13px;color:#111827;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">${escapeHtml(value)}</td>
        </tr>`
      : "";

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${escapeHtml(`TesboGrid alert: ${alert.name}`)}</title>
</head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#111827;">
  <div style="display:none;max-height:0;overflow:hidden;">${escapeHtml(summary)}</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f3f4f6;padding:24px 12px;">
    <tr>
      <td align="center">
        <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #e5e7eb;">
          <tr>
            <td style="padding:20px 24px;background:#0f172a;color:#ffffff;">
              <div style="font-size:12px;letter-spacing:0.08em;text-transform:uppercase;color:#94a3b8;">TesboGrid Alert</div>
              <div style="font-size:20px;font-weight:600;margin-top:4px;">${escapeHtml(alert.name)}</div>
              <div style="margin-top:10px;">
                <span style="display:inline-block;padding:4px 10px;border-radius:9999px;font-size:12px;font-weight:600;background:${colors.bg};color:${colors.fg};border:1px solid ${colors.border};">${escapeHtml(severity)} severity</span>
              </div>
            </td>
          </tr>
          <tr>
            <td style="padding:24px;">
              <p style="margin:0 0 12px 0;font-size:14px;line-height:1.55;color:#374151;">${escapeHtml(summary)}</p>
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 0 0;">
                ${detailRow("Project", runMetrics.projectName)}
                ${detailRow("Run", runMetrics.runName)}
                ${detailRow("Metric", metricLabel(alert.metric))}
                ${detailRow(
                  "Rule",
                  `${alert.operator} ${formatValue(alert.metric, alert.threshold, alert.unit)}`
                )}
                ${detailRow("Observed", formatValue(alert.metric, observed, alert.unit))}
                ${detailRow("Completed", completedAt)}
              </table>
            </td>
          </tr>
          <tr>
            <td style="padding:0 24px 8px 24px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="6" border="0">
                <tr>
                  ${statCard("Total", String(runMetrics.total ?? 0))}
                  ${statCard("Passed", String(runMetrics.passed ?? 0), "#047857")}
                  ${statCard("Failed", String(runMetrics.failed ?? 0), "#b91c1c")}
                  ${statCard("Skipped", String(runMetrics.skipped ?? 0), "#6b7280")}
                </tr>
                <tr>
                  ${statCard("Pass rate", passRate != null ? `${passRate}%` : "—", "#047857")}
                  ${statCard("Failure rate", failureRate != null ? `${failureRate}%` : "—", "#b91c1c")}
                  ${statCard("Flaky", String(runMetrics.metrics?.flaky_tests ?? 0), "#92400e")}
                  ${statCard("Duration", duration || "—")}
                </tr>
              </table>
            </td>
          </tr>
          ${
            runUrl
              ? `<tr>
            <td align="center" style="padding:20px 24px 8px 24px;">
              <a href="${escapeHtml(runUrl)}" style="display:inline-block;background:#2563eb;color:#ffffff;text-decoration:none;padding:12px 22px;border-radius:8px;font-weight:600;font-size:14px;">View full report →</a>
              <div style="font-size:11px;color:#6b7280;margin-top:8px;word-break:break-all;">${escapeHtml(runUrl)}</div>
            </td>
          </tr>`
              : ""
          }
          ${
            failuresRows
              ? `<tr>
            <td style="padding:8px 24px 4px 24px;">
              <div style="font-size:12px;letter-spacing:0.04em;text-transform:uppercase;color:#6b7280;margin:8px 0;">Top failing tests</div>
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;">
                ${failuresRows}
              </table>
            </td>
          </tr>`
              : ""
          }
          <tr>
            <td style="padding:16px 24px 24px 24px;border-top:1px solid #f1f5f9;">
              <div style="font-size:12px;color:#6b7280;line-height:1.55;">You're receiving this because you're listed as a recipient on the alert rule <strong>${escapeHtml(alert.name)}</strong>. Manage alerts from the project's Alerts page in TesboGrid.</div>
            </td>
          </tr>
        </table>
        <div style="font-size:11px;color:#9ca3af;margin-top:12px;">TesboGrid · Automated alert notification</div>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

async function notifyByEmail({ alert, summary, severity, observed, runMetrics, runUrl }) {
  if (alert.channel !== "email") return;
  const recipients = (alert.recipients || []).filter(
    (email) => typeof email === "string" && email.includes("@")
  );
  if (recipients.length === 0) return;

  const subjectPrefix = runMetrics.projectName ? `[TesboGrid · ${runMetrics.projectName}]` : "[TesboGrid]";
  const subject = `${subjectPrefix} ${severity} alert: ${alert.name}`;

  const textBody = buildTextBody({ alert, summary, severity, runMetrics, runUrl, observed });
  const htmlBody = buildHtmlBody({ alert, summary, severity, runMetrics, runUrl, observed });

  await sendEmail({
    to: recipients,
    subject,
    textBody,
    htmlBody,
  });
}

/**
 * Evaluate every enabled alert for a project against the metrics of the just-finalized run.
 * Persists triggered events and best-effort sends notifications.
 */
export async function evaluateAlertsForRun({ projectId, runId }) {
  if (!projectId || !runId) return;

  let alerts;
  try {
    alerts = await loadEnabledAlerts(projectId);
  } catch (err) {
    // If the table does not exist yet (migration not run), skip silently.
    if (err && err.code === "42P01") return;
    logger.error("Alerts: failed to load alert rules", err);
    return;
  }
  if (alerts.length === 0) return;

  let runMetrics;
  try {
    runMetrics = await computeRunMetrics(runId);
  } catch (err) {
    logger.error("Alerts: failed to compute run metrics", err);
    return;
  }
  if (!runMetrics) return;

  for (const alert of alerts) {
    try {
      const observed = runMetrics.metrics[alert.metric];
      if (observed == null) continue;

      if (!comparePasses(alert.operator, observed, alert.threshold)) continue;

      const severity = severityFor(alert.metric, observed, alert.threshold);
      const summary = `${metricLabel(alert.metric)} was ${formatValue(
        alert.metric,
        observed,
        alert.unit
      )} (threshold ${alert.operator} ${formatValue(alert.metric, alert.threshold, alert.unit)}).`;

      await recordEvent({
        projectId,
        alert,
        observed,
        runId,
        runName: runMetrics.runName,
        severity,
        summary,
      });

      await notifyByEmail({
        alert,
        summary,
        severity,
        observed,
        runMetrics,
        runUrl: buildRunUrl(projectId, runId),
      });
    } catch (err) {
      logger.error(`Alerts: failed to evaluate alert ${alert.id}`, err);
    }
  }
}
