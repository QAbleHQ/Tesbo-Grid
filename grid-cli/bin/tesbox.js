#!/usr/bin/env node

// `run.js` (managed-mode submission) imports `glob`, which the new
// upload-results / grid-run / run-build commands don't need. Lazy-load it so
// a missing glob install does not block users who only want the local-run
// commands.
import { uploadResults } from "../src/uploadResults.js";
import { gridRun } from "../src/gridRun.js";
import { runBuild } from "../src/runBuild.js";

const args = process.argv.slice(2);
const command = args[0];

if (!command || command === "--help" || command === "-h") {
  console.log(`
  @tesbox/cli — Run tests on TesboGrid infrastructure

  Usage:
    tesbox run-build [options] -- <command>               Orchestrate a build: register, run command, upload (recommended)
    tesbox upload-results <path> [options]                Upload existing test results to Tesbo Reports
    tesbox grid-run [options] -- <command>                Like run-build but also injects SELENIUM_REMOTE_URL
    tesbox run <glob>  [options]                          Submit tests to TesboGrid (managed mode)
    tesbox connect-tesbo [options]                        Link a txe_ key to a tesbo_ project
    tesbox disconnect-tesbo [options]                     Unlink a txe_ key

  Common options:
    --api-key <key>        API key (or set TESBOX_API_KEY env). A tesbo_* key auto-resolves the project.
    --api-url <url>        App API base URL (default: http://localhost:7100; set TESBOX_API_URL)

  ─── tesbox run (managed) ──────────────────────────────────────────────
    --spec <glob>          Glob pattern for spec files (alternative to positional arg)
    --language <lang>      Test language: javascript | python | java (default: auto-detect)
    --framework <name>     Framework: playwright | selenium (default: auto-detect)
    --browser <name>       Remote browser for selenium runs: chrome | firefox | edge
    --entrypoint <file>    Test entry file (required for python, optional for java)
    --command <cmd>        Custom project test command for java/python selenium runs
    --project-id <id>      Project ID — only needed for txe_* keys not bound to a project
    --start-url <url>      Base URL passed to tests
    --env KEY=VALUE        Env var forwarded to the test runtime (repeatable)
    --env-from NAME[,…]    Forward these env vars from the CLI's own environment
    --execution-mode <m>   Job payload mode: auto | script | project (default: auto)
    --timeout <ms>         Overall run timeout in ms (default: 3600000 = 60min)
    --run-name <name>      Optional Tesbo report run name

  ─── tesbox grid-run (local + upload) ──────────────────────────────────
    Tests execute on YOUR machine but the browser runs on Tesbo Grid.
    SELENIUM_REMOTE_URL is injected automatically and results are uploaded
    after the command exits.

    --browser <name>       chrome | firefox | edge (sets SELENIUM_BROWSER)
    --grid-host <host>     Override grid host (default: localhost:4444; set TESBOX_GRID_HOST)
    --results-path <path>  Where to look for results after the run (default: cwd)
    --run-name <name>      Friendly name for the report run
    --skip-upload          Run the command but do not upload results

  ─── tesbox run-build (orchestrated, recommended) ─────────────────────
    Generate a buildId, register the build (visible in the dashboard
    immediately as "Running"), execute the user's test command, then upload
    the testng-results.xml back to the SAME row using the buildId. ONE row
    per execution — no duplicates, no manual linking.

    --build-id <id>        Use a specific buildId instead of an auto-generated
                           one (e.g. CI_JOB_ID). Required for splitting one
                           CI build across multiple shards/retries.
    --run-name <name>      Friendly name for the build row
    --source-type <type>   Source label (default: SELENIUM_LOCAL)
    --results-path <path>  Where to look for testng-results.xml after the
                           command exits (default: cwd)
    --skip-upload          Run the command but do not upload results

  ─── tesbox upload-results ────────────────────────────────────────────
    Upload an already-produced test report to Tesbo Reports.
    Auto-detects testng-results.xml, surefire-reports/*.xml, junit.xml,
    pytest report.json. Also collects nearby screenshots/videos.

    --build-id <id>        Update the build row created by run-build /
                           builds/start with this buildId. Without this,
                           the upload uses a content-derived hash for dedup.
    --format <name>        testng | junit | pytest (default: auto-detect)
    --run-name <name>      Friendly name for the report run
    --source-type <type>   Source label (default: SELENIUM_LOCAL)
    --run-id <uuid>        Update an existing run by UUID
    --no-screenshots       Skip screenshot/video collection

  Examples:
    # Recommended: orchestrate a build end-to-end. ONE dashboard row, visible
    # from the moment the test starts.
    tesbox run-build --api-key tesbo_... -- java Runner.Runner --config new_panel_chrome
    tesbox run-build --api-key tesbo_... -- mvn test

    # CI-friendly: use the CI build id so retries / shards land on the same row
    tesbox run-build --api-key tesbo_... --build-id $GITHUB_RUN_ID -- mvn test

    # Upload an already-produced test-output/ (no orchestration)
    tesbox upload-results test-output/ --api-key tesbo_...

    # Upload to a specific build registered earlier
    tesbox upload-results test-output/ --api-key tesbo_... --build-id $GITHUB_RUN_ID

    # Submit project to managed runners (no local install needed)
    tesbox run --spec "tests/**/*.spec.ts" --api-key tesbo_...
  `);
  process.exit(0);
}

if (
  ![
    "run",
    "connect-tesbo",
    "disconnect-tesbo",
    "upload-results",
    "grid-run",
    "run-build",
  ].includes(command)
) {
  console.error(`Unknown command: ${command}\nRun "tesbox --help" for usage.`);
  process.exit(1);
}

function flag(name) {
  const idx = args.indexOf(name);
  return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : undefined;
}

function bool(name) {
  return args.includes(name);
}

// Collect every value for a repeatable flag (e.g. multiple `--env KEY=VALUE`).
function flagAll(name) {
  const out = [];
  for (let i = 0; i < args.length - 1; i += 1) {
    if (args[i] === name) out.push(args[i + 1]);
  }
  return out;
}

// Resolve the env vars to forward to the remote test runtime. Two merged
// sources: `--env-from NAME1,NAME2` reads values from the CLI's own process.env
// by name (so CI can inject secrets via the shell without writing them into
// argv), and `--env KEY=VALUE` (repeatable) sets them explicitly and wins.
function resolveEnvVars() {
  const env = {};
  for (const list of flagAll("--env-from")) {
    for (const name of String(list).split(",").map((s) => s.trim()).filter(Boolean)) {
      if (process.env[name] !== undefined) env[name] = String(process.env[name]);
    }
  }
  for (const pair of flagAll("--env")) {
    const eq = String(pair).indexOf("=");
    if (eq <= 0) continue;
    const key = pair.slice(0, eq).trim();
    if (key) env[key] = String(pair.slice(eq + 1));
  }
  return env;
}

// ── upload-results ───────────────────────────────────────────────────────────
if (command === "upload-results") {
  const positionalPath = args[1] && !args[1].startsWith("--") ? args[1] : undefined;
  const pathArg = flag("--path") || positionalPath || ".";
  const apiKey = flag("--api-key") || process.env.TESBOX_API_KEY;
  const apiUrl = flag("--api-url") || process.env.TESBOX_API_URL || "http://localhost:7100";
  const includeScreenshots = !bool("--no-screenshots");

  uploadResults({
    pathArg,
    apiKey,
    apiUrl,
    runName: flag("--run-name") || process.env.TESBO_RUN_NAME,
    sourceType: flag("--source-type"),
    runId: flag("--run-id"),
    buildId: flag("--build-id") || process.env.TESBO_BUILD_ID,
    startedAt: flag("--started-at"),
    completedAt: flag("--completed-at"),
    format: flag("--format"),
    includeScreenshots,
  }).then((exitCode) => process.exit(exitCode));
}

// ── run-build (orchestrated CLI flow) ────────────────────────────────────────
else if (command === "run-build") {
  const dashIdx = args.indexOf("--");
  if (dashIdx === -1 || dashIdx === args.length - 1) {
    console.error('Missing test command after `--`. Example: tesbox run-build -- mvn test');
    process.exit(1);
  }
  const optsArgs = args.slice(1, dashIdx);
  const cmdParts = args.slice(dashIdx + 1);

  function flagFrom(list, name) {
    const i = list.indexOf(name);
    return i !== -1 && i + 1 < list.length ? list[i + 1] : undefined;
  }
  function boolFrom(list, name) {
    return list.includes(name);
  }

  const apiKey = flagFrom(optsArgs, "--api-key") || process.env.TESBOX_API_KEY;
  const apiUrl =
    flagFrom(optsArgs, "--api-url") || process.env.TESBOX_API_URL || "http://localhost:7100";

  runBuild({
    apiKey,
    apiUrl,
    buildId: flagFrom(optsArgs, "--build-id") || process.env.TESBO_BUILD_ID,
    runName: flagFrom(optsArgs, "--run-name") || process.env.TESBO_RUN_NAME,
    sourceType: flagFrom(optsArgs, "--source-type"),
    resultsPath: flagFrom(optsArgs, "--results-path") || ".",
    skipUpload: boolFrom(optsArgs, "--skip-upload"),
    command: cmdParts[0],
    commandArgs: cmdParts.slice(1),
  }).then((exitCode) => process.exit(exitCode));
}

// ── grid-run ─────────────────────────────────────────────────────────────────
else if (command === "grid-run") {
  const dashIdx = args.indexOf("--");
  if (dashIdx === -1 || dashIdx === args.length - 1) {
    console.error('Missing test command after `--`. Example: tesbox grid-run -- mvn test');
    process.exit(1);
  }
  const optsArgs = args.slice(1, dashIdx);
  const cmdParts = args.slice(dashIdx + 1);

  function flagFrom(list, name) {
    const i = list.indexOf(name);
    return i !== -1 && i + 1 < list.length ? list[i + 1] : undefined;
  }
  function boolFrom(list, name) {
    return list.includes(name);
  }

  const apiKey = flagFrom(optsArgs, "--api-key") || process.env.TESBOX_API_KEY;
  const apiUrl =
    flagFrom(optsArgs, "--api-url") || process.env.TESBOX_API_URL || "http://localhost:7100";
  const gridHost =
    flagFrom(optsArgs, "--grid-host") || process.env.TESBOX_GRID_HOST || "localhost:4444";
  const browser = (flagFrom(optsArgs, "--browser") || process.env.TESBOX_BROWSER || "").toLowerCase();
  if (browser && !["chrome", "firefox", "edge"].includes(browser)) {
    console.error('Invalid --browser. Use one of: chrome, firefox, edge.');
    process.exit(1);
  }

  gridRun({
    apiKey,
    apiUrl,
    gridHost,
    browser,
    resultsPath: flagFrom(optsArgs, "--results-path") || ".",
    runName: flagFrom(optsArgs, "--run-name") || process.env.TESBO_RUN_NAME,
    skipUpload: boolFrom(optsArgs, "--skip-upload"),
    command: cmdParts[0],
    commandArgs: cmdParts.slice(1),
  }).then((exitCode) => process.exit(exitCode));
}

// ── run / connect-tesbo / disconnect-tesbo (legacy "managed mode") ──────────
else {
  // Lazy-load the managed-mode runner. `run.js` pulls in heavy deps (glob,
  // bundling, etc.) that the new local-run commands do not need.
  const runMod = await import("../src/run.js").catch((err) => {
    console.error(
      `Failed to load managed-mode runner: ${err?.message || err}\n` +
        `If you only need local-run commands, use \`tesbox grid-run\` or \`tesbox upload-results\` instead.`
    );
    process.exit(1);
  });
  const positionalGlob = args[1] && !args[1].startsWith("--") ? args[1] : undefined;
  const globPattern = flag("--spec") || positionalGlob;
  if (command === "run" && !globPattern) {
    console.error('Missing glob pattern. Usage: tesbox run "tests/**/*.spec.ts"  or  tesbox run --spec "tests/**/*.spec.ts"');
    process.exit(1);
  }

  const language = (flag("--language") || process.env.TESBOX_LANGUAGE || "").toLowerCase();
  if (language && !["javascript", "typescript", "python", "java", "auto"].includes(language)) {
    console.error('Invalid --language. Use one of: javascript, python, java (or omit for auto-detection).');
    process.exit(1);
  }

  const framework = (flag("--framework") || process.env.TESBOX_FRAMEWORK || "").toLowerCase();
  if (framework && !["playwright", "selenium", "auto"].includes(framework)) {
    console.error('Invalid --framework. Use one of: playwright, selenium (or omit for auto-detection).');
    process.exit(1);
  }

  const browser = (flag("--browser") || process.env.TESBOX_BROWSER || "").toLowerCase();
  if (browser && !["chrome", "firefox", "edge"].includes(browser)) {
    console.error('Invalid --browser. Use one of: chrome, firefox, edge.');
    process.exit(1);
  }

  const options = {
    globPattern,
    language: language || "auto",
    framework: framework || "auto",
    browser,
    entrypoint: flag("--entrypoint") || process.env.TESBOX_ENTRYPOINT || "",
    runtimeCommand: flag("--command") || process.env.TESBOX_COMMAND || "",
    apiKey: flag("--api-key") || process.env.TESBOX_API_KEY,
    projectId: flag("--project-id") || process.env.TESBOX_PROJECT_ID || null,
    apiUrl: flag("--api-url") || process.env.TESBOX_API_URL || "http://localhost:7420",
    startUrl: flag("--start-url") || process.env.TESBOX_START_URL || "",
    envVars: resolveEnvVars(),
    pollInterval: parseInt(flag("--poll-interval") || "2000", 10),
    executionMode: flag("--execution-mode") || process.env.TESBOX_EXECUTION_MODE || "auto",
    waitForTesboMs: parseInt(flag("--wait-for-tesbo-ms") || "20000", 10),
    tesboApiUrl: flag("--tesbo-api-url") || process.env.TESBO_API_URL || "",
    tesboUiUrl: flag("--tesbo-ui-url") || process.env.TESBO_UI_URL || "",
    tesboAccessKey: flag("--tesbo-access-key") || process.env.TESBO_ACCESS_KEY || "",
    runName: flag("--run-name") || process.env.TESBO_RUN_NAME || "",
    timeoutMs: parseInt(flag("--timeout") || process.env.TESBOX_TIMEOUT_MS || "3600000", 10),
  };

  if (flag("--max-parallel") != null) {
    console.warn("Ignoring --max-parallel. TesboGrid now allocates concurrency server-side.");
  }

  if (!["auto", "script", "project"].includes(String(options.executionMode).toLowerCase())) {
    console.error('Invalid --execution-mode. Use one of: auto, script, project.');
    process.exit(1);
  }

  if (!options.apiKey) {
    console.error("API key required. Use --api-key or set TESBOX_API_KEY env variable.");
    process.exit(1);
  }

  if (command === "connect-tesbo") {
    runMod.connectTesbo(options).then((exitCode) => process.exit(exitCode));
  } else if (command === "disconnect-tesbo") {
    runMod.disconnectTesbo(options).then((exitCode) => process.exit(exitCode));
  } else {
    runMod.run(options).then((exitCode) => process.exit(exitCode));
  }
}
