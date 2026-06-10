# Release Risk Scoring

Every test run in Tesbo Reports is automatically assigned a **Release Risk
Score** (0–100) and a **Risk Level** (`LOW` / `MEDIUM` / `HIGH` / `CRITICAL`).
The score answers a single question:

> *Based on what we know about this run, how risky is it to ship the changes
> behind it?*

The score is **not** the inverse of pass rate. Pass rate only looks at
`passed / total`. Risk also takes into account **what happened to the rest of
the suite** (skipped tests, regressions, environment failures, recurring
failure clusters, recent flakiness).

This document explains exactly how the score is computed, why each signal is
included, and how to read the breakdown returned by the API.

## Where it lives

| File | Purpose |
|---|---|
| `grid-backend/src/services/ai/releaseRiskScorer.js` | Pure scoring logic + DB-backed wrapper. |
| `grid-backend/src/services/ai/releaseRiskScorer.test.js` | Unit tests for the scoring math. |
| `grid-backend/src/db/migrations/010_ai_qa_intelligence.sql` | Adds `release_risk_*` columns on `report_runs`. |
| `grid-backend/src/routes/reports.js` | Persists score on run completion (`computeAndPersistReleaseRiskForRun`) and exposes it via the API. |

## API

### Per-run score

```
GET /api/projects/:projectId/tesbo-reports/runs/:runId/risk
```

Response:

```json
{
  "score": 47,
  "level": "MEDIUM",
  "breakdown": {
    "failedRate": 37.86,
    "skippedRate": 0.50,
    "regressionRate": 4.16,
    "environmentFailureShare": 8.12,
    "highImpactClusters": 2,
    "avgFlakyScore": 18.40,
    "components": {
      "failed": 13.25,
      "skipped": 0.10,
      "regression": 1.46,
      "clusters": 10.00,
      "flaky": 3.68,
      "environment": 0.81
    }
  },
  "updatedAt": "2026-05-06T15:42:11.000Z"
}
```

The `components` block shows exactly **how many points each signal contributed**
to the final score, which makes it easy to render a stacked-bar explanation in
the UI.

### Aggregate stats

`GET /api/projects/:projectId/tesbo-reports/runs` and the analytics endpoints
return `releaseRiskScore`, `releaseRiskLevel`, `releaseRiskBreakdown`, and
`releaseRiskUpdatedAt` per run, plus an `avgRiskScore` / `maxRiskScore` rollup
in the quality overview.

## The formula

```
score = clamp(round(
    failedRate     * 85       // 100% failures = CRITICAL risk
  + skippedRate    * 30       // skips count as ~35% as risky as failures
  + regressionRate * 15       // additional signal on top of base failures
  + min(15, highImpactClusters * 3)
  + avgFlakyScore  * 0.15     // project-wide flakiness over the last 3 days
  + envRate        * 5        // share of failures that look like env issues
), 0, 100)
```

All weights live in the exported `RISK_WEIGHTS` constant in
`releaseRiskScorer.js` and can be tuned without changing the rest of the math.

### Risk level mapping

| Score | Level |
|---|---|
| `0 – 44`  | `LOW` |
| `45 – 69` | `MEDIUM` |
| `70 – 84` | `HIGH` |
| `85 – 100` | `CRITICAL` |

## The signals

### 1. `failedRate` — failures / total tests

The strongest signal. A run with 100% failures reaches `1.0 × 85 = 85` points,
which is CRITICAL risk. A run with 40% failures gets `0.40 × 85 = 34` points.
Bounded to `[0, 85]`.

### 2. `skippedRate` — skipped / total tests

A skipped test means the suite didn't actually verify that scenario. Skips
can be intentional (`@skip` annotations), driven by missing dependencies, or
caused by a setup failure that bailed out of an entire spec. **Any of those
states reduces our confidence in the release**, so they contribute to risk.

We weight skips at **30** (vs. 85 for failures) — about 35% as risky as a
failure. That ratio captures the intuition that "skip" is somewhere between
"pass" and "fail" but closer to "fail" than to "pass" because it represents
unverified behavior.

### 3. `regressionRate` — probable regressions / total tests

Tests that the AI analyzer marked as `is_probable_regression = true`
(typically: previously-green tests that started failing in this run on code
that was meant to be unrelated). Weighted at 15 points as an additional signal
on top of the base failure rate, since regressions indicate probable bugs rather
than environmental or flaky test issues.

### 4. `highImpactClusters` — failure cluster impact

A cluster is a group of failing tests that share the same root cause
(stack trace fingerprint, error category, etc.) — see
`report_test_cluster_links`. A cluster is "high-impact" when **3 or more
tests in the run** are linked to it.

Each high-impact cluster adds **3 points**, capped at **15**. This catches the
case where one bad change breaks dozens of tests in the same way: that's a
single root cause, but it's a high-confidence signal that something is broken.

### 5. `avgFlakyScore` — project-wide flakiness (last 3 days)

The average flakiness score (from `report_test_flakiness_snapshots`) across
the whole project for the last three days. Flaky suites produce noisy results,
so the same failure rate is more concerning when we already know the suite is
flaky. Weighted at `0.15` per point of flakiness, so a project averaging 50
flakiness adds `7.5` points.

### 6. `envRate` — environment-failure share

The fraction of *failed* tests that the AI analyzer categorized as
`ENVIRONMENT_ISSUE`. Capped at 5 points. A high `envRate` means many of the
failures are likely infra problems rather than product bugs — risk is still
elevated (the run didn't actually validate the changes), but the ceiling is
intentionally lower because env failures often resolve themselves on retry.

## Worked example

Three runs of the same suite (1009 tests):

| Date | Pass | Fail | Skip | Pass % | Failed % | Skip % | Score | Why |
|---|---|---|---|---|---|---|---|---|
| May 6 | 622 | 382 | 5   | 62% | 37.9% | 0.5%  | ~47 (MEDIUM) | Lots of failures, almost no skips. |
| May 5 | 544 | 459 | 6   | 54% | 45.5% | 0.6%  | ~49 (MEDIUM) | Worst of the three on raw failures. |
| May 4 | 514 | 284 | 211 | 51% | 28.1% | 20.9% | ~47 (MEDIUM) | Fewer failures, but 211 skips drag risk back up. |

Note that the **lowest pass-rate run (May 4) is not the riskiest run** —
because most of the "missing" tests are skipped, not failed. The model
penalizes the skips, but not as harshly as if they had actually failed.

## Recomputation lifecycle

- **When**: `computeAndPersistReleaseRiskForRun` runs at the end of every run
  (see `grid-backend/src/routes/reports.js` around line 1926).
- **What it writes**: `release_risk_score`, `release_risk_level`,
  `release_risk_breakdown`, `release_risk_updated_at` on `report_runs`.
- **Backfill**: Old runs keep their previous score until they're recomputed.
  If you change a weight in `RISK_WEIGHTS` and want historical runs to reflect
  the new model, you'll need to re-run the scorer for each run id (a small
  admin script that loops over `report_runs.id` and calls
  `computeAndPersistReleaseRiskForRun` is the simplest approach).

## Tuning the model

Open `grid-backend/src/services/ai/releaseRiskScorer.js` and change the
`RISK_WEIGHTS` object. The unit tests in `releaseRiskScorer.test.js` lock in
the *ordering* of risk between representative scenarios (failures vs. skips,
the user's three real runs, etc.), so a tuning change that accidentally
inverts a relationship will fail CI.

Common tweaks:

- **Skips not biting hard enough?** Bump `skippedRate` from `20` toward
  `30–35`.
- **Skips are mostly intentional in your project?** Drop `skippedRate` to
  `10–15`.
- **Want a stricter shipping gate?** Lower the level thresholds in
  `mapRiskLevel`.

## FAQ

**Q: Why is my 62% pass-rate run riskier than my 51% pass-rate run?**
Because the 51% run has many *skipped* tests, not failed ones. Failures
contribute up to 35 points; skips contribute up to 20. Check
`breakdown.components.failed` vs. `components.skipped` to see exactly where
the points came from.

**Q: A run with 0 failures has a non-zero risk score. Why?**
Most likely one of: (1) the suite has a high recent flakiness average
(`components.flaky > 0`), (2) tests were skipped (`components.skipped > 0`),
or (3) the AI flagged probable regressions even on tests that "passed" in
some retry sense. The `components` object will tell you which.

**Q: Can risk ever exceed 100?**
No — the score is clamped to `[0, 100]`. The raw weighted sum can exceed 100
in pathological cases (everything failing + many regressions + many clusters
+ very flaky), and we treat that as "100, can't get worse".
