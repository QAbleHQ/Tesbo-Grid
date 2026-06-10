import test from "node:test";
import assert from "node:assert/strict";
import {
  safeJoin,
  parseJsonReporterOutput,
  mapResultStatus,
  flattenStepDescriptions,
  flattenTests,
  extractReportErrors,
  parseJUnitTestcases,
  buildRuntimeCommand,
  extractTestTitleFromJobTitle,
  escapeRegExpForGrep,
} from "./projectRunner.js";

test("extractReportErrors returns [] when report is null or undefined", () => {
  assert.deepEqual(extractReportErrors(null), []);
  assert.deepEqual(extractReportErrors(undefined), []);
});

test("extractReportErrors returns [] when errors is missing or not an array", () => {
  assert.deepEqual(extractReportErrors({}), []);
  assert.deepEqual(extractReportErrors({ errors: "boom" }), []);
});

test("extractReportErrors trims plain string errors", () => {
  assert.deepEqual(extractReportErrors({ errors: ["  config failed  "] }), ["config failed"]);
});

test("extractReportErrors reads message from object errors", () => {
  assert.deepEqual(extractReportErrors({ errors: [{ message: "boom" }] }), ["boom"]);
});

test("extractReportErrors falls back to value when message is absent or empty", () => {
  assert.deepEqual(extractReportErrors({ errors: [{ value: "from-value" }] }), ["from-value"]);
  assert.deepEqual(extractReportErrors({ errors: [{ message: "", value: "fallback" }] }), ["fallback"]);
});

test("extractReportErrors drops empty, whitespace-only, and message-less entries", () => {
  const report = { errors: ["", "   ", null, {}, { other: 1 }] };
  assert.deepEqual(extractReportErrors(report), []);
});

test("extractReportErrors preserves order across mixed string and object entries", () => {
  const report = { errors: ["first", { message: "second" }, "   ", { value: "third" }] };
  assert.deepEqual(extractReportErrors(report), ["first", "second", "third"]);
});

test("mapResultStatus maps passing outcomes to Passed", () => {
  assert.equal(mapResultStatus("passed"), "Passed");
  assert.equal(mapResultStatus("expected"), "Passed");
  assert.equal(mapResultStatus("PASSED"), "Passed");
});

test("mapResultStatus maps failing outcomes to Failed", () => {
  assert.equal(mapResultStatus("failed"), "Failed");
  assert.equal(mapResultStatus("timedout"), "Failed");
  assert.equal(mapResultStatus("interrupted"), "Failed");
  assert.equal(mapResultStatus("unexpected"), "Failed");
});

test("mapResultStatus maps unknown or empty outcomes to Skipped", () => {
  assert.equal(mapResultStatus("skipped"), "Skipped");
  assert.equal(mapResultStatus(""), "Skipped");
  assert.equal(mapResultStatus(undefined), "Skipped");
  assert.equal(mapResultStatus("something-else"), "Skipped");
});

test("parseJsonReporterOutput extracts the JSON object from surrounding noise", () => {
  const stdout = 'Running...\n{"status":"passed","suites":[]}\nDone';
  assert.deepEqual(parseJsonReporterOutput(stdout), { status: "passed", suites: [] });
});

test("parseJsonReporterOutput returns null when there is no JSON object", () => {
  assert.equal(parseJsonReporterOutput("no braces at all"), null);
});

test("parseJsonReporterOutput returns null on malformed JSON", () => {
  assert.equal(parseJsonReporterOutput("prefix {not valid json} suffix"), null);
});

test("extractTestTitleFromJobTitle returns null for non-string input", () => {
  assert.equal(extractTestTitleFromJobTitle(null), null);
  assert.equal(extractTestTitleFromJobTitle(123), null);
});

test("extractTestTitleFromJobTitle returns null when separator is absent", () => {
  assert.equal(extractTestTitleFromJobTitle("no separator here"), null);
});

test("extractTestTitleFromJobTitle extracts and trims the part after the separator", () => {
  assert.equal(extractTestTitleFromJobTitle("Suite :: My Login Test"), "My Login Test");
  assert.equal(extractTestTitleFromJobTitle("Suite ::    "), null);
});

test("escapeRegExpForGrep leaves plain text unchanged", () => {
  assert.equal(escapeRegExpForGrep("plain text"), "plain text");
});

test("escapeRegExpForGrep escapes regex metacharacters", () => {
  assert.equal(escapeRegExpForGrep("login(test).spec"), "login\\(test\\)\\.spec");
  assert.equal(escapeRegExpForGrep("a+b*c?"), "a\\+b\\*c\\?");
});

test("escapeRegExpForGrep escapes backslashes", () => {
  assert.equal(escapeRegExpForGrep("a\\b"), "a\\\\b");
});

test("safeJoin joins a relative path under the root", () => {
  assert.equal(safeJoin("/app/work", "tests/login.spec.ts"), "/app/work/tests/login.spec.ts");
});

test("safeJoin strips leading parent-directory traversal so the path stays under root", () => {
  assert.equal(safeJoin("/app/work", "../../etc/passwd"), "/app/work/etc/passwd");
});

test("flattenStepDescriptions returns the accumulator for non-array input", () => {
  assert.deepEqual(flattenStepDescriptions(undefined), []);
});

test("flattenStepDescriptions prefixes the category unless it is test.step", () => {
  assert.deepEqual(
    flattenStepDescriptions([{ title: "click button", category: "pw:api" }]),
    [{ description: "pw:api: click button" }],
  );
  assert.deepEqual(
    flattenStepDescriptions([{ title: "given a user", category: "test.step" }]),
    [{ description: "given a user" }],
  );
});

test("flattenStepDescriptions skips steps without a title and recurses into nested steps", () => {
  const steps = [
    { title: "", category: "pw:api" },
    { title: "parent", category: "test.step", steps: [{ title: "child", category: "pw:api" }] },
  ];
  assert.deepEqual(flattenStepDescriptions(steps), [
    { description: "parent" },
    { description: "pw:api: child" },
  ]);
});

test("flattenTests returns [] for an empty or missing report", () => {
  assert.deepEqual(flattenTests(null), []);
  assert.deepEqual(flattenTests({}), []);
});

test("flattenTests extracts a passing test with inherited spec file and project name", () => {
  const report = {
    config: { projects: [{ name: "chromium" }] },
    suites: [
      {
        title: "root",
        file: "login.spec.ts",
        specs: [
          {
            title: "should login",
            file: "login.spec.ts",
            tests: [
              {
                results: [{ status: "passed", duration: 1200, errors: [] }],
                projectName: "chromium",
                tags: ["@smoke"],
              },
            ],
          },
        ],
        suites: [],
      },
    ],
  };
  const tests = flattenTests(report);
  assert.equal(tests.length, 1);
  assert.equal(tests[0].name, "should login");
  assert.equal(tests[0].status, "Passed");
  assert.equal(tests[0].spec, "login.spec.ts");
  assert.equal(tests[0].fullTitle, "root > should login");
  assert.equal(tests[0].projectName, "chromium");
  assert.equal(tests[0].durationMs, 1200);
  assert.equal(tests[0].errorMessage, null);
});

test("flattenTests surfaces the first error message and stack from the latest result", () => {
  const report = {
    suites: [
      {
        title: "S",
        specs: [
          {
            title: "broken spec",
            file: "broken.spec.ts",
            tests: [
              {
                results: [
                  {
                    status: "failed",
                    duration: 50,
                    errors: [{ message: "boom" }],
                    error: { stack: "stack-trace" },
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  };
  const tests = flattenTests(report);
  assert.equal(tests.length, 1);
  assert.equal(tests[0].status, "Failed");
  assert.equal(tests[0].errorMessage, "boom");
  assert.equal(tests[0].errorStack, "stack-trace");
  assert.equal(tests[0].projectName, null);
});

test("parseJUnitTestcases parses a passing testcase and converts time to ms", () => {
  const xml = '<testcase name="t1" classname="MyTest" time="1.5"></testcase>';
  const tests = parseJUnitTestcases(xml);
  assert.equal(tests.length, 1);
  assert.equal(tests[0].name, "t1");
  assert.equal(tests[0].spec, "MyTest");
  assert.equal(tests[0].status, "Passed");
  assert.equal(tests[0].durationMs, 1500);
});

test("parseJUnitTestcases handles self-closing testcases", () => {
  const xml = '<testcase name="t2" classname="C" time="0.1"/>';
  const tests = parseJUnitTestcases(xml);
  assert.equal(tests.length, 1);
  assert.equal(tests[0].status, "Passed");
  assert.equal(tests[0].durationMs, 100);
});

test("parseJUnitTestcases marks failures and captures the failure body", () => {
  const xml = '<testcase name="t3" classname="C"><failure message="x">assertion failed</failure></testcase>';
  const tests = parseJUnitTestcases(xml);
  assert.equal(tests[0].status, "Failed");
  assert.equal(tests[0].errorMessage, "assertion failed");
});

test("parseJUnitTestcases marks skipped testcases and defaults duration to null", () => {
  const xml = '<testcase name="t4" classname="C"><skipped/></testcase>';
  const tests = parseJUnitTestcases(xml);
  assert.equal(tests[0].status, "Skipped");
  assert.equal(tests[0].durationMs, null);
});

test("buildRuntimeCommand builds the python command and appends the entry file", () => {
  const result = buildRuntimeCommand({}, { language: "python" }, "test_login.py", "");
  assert.equal(result.command, "python3");
  assert.deepEqual(result.args, [
    "-m",
    "playwright",
    "test",
    "--reporter=json",
    "--workers=1",
    "--output",
    "artifacts/test-results",
    "test_login.py",
  ]);
});

test("buildRuntimeCommand passes through an explicit java runtime command", () => {
  const result = buildRuntimeCommand({}, { language: "java", command: "gradle test" }, "", "");
  assert.deepEqual(result, { shellCommand: "gradle test" });
});

test("buildRuntimeCommand builds a targeted maven command from the job title", () => {
  const result = buildRuntimeCommand({ title: "Suite :: LoginTest" }, { language: "java" }, "", "");
  assert.deepEqual(result, { shellCommand: 'mvn -B -Dtest="LoginTest" test' });
});

test("buildRuntimeCommand falls back to a full maven run without a test title", () => {
  const result = buildRuntimeCommand({ title: "no separator" }, { language: "java" }, "", "");
  assert.deepEqual(result, { shellCommand: "mvn -B test" });
});

test("buildRuntimeCommand builds the node command with config, grep, and entry file", () => {
  const result = buildRuntimeCommand(
    { title: "Suite :: My Test" },
    { language: "javascript" },
    "tests/login.spec.ts",
    "playwright.config.ts",
  );
  assert.equal(result.command, "node");
  assert.ok(result.args.includes("--config"));
  assert.equal(result.args[result.args.indexOf("--config") + 1], "playwright.config.ts");
  assert.ok(result.args.includes("--grep"));
  assert.equal(result.args[result.args.indexOf("--grep") + 1], "My Test");
  assert.equal(result.args[result.args.length - 1], "tests/login.spec.ts");
});

test("buildRuntimeCommand omits config and grep for the node command when not provided", () => {
  const result = buildRuntimeCommand({ title: "plain title" }, { language: "javascript" }, "spec.ts", "");
  assert.equal(result.command, "node");
  assert.ok(!result.args.includes("--config"));
  assert.ok(!result.args.includes("--grep"));
  assert.equal(result.args[result.args.length - 1], "spec.ts");
});
