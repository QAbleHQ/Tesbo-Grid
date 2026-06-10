import { query } from "../db/database.js";

export async function upsertReport(runId, jobId, data) {
  const {
    status = "pending",
    startedAt = null,
    endedAt = null,
    logs = [],
    videoPath = null,
    screenshotPath = null,
    tracePath = null,
    errorMessage = null,
  } = data;

  await query(
    `INSERT INTO execution_reports
       (run_id, job_id, status, started_at, ended_at, logs, video_path, screenshot_path, trace_path, error_message)
     VALUES ($1, $2, $3, $4::timestamptz, $5::timestamptz, $6::jsonb, $7, $8, $9, $10)
     ON CONFLICT (job_id) DO UPDATE SET
       status = EXCLUDED.status,
       started_at = EXCLUDED.started_at,
       ended_at = EXCLUDED.ended_at,
       logs = EXCLUDED.logs,
       video_path = EXCLUDED.video_path,
       screenshot_path = EXCLUDED.screenshot_path,
       trace_path = EXCLUDED.trace_path,
       error_message = EXCLUDED.error_message,
       updated_at = now()`,
    [
      runId,
      jobId,
      status,
      startedAt || null,
      endedAt || null,
      JSON.stringify(logs || []),
      videoPath,
      screenshotPath,
      tracePath,
      errorMessage,
    ]
  );
}

export async function getReport(jobId) {
  const { rows } = await query(
    `SELECT id, run_id, job_id, status, started_at, ended_at,
            logs, video_path, screenshot_path, trace_path, error_message
     FROM execution_reports WHERE job_id = $1`,
    [jobId]
  );
  if (!rows.length) return null;
  const r = rows[0];
  return {
    reportId: r.id,
    runId: r.run_id,
    jobId: r.job_id,
    status: r.status,
    startedAt: r.started_at ? r.started_at.toISOString() : null,
    endedAt: r.ended_at ? r.ended_at.toISOString() : null,
    logs: r.logs || [],
    videoPath: r.video_path,
    screenshotPath: r.screenshot_path,
    tracePath: r.trace_path,
    errorMessage: r.error_message,
  };
}
