function toIdentityKey(spec, name) {
  return `${String(spec || "").trim()}::${String(name || "").trim()}`;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function computeTransitions(statuses) {
  let transitions = 0;
  for (let i = 1; i < statuses.length; i += 1) {
    if (statuses[i] !== statuses[i - 1]) transitions += 1;
  }
  return transitions;
}

function computeTrendSlope(statuses) {
  if (statuses.length < 2) return 0;
  const points = statuses.map((s, i) => [i, s === "Failed" ? 1 : 0]);
  const n = points.length;
  const sumX = points.reduce((acc, p) => acc + p[0], 0);
  const sumY = points.reduce((acc, p) => acc + p[1], 0);
  const sumXY = points.reduce((acc, p) => acc + p[0] * p[1], 0);
  const sumXX = points.reduce((acc, p) => acc + p[0] * p[0], 0);
  const denom = n * sumXX - sumX * sumX;
  if (denom === 0) return 0;
  return (n * sumXY - sumX * sumY) / denom;
}

function likelyReason({ transitionRatio, intermittentRatio, signatureVariety }) {
  if (transitionRatio > 0.45 && intermittentRatio > 0.35) {
    return "Frequent pass/fail switching suggests unstable synchronization or timing.";
  }
  if (signatureVariety > 0.5) {
    return "Failure signatures vary significantly across runs, indicating non-deterministic behavior.";
  }
  if (intermittentRatio > 0.45) {
    return "Intermittent failures without sustained breaks indicate flaky behavior.";
  }
  return "Low flakiness signal in recent history.";
}

export function computeFlakyScoreFromHistory(rows) {
  if (!rows || rows.length === 0) {
    return { score: 0, trendSlope: 0, reason: "No recent history available." };
  }

  const statuses = rows.map((r) => r.status);
  const failures = statuses.filter((s) => s === "Failed").length;
  const passes = statuses.filter((s) => s === "Passed").length;
  const transitions = computeTransitions(statuses);

  const transitionRatio = transitions / Math.max(1, statuses.length - 1);
  const intermittentRatio = Math.min(failures, passes) / Math.max(1, statuses.length);
  const signatureSet = new Set(
    rows
      .map((r) => String(r.error_message || "").toLowerCase().slice(0, 140))
      .filter(Boolean)
  );
  const signatureVariety = signatureSet.size / Math.max(1, failures);

  const rawScore =
    transitionRatio * 40 +
    intermittentRatio * 30 +
    clamp(signatureVariety, 0, 1) * 20 +
    (rows.some((r) => Number(r.attempt || 0) > 0) ? 10 : 0);

  return {
    score: clamp(Math.round(rawScore), 0, 100),
    trendSlope: Number(computeTrendSlope(statuses).toFixed(4)),
    reason: likelyReason({ transitionRatio, intermittentRatio, signatureVariety }),
  };
}

export async function computeAndPersistFlakyScoresForRun({
  projectId,
  runId,
  query,
  windowSize = 20,
}) {
  const testsRes = await query(
    `SELECT DISTINCT COALESCE(spec, '') AS spec, COALESCE(name, '') AS name
     FROM report_tests
     WHERE report_run_id = $1`,
    [runId]
  );

  let updated = 0;
  for (const t of testsRes.rows) {
    const historyRes = await query(
      `SELECT rt.status, rt.error_message, rt.attempt
       FROM report_tests rt
       JOIN report_runs rr ON rr.id = rt.report_run_id
       WHERE rr.project_id = $1
         AND COALESCE(rt.spec, '') = $2
         AND COALESCE(rt.name, '') = $3
       ORDER BY COALESCE(rr.started_at, rr.created_at) DESC
       LIMIT $4`,
      [projectId, t.spec, t.name, windowSize]
    );

    const computed = computeFlakyScoreFromHistory(historyRes.rows);
    await query(
      `INSERT INTO report_test_flakiness_snapshots
         (project_id, test_identity_key, spec, test_name, score, trend_slope, likely_reason, window_size, computed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())`,
      [
        projectId,
        toIdentityKey(t.spec, t.name),
        t.spec || null,
        t.name || null,
        computed.score,
        computed.trendSlope,
        computed.reason,
        windowSize,
      ]
    );
    updated += 1;
  }

  return { updated };
}
