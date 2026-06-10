import test from "node:test";
import assert from "node:assert/strict";
import {
  buildFailureSignature,
  buildClusterKey,
  buildHumanFailureTitle,
  buildHumanFailureSummary,
  extractErrorType,
  clusterFailedTestsForRun,
} from "./rootCauseClusterer.js";

test("buildFailureSignature normalizes dynamic values", () => {
  const signature = buildFailureSignature({
    error_message: "Timeout after 3456ms while waiting for #submit-1234",
    error_stack: "Error\n at tests/checkout.spec.ts:27:11",
  });
  assert.ok(signature.includes("timeout"));
  assert.ok(!signature.includes("3456"));
});

test("buildClusterKey is deterministic", () => {
  const sig = "assert mismatch | at tests/spec.ts:1:1";
  assert.equal(buildClusterKey(sig), buildClusterKey(sig));
});

test("buildHumanFailureTitle strips CDATA wrappers and Selenium noise", () => {
  const title = buildHumanFailureTitle({
    error_message:
      "<![CDATA[org.openqa.selenium.TimeoutException: Expected condition failed: waiting for visibility of #login-button\n" +
      "Build info: version: '4.18.0', revision: 'abc123'\n" +
      "System info: os.name: 'Mac OS X', os.arch: 'aarch64'\n" +
      "Driver info: org.openqa.selenium.firefox.GeckoDriver\n" +
      "  at java.base/jdk.internal.reflect.DirectConstructorHandleAccessor.newInstance(DirectConstructorHandleAccessor.java:62)]]>",
    error_stack: null,
  });
  assert.ok(title.startsWith("TimeoutException"), `got: ${title}`);
  assert.ok(title.includes("login-button"), `got: ${title}`);
  assert.ok(!title.includes("Build info"), `got: ${title}`);
  assert.ok(!title.includes("CDATA"), `got: ${title}`);
  assert.ok(title.length <= 160, `got length ${title.length}`);
});

test("buildHumanFailureTitle falls back to first line when no exception class", () => {
  const title = buildHumanFailureTitle({
    error_message: "expected status 200 but received 500",
    error_stack: null,
  });
  assert.equal(title, "expected status 200 but received 500");
});

test("buildHumanFailureTitle handles empty input gracefully", () => {
  assert.equal(buildHumanFailureTitle({}), "Test failure");
  assert.equal(buildHumanFailureTitle({ error_message: "" }), "Test failure");
});

test("buildHumanFailureSummary stops at Selenium boilerplate", () => {
  const summary = buildHumanFailureSummary({
    error_message:
      "ElementClickInterceptedException: element click intercepted: Element <button> is not clickable\n" +
      "Build info: version: '4.18.0'\n" +
      "System info: os.name: 'Mac OS X'\n" +
      "  at org.openqa.selenium.support.ui.ExpectedConditions",
  });
  assert.ok(summary.startsWith("ElementClickInterceptedException"), summary);
  assert.ok(!summary.includes("Build info"), summary);
  assert.ok(!summary.includes("at org.openqa"), summary);
});

test("extractErrorType picks up FQDN and bare exception names", () => {
  assert.equal(
    extractErrorType("org.openqa.selenium.TimeoutException: foo"),
    "TimeoutException"
  );
  assert.equal(extractErrorType("AssertionError: nope"), "AssertionError");
  assert.equal(extractErrorType("plain text"), null);
});

function makeClusteringFake({ failedRows }) {
  const calls = { cluster: [], link: [] };
  const query = async (sql, params) => {
    if (sql.startsWith("SELECT")) {
      return { rows: failedRows };
    }
    if (sql.includes("INSERT INTO report_failure_clusters")) {
      calls.cluster.push(params);
      return { rows: [{ id: `c${calls.cluster.length}`, inserted: true }] };
    }
    if (sql.includes("INSERT INTO report_test_cluster_links")) {
      calls.link.push(params);
      return { rows: [] };
    }
    throw new Error(`unexpected query: ${sql.slice(0, 40)}`);
  };
  return { query, calls };
}

test("clusterFailedTestsForRun returns early when there are no failed tests", async () => {
  let callCount = 0;
  const query = async () => {
    callCount += 1;
    return { rows: [] };
  };
  const result = await clusterFailedTestsForRun({
    projectId: "p1",
    runId: "r1",
    query,
  });
  assert.deepEqual(result, { clustered: 0, clustersCreated: 0 });
  assert.equal(callCount, 1);
});

test("clusterFailedTestsForRun classifies element-wait timeouts as SCRIPT_ISSUE", async () => {
  const { query, calls } = makeClusteringFake({
    failedRows: [
      {
        id: "t1",
        error_message: "Timeout waiting for element #login-button",
        error_stack: null,
        ai_analysis_category: null,
      },
    ],
  });
  const result = await clusterFailedTestsForRun({
    projectId: "p1",
    runId: "r1",
    query,
  });
  assert.deepEqual(result, { clustered: 1, clustersCreated: 1 });
  assert.equal(calls.cluster[0][4], "SCRIPT_ISSUE");
});

test("clusterFailedTestsForRun classifies findElement timeouts as SCRIPT_ISSUE", async () => {
  const { query, calls } = makeClusteringFake({
    failedRows: [
      {
        id: "t1",
        error_message:
          "TimeoutException: timed out after 30 seconds in findElement(By.css('#submit'))",
        error_stack: null,
        ai_analysis_category: null,
      },
    ],
  });
  await clusterFailedTestsForRun({ projectId: "p1", runId: "r1", query });
  assert.equal(calls.cluster[0][4], "SCRIPT_ISSUE");
});

test("clusterFailedTestsForRun classifies ECONNREFUSED as ENVIRONMENT_ISSUE", async () => {
  const { query, calls } = makeClusteringFake({
    failedRows: [
      {
        id: "t1",
        error_message: "ECONNREFUSED connecting to selenium hub at localhost:4444",
        error_stack: null,
        ai_analysis_category: null,
      },
    ],
  });
  await clusterFailedTestsForRun({ projectId: "p1", runId: "r1", query });
  assert.equal(calls.cluster[0][4], "ENVIRONMENT_ISSUE");
});

test("clusterFailedTestsForRun classifies session creation failures as ENVIRONMENT_ISSUE", async () => {
  const { query, calls } = makeClusteringFake({
    failedRows: [
      {
        id: "t1",
        error_message: "session not created: Chrome version mismatch",
        error_stack: null,
        ai_analysis_category: null,
      },
    ],
  });
  await clusterFailedTestsForRun({ projectId: "p1", runId: "r1", query });
  assert.equal(calls.cluster[0][4], "ENVIRONMENT_ISSUE");
});

test("clusterFailedTestsForRun classifies assertion mismatches as ACTUAL_BUG", async () => {
  const { query, calls } = makeClusteringFake({
    failedRows: [
      {
        id: "t1",
        error_message: "AssertionError: expected 200 but received 500",
        error_stack: null,
        ai_analysis_category: null,
      },
    ],
  });
  await clusterFailedTestsForRun({ projectId: "p1", runId: "r1", query });
  assert.equal(calls.cluster[0][4], "ACTUAL_BUG");
});

test("clusterFailedTestsForRun respects pre-existing ai_analysis_category", async () => {
  const { query, calls } = makeClusteringFake({
    failedRows: [
      {
        id: "t1",
        error_message: "no such element: #foo",
        error_stack: null,
        ai_analysis_category: "ACTUAL_BUG",
      },
    ],
  });
  await clusterFailedTestsForRun({ projectId: "p1", runId: "r1", query });
  assert.equal(calls.cluster[0][4], "ACTUAL_BUG");
});

test("clusterFailedTestsForRun passes null category when no signal matches", async () => {
  const { query, calls } = makeClusteringFake({
    failedRows: [
      {
        id: "t1",
        error_message: "some completely opaque failure with no signals",
        error_stack: null,
        ai_analysis_category: null,
      },
    ],
  });
  await clusterFailedTestsForRun({ projectId: "p1", runId: "r1", query });
  assert.equal(calls.cluster[0][4], null);
});

test("clusterFailedTestsForRun writes a cluster link per failed test", async () => {
  const { query, calls } = makeClusteringFake({
    failedRows: [
      {
        id: "t1",
        error_message: "no such element: #a",
        error_stack: null,
        ai_analysis_category: null,
      },
      {
        id: "t2",
        error_message: "ECONNREFUSED",
        error_stack: null,
        ai_analysis_category: null,
      },
    ],
  });
  const result = await clusterFailedTestsForRun({
    projectId: "p1",
    runId: "r1",
    query,
  });
  assert.equal(result.clustered, 2);
  assert.equal(calls.link.length, 2);
  assert.equal(calls.link[0][0], "t1");
  assert.equal(calls.link[1][0], "t2");
  assert.equal(calls.link[0][3], "normalized_failure_signature");
});
