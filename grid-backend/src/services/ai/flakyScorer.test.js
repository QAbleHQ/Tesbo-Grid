import test from "node:test";
import assert from "node:assert/strict";
import { computeFlakyScoreFromHistory } from "./flakyScorer.js";

test("computeFlakyScoreFromHistory returns 0 for no history", () => {
  const result = computeFlakyScoreFromHistory([]);
  assert.equal(result.score, 0);
  assert.equal(result.trendSlope, 0);
});

test("computeFlakyScoreFromHistory raises score on pass/fail switching", () => {
  const result = computeFlakyScoreFromHistory([
    { status: "Passed", error_message: null, attempt: 0 },
    { status: "Failed", error_message: "timeout", attempt: 1 },
    { status: "Passed", error_message: null, attempt: 0 },
    { status: "Failed", error_message: "element missing", attempt: 1 },
    { status: "Passed", error_message: null, attempt: 0 },
  ]);
  assert.ok(result.score >= 50);
  assert.ok(result.reason.length > 0);
});
