/**
 * `tesbox grid-run [opts] -- <command>` implementation.
 *
 * Resolves the user's project from a `tesbo_*` API key, sets
 *   SELENIUM_REMOTE_URL=https://<projectId>:<key>@<gridHost>/wd/hub
 * in the child process environment, runs <command>, and on exit
 * automatically uploads the test results from the conventional output
 * directories (test-output/, target/surefire-reports/, etc.).
 *
 * Equivalent to running these manually:
 *   export SELENIUM_REMOTE_URL=...
 *   <command>
 *   tesbox upload-results . --api-key tesbo_...
 */

import { spawn } from "node:child_process";
import process from "node:process";
import crypto from "node:crypto";
import { uploadResults } from "./uploadResults.js";

const DEFAULT_GRID_HOST = "localhost:4444";
const DEFAULT_APP_API_URL = "http://localhost:7100";

function log(s) {
  process.stdout.write(`${s}\n`);
}
function logErr(s) {
  process.stderr.write(`${s}\n`);
}

// Same shape `tesbox run-build` uses — a sortable timestamp + 6 hex chars.
// Sharing the format means dashboard search/sort across both code paths
// behaves identically, and the user can copy a buildId between commands.
function generateBuildId() {
  const stamp = new Date()
    .toISOString()
    .replace(/[:.TZ]/g, "-")
    .replace(/--+/g, "-")
    .toLowerCase()
    .slice(0, 19);
  return `${stamp}-${crypto.randomBytes(3).toString("hex")}`;
}

function buildSeleniumUrl({ apiKey, projectId, gridHost }) {
  // Basic-auth credentials must be URL-encoded so a `+`/`/` in the key does
  // not break the URL parser. The proxy strips the auth and uses the key.
  const u = encodeURIComponent(projectId);
  const p = encodeURIComponent(apiKey);
  return `https://${u}:${p}@${gridHost}/wd/hub`;
}

async function resolveProject({ apiKey, apiUrl }) {
  const url = `${apiUrl.replace(/\/+$/, "")}/api/tesbo-reports/project-by-key`;
  const res = await fetch(url, {
    method: "GET",
    headers: { "x-project-access-key": apiKey },
  });
  if (!res.ok) {
    throw new Error(
      `Project lookup failed (${res.status}). Check that --api-key is a valid tesbo_* project key.`
    );
  }
  const json = await res.json();
  if (!json?.projectId) throw new Error("Project lookup returned no projectId");
  return json.projectId;
}

function runCommand({ command, args, env, cwd }) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      env,
      cwd,
      stdio: "inherit",
    });
    child.on("error", (err) => {
      logErr(`\n  \x1b[31m✗\x1b[0m Failed to spawn "${command}": ${err.message}`);
      resolve(1);
    });
    child.on("exit", (code, signal) => {
      if (signal) {
        logErr(`\n  \x1b[33m!\x1b[0m Test command exited via signal ${signal}`);
        resolve(128);
      } else {
        resolve(code ?? 1);
      }
    });
  });
}

export async function gridRun(options) {
  const {
    apiKey,
    apiUrl = DEFAULT_APP_API_URL,
    gridHost = DEFAULT_GRID_HOST,
    browser,
    resultsPath = ".",
    runName,
    skipUpload = false,
    command,
    commandArgs,
  } = options;

  if (!apiKey) {
    logErr("API key required. Use --api-key or set TESBOX_API_KEY env variable.");
    return 1;
  }
  if (!command) {
    logErr('Missing test command. Pass it after `--`. Example: tesbox grid-run -- mvn test');
    return 1;
  }

  const startedAt = new Date().toISOString();
  // Generate a buildId once and share it across the test process and the
  // post-run upload. The id ties three things together in the dashboard:
  //   1. The `report_runs` row (via execution_run_id = `build-<buildId>`)
  //   2. Every Selenium session that picked up `tesbo:options.build` from
  //      the env var below — which is what makes the per-test "Live VNC"
  //      and "Session recording" links possible on the report page.
  //   3. CI usage analytics that group sessions by build.
  // Honour an externally-provided buildId so re-runs share a row.
  const buildId =
    process.env.TESBO_BUILD_ID && String(process.env.TESBO_BUILD_ID).trim()
      ? String(process.env.TESBO_BUILD_ID).trim()
      : generateBuildId();

  log("\n  Resolving project from tesbo key…");
  let projectId;
  try {
    projectId = await resolveProject({ apiKey, apiUrl });
  } catch (err) {
    logErr(`  \x1b[31m✗\x1b[0m ${err.message}`);
    return 1;
  }
  log(`  \x1b[32m✓\x1b[0m Project  \x1b[2m${projectId}\x1b[0m`);
  log(`  \x1b[32m✓\x1b[0m Build id  \x1b[2m${buildId}\x1b[0m`);

  const seleniumUrl = buildSeleniumUrl({ apiKey, projectId, gridHost });
  // Show the url with the key redacted; users sometimes paste this output into
  // tickets and we don't want to leak credentials.
  const redacted = seleniumUrl.replace(
    /:([^@/]+)@/,
    (_m, _g) => `:${"*".repeat(Math.min(_g.length, 12))}@`
  );
  log(`  \x1b[32m✓\x1b[0m Grid URL  \x1b[2m${redacted}\x1b[0m`);
  if (browser) log(`  \x1b[32m✓\x1b[0m Browser  \x1b[2m${browser}\x1b[0m`);

  const childEnv = {
    ...process.env,
    SELENIUM_REMOTE_URL: seleniumUrl,
    // Many frameworks read these names instead/additionally:
    SELENIUM_GRID_URL: seleniumUrl,
    WEBDRIVER_REMOTE_URL: seleniumUrl,
    TESBO_PROJECT_ID: projectId,
    TESBO_API_KEY: apiKey,
    // Tesbo-aware test code can read this env var and set
    // `tesbo:options.build = process.env.TESBO_BUILD_ID` plus
    // `tesbo:options.name = "<class>.<method>"` on its WebDriver
    // capabilities. The selenium-proxy stores both on the session row,
    // and the report ingest then joins each test in testng-results.xml
    // back to the exact session that produced its screenshots/video — so
    // the dashboard can show a "Live VNC" / "Session recording" link on
    // every failed test row. Frameworks that don't read this env var
    // continue to work; they just won't get the per-test link.
    TESBO_BUILD_ID: buildId,
  };
  if (browser) {
    childEnv.SELENIUM_BROWSER = browser;
    childEnv.TESBO_BROWSER = browser;
  }

  log(`\n  Running  \x1b[2m${command} ${(commandArgs || []).join(" ")}\x1b[0m\n`);
  const exitCode = await runCommand({
    command,
    args: commandArgs || [],
    env: childEnv,
    cwd: process.cwd(),
  });
  const completedAt = new Date().toISOString();

  if (skipUpload) {
    log(`\n  \x1b[2m(skip-upload set; not uploading results)\x1b[0m`);
    return exitCode;
  }

  log("\n  Uploading results…");
  const uploadExit = await uploadResults({
    pathArg: resultsPath,
    apiKey,
    apiUrl,
    runName,
    sourceType: "SELENIUM_LOCAL",
    startedAt,
    completedAt,
    // Pass the buildId so the upload lands on the same `report_runs` row
    // the Selenium sessions tagged themselves with. Required for the
    // session-to-test correlation pass on the backend.
    buildId,
  });

  // Surface the worse of the two exit codes so CI fails on either a test
  // failure or an upload failure.
  return Math.max(exitCode, uploadExit);
}
