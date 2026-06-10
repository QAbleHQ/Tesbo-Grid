// Generates the GitHub Actions workflow YAML that Tesbo Grid commits to the
// customer's test repo. The workflow's only job is to invoke @tesbox/cli,
// which then submits the run to Tesbo Grid's existing /api/runs pipeline.
// Tests run on OUR infrastructure — GitHub Actions only acts as a free
// scheduler and log viewer.

import { RUN_ALL_GLOB } from "./suiteDiscovery.js";

const WORKFLOW_FILE_PREFIX = ".github/workflows/tesbo-grid-";
const TESBO_API_KEY_SECRET = "TESBO_GRID_API_KEY";

function slugify(input) {
  return String(input || "schedule")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/(?:^-+)|(?:-+$)/g, "")
    .slice(0, 40) || "schedule";
}

export function workflowFilePathForSchedule(schedule) {
  const slug = slugify(schedule.name);
  const idTag = String(schedule.id || "").replace(/[^a-z0-9]/gi, "").slice(0, 8) || "x";
  return `${WORKFLOW_FILE_PREFIX}${slug}-${idTag}.yml`;
}

function yamlEscape(value) {
  const str = String(value ?? "");
  if (str === "" || /[:#&*!|>'"%@`{}[\],\n]/.test(str)) {
    return JSON.stringify(str);
  }
  return str;
}

// Normalize a per-schedule environment into the lines that go under the
// `env:` block of the test step. We inline non-secret values directly so the
// YAML is self-documenting; secret-flagged values are emitted as
// ${{ secrets.NAME }} so they're never committed to the repo. The caller is
// responsible for pushing the actual secret value to GitHub repo secrets.
function envBlockLinesForEnvironment(environment) {
  const lines = [];
  if (!environment) return lines;

  if (environment.baseUrl) {
    // PLAYWRIGHT_BASE_URL is the Playwright convention; we also set a
    // framework-agnostic TESBO_BASE_URL so non-Playwright frameworks can
    // pick it up.
    lines.push(`          PLAYWRIGHT_BASE_URL: ${yamlEscape(environment.baseUrl)}`);
    lines.push(`          TESBO_BASE_URL: ${yamlEscape(environment.baseUrl)}`);
  }

  for (const v of Array.isArray(environment.variables) ? environment.variables : []) {
    if (!v?.key) continue;
    if (v.isSecret) {
      lines.push(`          ${v.key}: \${{ secrets.${v.key} }}`);
    } else {
      lines.push(`          ${v.key}: ${yamlEscape(v.value ?? "")}`);
    }
  }
  return lines;
}

// Names of the env vars above that the CLI must forward to the runner. GitHub
// injects their VALUES into the step's shell (via the env: block, secrets
// included); `@tesbox/cli --env-from NAME,…` then reads them by name and
// attaches them to the job payload so they reach the worker that runs the
// test. Passing names (not values) keeps secrets out of the committed YAML.
function envForwardNamesForEnvironment(environment) {
  if (!environment) return [];
  const names = [];
  if (environment.baseUrl) names.push("PLAYWRIGHT_BASE_URL", "TESBO_BASE_URL");
  for (const v of Array.isArray(environment.variables) ? environment.variables : []) {
    if (v?.key) names.push(v.key);
  }
  return [...new Set(names)];
}

/**
 * Build the glob that `@tesbox/cli run` should scan.
 *
 * `glob` (the npm package the CLI uses) supports brace expansion, so we can
 * pack multiple file paths into a single positional arg using `{a,b,c}` —
 * even when a single file is selected, this format works fine.
 */
function buildSpecPattern({ suites, runAllTests }) {
  if (runAllTests) return RUN_ALL_GLOB;
  const paths = (suites || [])
    .map((s) => s?.metadata?.path)
    .filter((p) => typeof p === "string" && p.length > 0);
  if (paths.length === 0) return RUN_ALL_GLOB;
  if (paths.length === 1) return paths[0];
  return `{${paths.join(",")}}`;
}

function commandForSuites({ framework, language, apiBaseUrl, projectId, suites, runAllTests, browser, envForwardNames }) {
  const lang = (language || "javascript").toLowerCase();
  const fw = (framework || "playwright").toLowerCase();
  const pattern = buildSpecPattern({ suites, runAllTests });
  // `--api-url` is emitted explicitly: the CLI's `run` subcommand targets the
  // runner-api, while other subcommands target the app API. Emitting the
  // configured runner URL here avoids surprises if a future CLI release changes
  // that default.
  const parts = [
    "npx -y @tesbox/cli run",
    yamlEscape(pattern),
    "--api-url", yamlEscape(apiBaseUrl),
    "--project-id", yamlEscape(projectId),
    "--framework", fw,
    "--language", lang,
  ];
  if (browser && fw === "selenium") {
    parts.push("--browser", yamlEscape(browser));
  }
  if (Array.isArray(envForwardNames) && envForwardNames.length > 0) {
    parts.push("--env-from", yamlEscape(envForwardNames.join(",")));
  }
  return parts.join(" ");
}

function setupStepsForLanguage(language) {
  const lang = (language || "javascript").toLowerCase();
  const steps = [
    "      - uses: actions/checkout@v4",
    "      - uses: actions/setup-node@v4",
    "        with:",
    "          node-version: '20'",
  ];
  if (lang === "python") {
    steps.push(
      "      - uses: actions/setup-python@v5",
      "        with:",
      "          python-version: '3.11'"
    );
  } else if (lang === "java") {
    steps.push(
      "      - uses: actions/setup-java@v4",
      "        with:",
      "          distribution: 'temurin'",
      "          java-version: '17'"
    );
  }
  return steps.join("\n");
}

/**
 * Generate workflow YAML for a Tesbo Grid schedule.
 *
 * @param {object} args
 * @param {object} args.schedule       — github_run_schedules row
 * @param {object[]} args.suites       — github_repo_suites rows selected for this schedule
 * @param {boolean} args.runAllTests
 * @param {string} args.apiBaseUrl     — public URL of the runner-api (must mount /api/runs)
 * @param {string} args.projectId
 * @param {string} args.framework
 * @param {string} args.language
 * @param {string} args.browser
 * @param {object} [args.environment]  — Optional AUT environment: { baseUrl, variables: [{key, value, isSecret}] }.
 *                                       baseUrl is exposed as PLAYWRIGHT_BASE_URL + TESBO_BASE_URL.
 */
export function generateWorkflowYaml({
  schedule,
  suites,
  runAllTests,
  apiBaseUrl,
  projectId,
  framework,
  language,
  browser,
  environment,
}) {
  const name = `Tesbo Grid — ${schedule.name}`;
  // Triggering is controlled entirely by Tesbo Grid's own scheduler, which
  // dispatches this workflow via the GitHub API (workflow_dispatch). We do NOT
  // emit a `schedule:` cron here on purpose: that would let GitHub fire the run
  // independently, double-triggering and giving us no way to capture the run
  // URL at dispatch time. The schedule's cron_expression still drives our
  // backend scheduler — it just never lands in this file.
  const triggers = ["  workflow_dispatch:"];

  const setupSteps = setupStepsForLanguage(language);
  const runCommand = commandForSuites({
    framework,
    language,
    apiBaseUrl,
    projectId,
    suites,
    runAllTests,
    browser,
    envForwardNames: envForwardNamesForEnvironment(environment),
  });

  const envLines = [
    `          TESBOX_API_KEY: \${{ secrets.${TESBO_API_KEY_SECRET} }}`,
    ...envBlockLinesForEnvironment(environment),
  ];

  return [
    `name: ${yamlEscape(name)}`,
    "",
    "# Managed by Tesbo Grid — do not edit manually. Re-run setup from",
    "# your Tesbo Grid project's Scheduled Runs page if you need changes.",
    "",
    "on:",
    triggers.join("\n"),
    "",
    "jobs:",
    "  run:",
    "    runs-on: ubuntu-latest",
    "    timeout-minutes: 60",
    "    steps:",
    setupSteps,
    "      - name: Run Tesbo Grid suite",
    "        env:",
    ...envLines,
    "        run: |",
    `          ${runCommand}`,
    "",
  ].join("\n");
}

export const WORKFLOW_API_KEY_SECRET_NAME = TESBO_API_KEY_SECRET;
