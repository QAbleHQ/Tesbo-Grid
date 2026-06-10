import test from "node:test";
import assert from "node:assert/strict";
import { normalizeRuntime, validateRuntimeJobs, hasQueueableWork } from "./runtimeContract.js";

test("normalizeRuntime falls back to javascript script mode", () => {
  const runtime = normalizeRuntime({});
  assert.equal(runtime.framework, "playwright");
  assert.equal(runtime.language, "javascript");
  assert.equal(runtime.executionMode, "script");
});

test("validateRuntimeJobs accepts javascript script jobs", () => {
  const invalid = validateRuntimeJobs([
    {
      script: "test('a', async ({ page }) => { await page.goto('https://example.com'); });",
    },
  ]);
  assert.deepEqual(invalid, []);
});

test("validateRuntimeJobs rejects python script mode", () => {
  const invalid = validateRuntimeJobs([
    {
      runtime: { language: "python", executionMode: "script" },
      script: "print('x')",
    },
  ]);
  assert.equal(invalid.length, 1);
  assert.match(invalid[0].reason, /project mode only/i);
});

test("validateRuntimeJobs requires bundle and entrypoint for python/java project mode", () => {
  const invalid = validateRuntimeJobs([
    {
      runtime: { language: "python", executionMode: "project", entrypoint: "tests/test_login.py" },
      providerPayload: {},
    },
    {
      runtime: { language: "java", executionMode: "project" },
      providerPayload: { projectBundleGzipBase64: "abc" },
    },
  ]);
  assert.equal(invalid.length, 2);
  assert.match(invalid[0].reason, /projectBundleGzipBase64/i);
  assert.match(invalid[1].reason, /entrypoint/i);
});

test("validateRuntimeJobs accepts selenium java/python project jobs with selectors", () => {
  const invalid = validateRuntimeJobs([
    {
      runtime: {
        framework: "selenium",
        language: "java",
        executionMode: "project",
        entrypoint: "src/test/java/LoginTest.java",
        testSelector: "LoginTest#happyPath",
      },
      providerPayload: { projectBundleGzipBase64: "abc" },
    },
    {
      runtime: {
        framework: "selenium",
        language: "python",
        executionMode: "project",
        entrypoint: "tests/test_login.py",
        testSelector: "tests/test_login.py::test_happy_path",
      },
      providerPayload: { projectBundleGzipBase64: "abc" },
    },
  ]);
  assert.deepEqual(invalid, []);
});

test("validateRuntimeJobs rejects selenium jobs without test selector", () => {
  const invalid = validateRuntimeJobs([
    {
      runtime: {
        framework: "selenium",
        language: "java",
        executionMode: "project",
        entrypoint: "src/test/java/LoginTest.java",
      },
      providerPayload: { projectBundleGzipBase64: "abc" },
    },
  ]);
  assert.equal(invalid.length, 1);
  assert.match(invalid[0].reason, /testSelector/i);
});

test("hasQueueableWork supports project bundles", () => {
  const queueable = hasQueueableWork({
    runtime: { language: "java", executionMode: "project" },
    providerPayload: { projectBundleGzipBase64: "abc" },
  });
  assert.equal(queueable, true);
});
