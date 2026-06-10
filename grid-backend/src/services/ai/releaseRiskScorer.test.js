import test from "node:test";
import assert from "node:assert/strict";
import {
  RISK_WEIGHTS,
  computeRiskScore,
  mapRiskLevel,
} from "./releaseRiskScorer.js";

test("mapRiskLevel maps score bands", () => {
  assert.equal(mapRiskLevel(20), "LOW");
  assert.equal(mapRiskLevel(50), "MEDIUM");
  assert.equal(mapRiskLevel(75), "HIGH");
  assert.equal(mapRiskLevel(90), "CRITICAL");
});

test("computeRiskScore returns zero risk for an empty / fully-passing run", () => {
  const allPass = computeRiskScore({ total: 100, failed: 0, skipped: 0 });
  assert.equal(allPass.score, 0);
  assert.equal(allPass.level, "LOW");
  assert.equal(allPass.breakdown.failedRate, 0);
  assert.equal(allPass.breakdown.skippedRate, 0);

  const empty = computeRiskScore({});
  assert.equal(empty.score, 0);
  assert.equal(empty.level, "LOW");
});

test("skipped tests now contribute to risk", () => {
  // No failures at all, but the entire suite was skipped — clearly something
  // is off, so risk must be > 0 (used to be 0 under the old formula).
  const allSkipped = computeRiskScore({ total: 100, failed: 0, skipped: 100 });
  assert.ok(
    allSkipped.score >= RISK_WEIGHTS.skippedRate - 1,
    `expected score ~${RISK_WEIGHTS.skippedRate}, got ${allSkipped.score}`
  );
  assert.equal(allSkipped.breakdown.skippedRate, 100);
  assert.ok(allSkipped.breakdown.components.skipped > 0);
});

test("failures still weigh more than skips for the same non-pass count", () => {
  const failuresOnly = computeRiskScore({ total: 100, failed: 40, skipped: 0 });
  const skipsOnly = computeRiskScore({ total: 100, failed: 0, skipped: 40 });
  assert.ok(
    failuresOnly.score > skipsOnly.score,
    `failures (${failuresOnly.score}) should outweigh skips (${skipsOnly.score})`
  );
});

test("matches the user's three real runs in the expected ordering", () => {
  // May 6: 622 pass, 382 fail, 5 skip  (62% pass)
  // May 5: 544 pass, 459 fail, 6 skip  (54% pass)
  // May 4: 514 pass, 284 fail, 211 skip (51% pass)
  const total = 1009;
  const may6 = computeRiskScore({ total, failed: 382, skipped: 5 });
  const may5 = computeRiskScore({ total, failed: 459, skipped: 6 });
  const may4 = computeRiskScore({ total, failed: 284, skipped: 211 });

  // May 5 has the most failures and few skips — must be the riskiest of the three.
  assert.ok(may5.score >= may6.score, `${may5.score} >= ${may6.score}`);
  assert.ok(may5.score >= may4.score, `${may5.score} >= ${may4.score}`);

  // May 4 used to score lower than May 6 purely because its skips were
  // ignored. With skips counted, the gap should close to within a couple of
  // points (their non-pass rates are nearly identical).
  assert.ok(
    Math.abs(may6.score - may4.score) <= 3,
    `May 6 (${may6.score}) and May 4 (${may4.score}) should be close`
  );
});

test("breakdown exposes per-component contributions", () => {
  const r = computeRiskScore({
    total: 200,
    failed: 50,
    skipped: 20,
    regressions: 10,
    environmentFailures: 5,
    highImpactClusters: 2,
    avgFlaky: 30,
  });

  const c = r.breakdown.components;
  assert.ok(c.failed > 0);
  assert.ok(c.skipped > 0);
  assert.ok(c.regression > 0);
  assert.ok(c.clusters > 0);
  assert.ok(c.flaky > 0);
  assert.ok(c.environment > 0);

  // Sum of components (before rounding) should be close to the score.
  const sum =
    c.failed + c.skipped + c.regression + c.clusters + c.flaky + c.environment;
  assert.ok(
    Math.abs(sum - r.score) <= 1,
    `components sum ${sum} should match score ${r.score}`
  );
});
