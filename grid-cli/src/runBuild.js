/**
 * `tesbox run-build [opts] -- <command>` implementation.
 *
 * Centralized CLI orchestration for a Selenium / TestNG run:
 *
 *   1. Generate a stable buildId (or accept --build-id from CI).
 *   2. POST /tesbo-reports/builds/start so the row appears in the dashboard
 *      with status IN_PROGRESS *immediately* — before tests start running.
 *   3. Run the user's test command (e.g. `mvn test` / `java Runner.Runner …`)
 *      with TESBO_BUILD_ID injected. The user's framework runs unchanged;
 *      it does not need to know about the buildId.
 *   4. After the command exits, parse test-output/testng-results.xml (or
 *      junit/pytest equivalents) and upload to /ingest/test-report with the
 *      same buildId. The backend finds the existing row by externalRef and
 *      updates it in place — no new row is created.
 *
 * Result: ONE row per execution. Visible from start to finish. The row's
 * dashboard URL is printed both before and after the test command runs so
 * users can click through while tests are still running.
 */

import { spawn } from "node:child_process";
import process from "node:process";
import crypto from "node:crypto";
import { uploadResults } from "./uploadResults.js";

const DEFAULT_APP_API_URL = "http://localhost:7100";

function log(s) {
  process.stdout.write(`${s}\n`);
}
function logErr(s) {
  process.stderr.write(`${s}\n`);
}

function generateBuildId() {
  // build-2026-04-29t12-58-17-9a3c12  → readable + collision-resistant.
  const stamp = new Date()
    .toISOString()
    .replace(/[:.TZ]/g, "-")
    .replace(/--+/g, "-")
    .toLowerCase()
    .slice(0, 19);
  const rand = crypto.randomBytes(3).toString("hex");
  return `${stamp}-${rand}`;
}

async function startBuild({ apiUrl, apiKey, projectId, buildId, runName, sourceType }) {
  const url = `${apiUrl.replace(/\/+$/, "")}/api/projects/${projectId}/tesbo-reports/builds/start`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-project-access-key": apiKey,
    },
    body: JSON.stringify({
      buildId,
      runName: runName || `Build ${buildId}`,
      sourceType: sourceType || "SELENIUM_LOCAL",
      startedAt: new Date().toISOString(),
    }),
  });
  if (!res.ok) {
    let body = "";
    try {
      body = await res.text();
    } catch {}
    throw new Error(
      `builds/start failed (${res.status}). ${body ? body.slice(0, 200) : ""}`.trim()
    );
  }
  return res.json();
}

async function resolveProjectId({ apiKey, apiUrl }) {
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

function spawnUserCommand({ command, args, env, cwd }) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { env, cwd, stdio: "inherit" });
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

export async function runBuild(options) {
  const {
    apiKey,
    apiUrl = DEFAULT_APP_API_URL,
    buildId: explicitBuildId,
    runName,
    sourceType,
    resultsPath = ".",
    skipUpload = false,
    command,
    commandArgs,
  } = options;

  if (!apiKey) {
    logErr("API key required. Use --api-key or set TESBOX_API_KEY env variable.");
    return 1;
  }
  if (!command) {
    logErr('Missing test command. Pass it after `--`. Example: tesbox run-build -- mvn test');
    return 1;
  }

  const buildId = explicitBuildId || generateBuildId();
  const startedAt = new Date().toISOString();

  log(`\n  \x1b[2m▸\x1b[0m Build id  \x1b[1m${buildId}\x1b[0m`);

  log("  Resolving project from tesbo key…");
  let projectId;
  try {
    projectId = await resolveProjectId({ apiKey, apiUrl });
  } catch (err) {
    logErr(`  \x1b[31m✗\x1b[0m ${err.message}`);
    return 1;
  }
  log(`  \x1b[32m✓\x1b[0m Project  \x1b[2m${projectId}\x1b[0m`);

  // Pre-register: row appears in the dashboard right away with IN_PROGRESS
  // status so the user can open the link while their tests are still running.
  let registered;
  try {
    registered = await startBuild({
      apiUrl,
      apiKey,
      projectId,
      buildId,
      runName,
      sourceType,
    });
  } catch (err) {
    logErr(`  \x1b[31m✗\x1b[0m ${err.message}`);
    return 1;
  }
  log(`  \x1b[32m✓\x1b[0m Build registered  \x1b[2m${registered.runId}\x1b[0m`);
  if (registered.runUrl) {
    log(`\n  Dashboard  \x1b[36m${registered.runUrl}\x1b[0m`);
  }

  // Inject env vars the user's framework can optionally pick up. The build
  // works without it — these are only used if the framework is
  // tesbo-aware and wants to tag its grid sessions with the same buildId.
  const childEnv = {
    ...process.env,
    TESBO_BUILD_ID: buildId,
    TESBO_PROJECT_ID: projectId,
    TESBO_RUN_URL: registered.runUrl || "",
  };

  log(`\n  Running  \x1b[2m${command} ${(commandArgs || []).join(" ")}\x1b[0m\n`);

  // Capture mtime cutoff ~5s before spawn so we only upload artifacts the
  // user's command actually produced. This stops us from sweeping up months
  // of accumulated screenshots in failed_test_screenshot/ on every run.
  const artifactsSinceMs = Date.now() - 5000;

  const exitCode = await spawnUserCommand({
    command,
    args: commandArgs || [],
    env: childEnv,
    cwd: process.cwd(),
  });
  const completedAt = new Date().toISOString();

  if (skipUpload) {
    log(`\n  \x1b[2m(skip-upload set; not uploading results)\x1b[0m`);
    log(`  Re-run upload manually:`);
    log(`    tesbox upload-results ${resultsPath} --api-key <key> --build-id ${buildId}\n`);
    return exitCode;
  }

  log("\n  Uploading results…");
  const uploadExit = await uploadResults({
    pathArg: resultsPath,
    apiKey,
    apiUrl,
    runName,
    sourceType: sourceType || "SELENIUM_LOCAL",
    buildId,
    startedAt,
    completedAt,
    artifactsSinceMs,
  });

  // Surface the worse of the two exit codes so CI fails on either a test
  // failure or an upload failure.
  return Math.max(exitCode, uploadExit);
}
