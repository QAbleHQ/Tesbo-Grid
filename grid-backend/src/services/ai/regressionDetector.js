function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

export function computeRegressionConfidence(passStreak, historyLength) {
  const base = 55;
  const streakBoost = Math.min(35, passStreak * 4);
  const historyBoost = Math.min(10, historyLength);
  return clamp(base + streakBoost + historyBoost, 0, 100);
}

export async function detectRegressionsForRun({
  projectId,
  runId,
  query,
  passStreakThreshold = 5,
}) {
  const failedRes = await query(
    `SELECT id, COALESCE(spec, '') AS spec, COALESCE(name, '') AS name
     FROM report_tests
     WHERE report_run_id = $1
       AND status = 'Failed'`,
    [runId]
  );

  if (failedRes.rows.length === 0) return { flagged: 0 };

  let flagged = 0;
  for (const test of failedRes.rows) {
    const historyRes = await query(
      `SELECT rt.status, rr.id AS run_id, COALESCE(rr.started_at, rr.created_at) AS observed_at
       FROM report_tests rt
       JOIN report_runs rr ON rr.id = rt.report_run_id
       WHERE rr.project_id = $1
         AND COALESCE(rt.spec, '') = $2
         AND COALESCE(rt.name, '') = $3
         AND rt.report_run_id <> $4
       ORDER BY COALESCE(rr.started_at, rr.created_at) DESC
       LIMIT 30`,
      [projectId, test.spec, test.name, runId]
    );

    let passStreak = 0;
    for (const row of historyRes.rows) {
      if (row.status === "Passed") passStreak += 1;
      else break;
    }

    const isRegression = passStreak >= passStreakThreshold;
    if (!isRegression) {
      await query(
        `UPDATE report_tests
         SET is_probable_regression = FALSE,
             regression_confidence = NULL,
             regression_pass_streak_before_fail = NULL,
             regression_first_seen_run_id = NULL,
             regression_hint = NULL
         WHERE id = $1`,
        [test.id]
      );
      continue;
    }

    const confidence = computeRegressionConfidence(passStreak, historyRes.rows.length);
    const firstSeenRes = await query(
      `SELECT rr.id AS run_id
       FROM report_tests rt
       JOIN report_runs rr ON rr.id = rt.report_run_id
       WHERE rr.project_id = $1
         AND COALESCE(rt.spec, '') = $2
         AND COALESCE(rt.name, '') = $3
         AND rt.status = 'Failed'
       ORDER BY COALESCE(rr.started_at, rr.created_at) DESC
       LIMIT 1`,
      [projectId, test.spec, test.name]
    );

    const firstSeenRunId = firstSeenRes.rows[0]?.run_id || runId;
    const hint = `Failed after ${passStreak} consecutive passes in recent history.`;

    await query(
      `UPDATE report_tests
       SET is_probable_regression = TRUE,
           regression_confidence = $2,
           regression_pass_streak_before_fail = $3,
           regression_first_seen_run_id = $4,
           regression_hint = $5
       WHERE id = $1`,
      [test.id, confidence, passStreak, firstSeenRunId, hint]
    );
    flagged += 1;
  }

  return { flagged };
}
