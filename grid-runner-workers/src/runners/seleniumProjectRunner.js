import fs from "node:fs/promises";
import path from "node:path";
import zlib from "node:zlib";
import { spawn } from "node:child_process";
import {
  parseTestNgXml,
  parseJUnitXml,
  parsePytestJson,
} from "@tesbox/playwright-runner/testReportParsers";
import { config } from "../config.js";
import { normalizeRuntime } from "../runtimeContract.js";

function safeJoin(root, rel) {
  const normalized = path.normalize(rel).replace(/^(\.\.(\/|\\|$))+/, "");
  const out = path.join(root, normalized);
  if (!out.startsWith(root)) throw new Error(`Unsafe file path in bundle: ${rel}`);
  return out;
}

async function unpackBundle(targetDir, bundleB64) {
  const gz = Buffer.from(String(bundleB64 || ""), "base64");
  const json = zlib.gunzipSync(gz).toString("utf8");
  const parsed = JSON.parse(json);
  const files = Array.isArray(parsed.files) ? parsed.files : [];
  for (const file of files) {
    if (!file?.path || !file?.contentBase64) continue;
    const abs = safeJoin(targetDir, file.path);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, Buffer.from(file.contentBase64, "base64"));
  }
  return {
    entryFile: String(parsed.entryFile || ""),
    configFile: parsed.configFile ? String(parsed.configFile) : "",
  };
}

function runCommand(cwd, command, args, env, timeoutMs = 0) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env });
    let stdout = "";
    let stderr = "";
    let killed = false;

    let timer = null;
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        killed = true;
        stderr += `\n[tesbox] Process killed: exceeded ${Math.round(timeoutMs / 1000)}s timeout\n`;
        child.kill("SIGTERM");
        setTimeout(() => {
          try {
            child.kill("SIGKILL");
          } catch {}
        }, 5000);
      }, timeoutMs);
      if (typeof timer.unref === "function") timer.unref();
    }

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code: killed ? 124 : (code ?? 1), stdout, stderr, killed });
    });
  });
}

function runShellCommand(cwd, command, env, timeoutMs = 0) {
  return runCommand(cwd, "sh", ["-lc", command], env, timeoutMs);
}

// Hit the Selenium Grid status endpoint before kicking off a Java/Python
// test. When the hub is unreachable or has no nodes registered, TestNG's
// @BeforeMethod fails and every test gets marked Skipped — which then looks
// like a silent "tests didn't run" to the user. Catching it here turns that
// into an explicit, actionable error message.
async function probeSeleniumHub(rawUrl, timeoutMs = 5000) {
  if (!rawUrl) return { ok: false, reason: "SELENIUM_REMOTE_URL is empty" };
  let statusUrl;
  try {
    const u = new URL(rawUrl);
    statusUrl = `${u.protocol}//${u.host}/status`;
  } catch {
    return { ok: false, reason: `Invalid SELENIUM_REMOTE_URL: ${rawUrl}` };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(statusUrl, { signal: controller.signal });
    if (!res.ok) {
      return { ok: false, reason: `Selenium Grid /status returned HTTP ${res.status} (${statusUrl})` };
    }
    const body = await res.json().catch(() => null);
    const ready = body?.value?.ready;
    if (ready === false) {
      const msg = body?.value?.message || "Grid reports ready=false";
      return { ok: false, reason: `Selenium Grid not ready: ${msg}` };
    }
    return { ok: true };
  } catch (err) {
    const message = err?.name === "AbortError"
      ? `Selenium Grid /status timed out after ${timeoutMs}ms (${statusUrl})`
      : `Selenium Grid /status unreachable: ${err?.message || err} (${statusUrl})`;
    return { ok: false, reason: message };
  } finally {
    clearTimeout(timer);
  }
}

// Maven dumps a lot of [INFO] noise and a useless `BUILD FAILURE` on the last
// stderr line. The actually-useful diagnostic is the first `[ERROR]` block in
// stdout. Pull that out so the dashboard shows the real cause.
function extractMavenError(stdout, stderr) {
  const haystacks = [String(stdout || ""), String(stderr || "")];
  for (const text of haystacks) {
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!/\[ERROR\]/i.test(line)) continue;
      const cleaned = line.replace(/^\[ERROR\]\s*/i, "").trim();
      // Skip the build-summary boilerplate ("BUILD FAILURE", "-> [Help 1]" etc.)
      if (/^(BUILD FAILURE|-+>|To see the full|For more information|Re-run Maven)/i.test(cleaned)) continue;
      if (!cleaned) continue;
      return cleaned.slice(0, 1000);
    }
  }
  return null;
}

async function walkFiles(dir) {
  let entries = [];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const out = [];
  for (const entry of entries) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await walkFiles(abs)));
      continue;
    }
    if (entry.isFile()) out.push(abs);
  }
  return out;
}

async function scanArtifactFiles(rootDir) {
  const files = await walkFiles(rootDir);
  let videoPath = null;
  let screenshotPath = null;
  let tracePath = null;

  for (const abs of files) {
    const lowered = path.basename(abs).toLowerCase();
    const ext = path.extname(abs).toLowerCase();
    if (!tracePath && (lowered.includes("trace") || ext === ".zip")) tracePath = abs;
    if (!videoPath && (lowered.includes("video") || ext === ".webm" || ext === ".mp4")) videoPath = abs;
    if (!screenshotPath && (lowered.includes("screenshot") || ext === ".png" || ext === ".jpg" || ext === ".jpeg")) {
      screenshotPath = abs;
    }
  }

  return { videoPath, screenshotPath, tracePath };
}

async function persistArtifact(localPath, targetDir, executionId, label) {
  if (!localPath) return null;
  try {
    await fs.access(localPath);
  } catch {
    return null;
  }

  await fs.mkdir(targetDir, { recursive: true });
  const ext = path.extname(localPath);
  const dest = path.join(targetDir, `${executionId}-${label}-${Date.now()}${ext}`);
  await fs.copyFile(localPath, dest);
  return dest;
}

async function persistArtifacts(result, executionId) {
  return {
    ...result,
    screenshotPath: await persistArtifact(result.screenshotPath, config.screenshotDir, executionId, "screenshot"),
    videoPath: await persistArtifact(result.videoPath, config.videoDir, executionId, "video"),
    tracePath: await persistArtifact(result.tracePath, config.traceDir, executionId, "trace"),
  };
}

async function readFirstFile(paths) {
  for (const filePath of paths) {
    try {
      return await fs.readFile(filePath, "utf8");
    } catch {}
  }
  return "";
}

async function collectJavaResults(workspaceDir) {
  const files = await walkFiles(workspaceDir);
  const testNgFiles = files.filter((file) => path.basename(file).toLowerCase() === "testng-results.xml");
  const junitFiles = files.filter((file) => file.toLowerCase().endsWith(".xml") && file.includes("surefire-reports"));
  const xml = await readFirstFile([...testNgFiles, ...junitFiles]);
  const tests = testNgFiles.length > 0 ? parseTestNgXml(xml) : parseJUnitXml(xml);
  const logs = tests.map((item) => ({
    kind: "test_case",
    spec: item.spec,
    name: item.name,
    fullTitle: item.fullTitle,
    status: item.status,
    durationMs: item.durationMs,
    errorMessage: item.errorMessage,
    errorStack: item.errorStack,
    attempt: item.attempt,
    projectName: item.projectName,
    tags: item.tags,
    steps: item.steps,
    ts: new Date().toISOString(),
  }));
  const scanned = await scanArtifactFiles(path.join(workspaceDir, "artifacts"));
  const failedTest = tests.find((test) => test.status === "Failed");
  const skippedTest = tests.find((test) => test.status === "Skipped");
  const totalTests = tests.length;
  const skippedCount = tests.filter((t) => t.status === "Skipped").length;
  return {
    logs: logs.slice(0, 2000),
    videoPath: scanned.videoPath,
    screenshotPath: scanned.screenshotPath,
    tracePath: scanned.tracePath,
    failedMessage: failedTest?.errorMessage || null,
    skippedMessage: skippedTest?.errorMessage || null,
    totalTests,
    skippedCount,
  };
}

async function collectPythonResults(workspaceDir) {
  const pytestJsonPath = path.join(workspaceDir, "report.json");
  const pytestJson = await readFirstFile([pytestJsonPath]);
  let tests = parsePytestJson(pytestJson);
  if (tests.length === 0) {
    const junitXml = await readFirstFile([
      path.join(workspaceDir, "test-results", "junit.xml"),
      path.join(workspaceDir, "junit.xml"),
    ]);
    tests = parseJUnitXml(junitXml);
  }

  const logs = tests.map((item) => ({
    kind: "test_case",
    spec: item.spec,
    name: item.name,
    fullTitle: item.fullTitle,
    status: item.status,
    durationMs: item.durationMs,
    errorMessage: item.errorMessage,
    errorStack: item.errorStack,
    attempt: item.attempt,
    projectName: item.projectName,
    tags: item.tags,
    steps: item.steps,
    ts: new Date().toISOString(),
  }));
  const scanned = await scanArtifactFiles(path.join(workspaceDir, "artifacts"));
  return {
    logs: logs.slice(0, 2000),
    videoPath: scanned.videoPath,
    screenshotPath: scanned.screenshotPath,
    tracePath: scanned.tracePath,
    failedMessage: tests.find((test) => test.status === "Failed")?.errorMessage || null,
  };
}

async function maybeInstallPythonDependencies(workspaceDir, env, timeoutMs) {
  const requirementFiles = [
    "requirements.txt",
    "requirements-dev.txt",
  ];
  for (const file of requirementFiles) {
    try {
      await fs.access(path.join(workspaceDir, file));
      return runCommand(workspaceDir, "python3", ["-m", "pip", "install", "-r", file], env, timeoutMs);
    } catch {}
  }

  for (const file of ["pyproject.toml", "setup.py"]) {
    try {
      await fs.access(path.join(workspaceDir, file));
      return runCommand(workspaceDir, "python3", ["-m", "pip", "install", "-e", "."], env, timeoutMs);
    } catch {}
  }

  return { code: 0, stdout: "", stderr: "", killed: false };
}

function buildJavaCommand(runtime) {
  if (runtime.command) return { shellCommand: runtime.command };
  const selector = runtime.testSelector || "";
  const escapedSelector = selector.replace(/"/g, '\\"');
  const command = selector
    ? `mvn -B -Dtest="${escapedSelector}" -DfailIfNoTests=false test`
    : "mvn -B test";
  return { shellCommand: command };
}

function buildPythonCommand(runtime) {
  if (runtime.command) return { shellCommand: runtime.command };
  const selector = runtime.testSelector || runtime.entrypoint;
  const args = [
    "-m",
    "pytest",
    selector,
    "--json-report",
    "--json-report-file=report.json",
    "--junitxml=test-results/junit.xml",
    "-p",
    "no:cacheprovider",
  ];
  return { command: "python3", args };
}

export async function runSeleniumProject(payload, forcedLanguage) {
  const executionId = String(payload.externalRef || payload.executionId || payload.jobId || `job-${Date.now()}`);
  const startedAt = Date.now();
  const workspaceDir = path.resolve(`/app/execution-projects/${executionId}-${Date.now()}`);
  const providerPayload = payload?.providerPayload || {};
  const normalized = normalizeRuntime(payload);
  const runtime = {
    ...normalized,
    framework: "selenium",
    language: forcedLanguage || normalized.language,
  };

  try {
    await fs.mkdir(workspaceDir, { recursive: true });
    const unpacked = await unpackBundle(workspaceDir, providerPayload.projectBundleGzipBase64);
    const entryFile = runtime.entrypoint || unpacked.entryFile || providerPayload.entryFile || "";
    if (!entryFile) {
      throw new Error("Selenium project mode requires runtime.entrypoint");
    }
    if (!runtime.testSelector) {
      throw new Error("Selenium project mode requires runtime.testSelector");
    }

    const seleniumRemoteUrl = String(config.seleniumGridUrl || process.env.SELENIUM_REMOTE_URL || "");
    const childEnv = {
      ...process.env,
      CI: "1",
      TESBOX_START_URL: String(payload.startUrl || ""),
      BASE_URL: String(payload.startUrl || ""),
      TESBOX_RUN_ID: String(payload.runId || ""),
      TESBOX_JOB_ID: String(payload.jobId || ""),
      SELENIUM_REMOTE_URL: seleniumRemoteUrl,
      SELENIUM_BROWSER: String(runtime.browser || config.seleniumDefaultBrowser || "chrome"),
      SELENIUM_BROWSER_VERSION: String(payload?.providerPayload?.browserVersion || ""),
      SELENIUM_PLATFORM: String(payload?.providerPayload?.platformName || ""),
    };
    const projectTimeoutMs = Math.max(30000, config.queueJobTimeoutMs - 30000);

    const probe = await probeSeleniumHub(seleniumRemoteUrl);
    if (!probe.ok) {
      return {
        status: "failed",
        currentUrl: "",
        logs: [{ level: "error", message: probe.reason, ts: new Date().toISOString() }],
        screenshotPath: null,
        videoPath: null,
        tracePath: null,
        errorMessage: probe.reason,
        durationMs: Date.now() - startedAt,
      };
    }

    if (runtime.language === "python") {
      const installResult = await maybeInstallPythonDependencies(workspaceDir, childEnv, Math.min(projectTimeoutMs, 300000));
      if (installResult.code !== 0) {
        return {
          status: "failed",
          currentUrl: "",
          logs: [{ level: "error", message: installResult.stderr || "Failed to install Python dependencies", ts: new Date().toISOString() }],
          screenshotPath: null,
          videoPath: null,
          tracePath: null,
          errorMessage: installResult.stderr || "Failed to install Python dependencies",
          durationMs: Date.now() - startedAt,
        };
      }
    }

    const runtimeCommand = runtime.language === "java"
      ? buildJavaCommand(runtime)
      : buildPythonCommand(runtime);
    const result = runtimeCommand.shellCommand
      ? await runShellCommand(workspaceDir, runtimeCommand.shellCommand, childEnv, projectTimeoutMs)
      : await runCommand(workspaceDir, runtimeCommand.command, runtimeCommand.args, childEnv, projectTimeoutMs);

    if (result.killed) {
      return {
        status: "failed",
        currentUrl: "",
        logs: [{ level: "error", message: `Test exceeded ${Math.round(projectTimeoutMs / 1000)}s timeout and was killed`, ts: new Date().toISOString() }],
        screenshotPath: null,
        videoPath: null,
        tracePath: null,
        errorMessage: `Test exceeded ${Math.round(projectTimeoutMs / 1000)}s timeout and was killed`,
        durationMs: Date.now() - startedAt,
      };
    }

    const extracted = runtime.language === "java"
      ? await collectJavaResults(workspaceDir)
      : await collectPythonResults(workspaceDir);
    const persisted = await persistArtifacts(extracted, executionId);

    // Treat "every test was skipped" as failure too — usually means
    // @BeforeMethod could not bring up a session (e.g., Selenium Grid
    // returned NoSuchSessionException because no node accepted the request).
    const allSkipped =
      extracted.totalTests > 0 && extracted.skippedCount === extracted.totalTests;
    const succeeded = result.code === 0 && !allSkipped;

    const mavenError = extractMavenError(result.stdout, result.stderr);
    const errorMessage = succeeded
      ? null
      : extracted.failedMessage
        || (allSkipped
          ? extracted.skippedMessage
            || `All ${extracted.totalTests} test${extracted.totalTests === 1 ? "" : "s"} were skipped — usually means the Selenium Grid couldn't allocate a browser session. Check that browser nodes are running and the run's BASE_URL/SELENIUM_REMOTE_URL are reachable.`
          : null)
        || mavenError
        || (result.code !== 0
          ? `Maven exited with code ${result.code}. No [ERROR] line was captured; check the worker logs for the full output.`
          : "Selenium project run failed");
    return {
      status: succeeded ? "passed" : "failed",
      currentUrl: "",
      logs: extracted.logs,
      screenshotPath: persisted.screenshotPath,
      videoPath: persisted.videoPath,
      tracePath: persisted.tracePath,
      errorMessage,
      durationMs: Date.now() - startedAt,
    };
  } catch (error) {
    return {
      status: "failed",
      currentUrl: "",
      logs: [{ level: "error", message: error instanceof Error ? error.message : String(error), ts: new Date().toISOString() }],
      screenshotPath: null,
      videoPath: null,
      tracePath: null,
      errorMessage: error instanceof Error ? error.message : String(error),
      durationMs: Date.now() - startedAt,
    };
  } finally {
    await fs.rm(workspaceDir, { recursive: true, force: true }).catch(() => {});
  }
}
