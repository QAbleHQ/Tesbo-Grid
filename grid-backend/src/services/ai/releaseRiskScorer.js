function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

// Weights for each risk signal. Keep these here so the formula is tunable
// without hunting through the score expression below.
//
// Guiding principle: a "passed" test is the only neutral outcome. Anything
// else (failed OR skipped) erodes confidence in the release. Failures are
// the strongest signal; skips are weaker because they can be intentional or
// driven by dependencies/env, but a high skip rate still means we don't
// actually know if the suite is healthy.
//
// Updated weights: failedRate now weighted at 85 so that 100% failures alone
// reach CRITICAL risk level (85+). Other weights adjusted proportionally.
export const RISK_WEIGHTS = {
  failedRate: 85,       // 100% failures = CRITICAL (was 35)
  skippedRate: 30,      // Increased proportionally (was 20)
  regressionRate: 15,   // Additional signal on top of failures (was 35)
  perHighImpactCluster: 3,  // Reduced to prevent over-scoring (was 5)
  highImpactClustersCap: 15, // Reduced cap (was 20)
  avgFlaky: 0.15,       // Slightly reduced (was 0.2)
  envRate: 5,           // Reduced since env issues are transient (was 10)
};

export function mapRiskLevel(score) {
  if (score >= 85) return "CRITICAL";
  if (score >= 70) return "HIGH";
  if (score >= 45) return "MEDIUM";
  return "LOW";
}

/**
 * Pure risk computation. Given run-level totals plus the auxiliary signals,
 * returns the final score (0-100), the level, and a breakdown that explains
 * how every point was earned. Kept side-effect free so it can be unit tested.
 */
export function computeRiskScore({
  total = 0,
  failed = 0,
  skipped = 0,
  regressions = 0,
  environmentFailures = 0,
  highImpactClusters = 0,
  avgFlaky = 0,
} = {}) {
  const safeTotal = Number(total) || 0;
  const safeFailed = Number(failed) || 0;
  const safeSkipped = Number(skipped) || 0;
  const safeRegressions = Number(regressions) || 0;
  const safeEnv = Number(environmentFailures) || 0;
  const safeClusters = Number(highImpactClusters) || 0;
  const safeFlaky = Number(avgFlaky) || 0;

  const failedRate = safeTotal > 0 ? safeFailed / safeTotal : 0;
  const skippedRate = safeTotal > 0 ? safeSkipped / safeTotal : 0;
  const regressionRate = safeTotal > 0 ? safeRegressions / safeTotal : 0;
  const envRate = safeFailed > 0 ? safeEnv / safeFailed : 0;

  const w = RISK_WEIGHTS;
  const failedComponent = failedRate * w.failedRate;
  const skippedComponent = skippedRate * w.skippedRate;
  const regressionComponent = regressionRate * w.regressionRate;
  const clusterComponent = Math.min(
    w.highImpactClustersCap,
    safeClusters * w.perHighImpactCluster
  );
  const flakyComponent = safeFlaky * w.avgFlaky;
  const envComponent = envRate * w.envRate;

  const score = clamp(
    Math.round(
      failedComponent +
      skippedComponent +
      regressionComponent +
      clusterComponent +
      flakyComponent +
      envComponent
    ),
    0,
    100
  );

  const breakdown = {
    failedRate: Number((failedRate * 100).toFixed(2)),
    skippedRate: Number((skippedRate * 100).toFixed(2)),
    regressionRate: Number((regressionRate * 100).toFixed(2)),
    environmentFailureShare: Number((envRate * 100).toFixed(2)),
    highImpactClusters: safeClusters,
    avgFlakyScore: Number(safeFlaky.toFixed(2)),
    components: {
      failed: Number(failedComponent.toFixed(2)),
      skipped: Number(skippedComponent.toFixed(2)),
      regression: Number(regressionComponent.toFixed(2)),
      clusters: Number(clusterComponent.toFixed(2)),
      flaky: Number(flakyComponent.toFixed(2)),
      environment: Number(envComponent.toFixed(2)),
    },
  };

  return { score, level: mapRiskLevel(score), breakdown };
}

export async function computeAndPersistReleaseRiskForRun({ projectId, runId, query }) {
  const baseRes = await query(
    `SELECT
       rr.total_tests,
       rr.failed,
       rr.passed,
       rr.skipped,
       COALESCE(SUM(CASE WHEN rt.is_probable_regression THEN 1 ELSE 0 END), 0)::integer AS regression_count,
       COALESCE(SUM(CASE WHEN rt.ai_analysis_category = 'ENVIRONMENT_ISSUE' THEN 1 ELSE 0 END), 0)::integer AS environment_count
     FROM report_runs rr
     LEFT JOIN report_tests rt ON rt.report_run_id = rr.id
     WHERE rr.id = $1
       AND rr.project_id = $2
     GROUP BY rr.id`,
    [runId, projectId]
  );

  if (baseRes.rows.length === 0) return null;
  const row = baseRes.rows[0];

  const flakyRes = await query(
    `SELECT AVG(score)::numeric AS avg_flaky
     FROM report_test_flakiness_snapshots
     WHERE project_id = $1
       AND computed_at > now() - interval '3 days'`,
    [projectId]
  );
  const avgFlaky = Number(flakyRes.rows[0]?.avg_flaky || 0);

  const clusterRes = await query(
    `SELECT COUNT(*)::integer AS high_impact_clusters
     FROM (
       SELECT cluster_id
       FROM report_test_cluster_links l
       JOIN report_tests t ON t.id = l.report_test_id
       WHERE t.report_run_id = $1
       GROUP BY cluster_id
       HAVING COUNT(*) >= 3
     ) c`,
    [runId]
  );
  const highImpactClusters = Number(clusterRes.rows[0]?.high_impact_clusters || 0);

  const { score, level, breakdown } = computeRiskScore({
    total: row.total_tests,
    failed: row.failed,
    skipped: row.skipped,
    regressions: row.regression_count,
    environmentFailures: row.environment_count,
    highImpactClusters,
    avgFlaky,
  });

  await query(
    `UPDATE report_runs
     SET release_risk_score = $2,
         release_risk_level = $3,
         release_risk_breakdown = $4::jsonb,
         release_risk_updated_at = now(),
         updated_at = now()
     WHERE id = $1`,
    [runId, score, level, JSON.stringify(breakdown)]
  );

  return { score, level, breakdown };
}
