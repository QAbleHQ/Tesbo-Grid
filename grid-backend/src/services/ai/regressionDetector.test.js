import test from "node:test";
import assert from "node:assert/strict";
import { computeRegressionConfidence } from "./regressionDetector.js";

test("computeRegressionConfidence increases with pass streak", () => {
  const low = computeRegressionConfidence(1, 3);
  const high = computeRegressionConfidence(8, 10);
  assert.ok(high > low);
  assert.ok(high <= 100);
});
