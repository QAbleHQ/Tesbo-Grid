import fs from "node:fs/promises";
import path from "node:path";
import zlib from "node:zlib";
import { spawn } from "node:child_process";
import { config } from "./config.js";
import { normalizeRuntime } from "./runtimeContract.js";

export function safeJoin(root, rel) {
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
  return new Promise((resolve) => {
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
          try { child.kill("SIGKILL"); } catch {}
        }, 5000);
      }, timeoutMs);
      if (typeof timer.unref === "function") timer.unref();
    }

    child.stdout.on("data", (d) => { stdout += d.toString(); });
    child.stderr.on("data", (d) => { stderr += d.toString(); });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code: killed ? 124 : (code ?? 1), stdout, stderr, killed });
    });
  });
}

function runShellCommand(cwd, command, env, timeoutMs = 0) {
  return runCommand(cwd, "sh", ["-lc", command], env, timeoutMs);
}

export function parseJsonReporterOutput(stdout) {
  const start = stdout.indexOf("{");
  const end = stdout.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(stdout.slice(start, end + 1));
  } catch {
    return null;
  }
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

export function mapResultStatus(status) {
  const normalized = String(status || "").toLowerCase();
  if (normalized === "passed" || normalized === "expected") return "Passed";
  if (normalized === "failed" || normalized === "timedout" || normalized === "interrupted" || normalized === "unexpected") return "Failed";
  return "Skipped";
}

export function flattenStepDescriptions(steps, out = []) {
  if (!Array.isArray(steps)) return out;
  for (const step of steps) {
    const title = String(step?.title || "").trim();
    const category = String(step?.category || "").trim();
    if (title) {
      out.push({
        description: category && category !== "test.step" ? `${category}: ${title}` : title,
      });
    }
    flattenStepDescriptions(step?.steps, out);
    if (out.length >= 200) return out;
  }
  return out;
}

export function flattenTests(report) {
  const out = [];
  const reportProjectNames = Array.isArray(report?.config?.projects)
    ? report.config.projects.map((p) => String(p?.name || "").trim()).filter(Boolean)
    : [];
  function walkSuite(suite, inheritedFile = "") {
    const suiteFile = suite?.file || inheritedFile;
    for (const spec of suite?.specs || []) {
      for (const test of spec?.tests || []) {
        const results = Array.isArray(test?.results) ? test.results : [];
        const latest = results[results.length - 1] || {};
        const firstError = latest?.errors?.find?.((err) => err?.message)?.message
          || latest?.error?.message
          || null;
        const durationMs = Number.isFinite(latest?.duration)
          ? latest.duration
          : Number.isFinite(test?.duration)
            ? test.duration
            : null;
        out.push({
          spec: spec?.file || suiteFile || "unknown.spec.ts",
          name: test?.title || spec?.title || "Unnamed test",
          fullTitle: [suite?.title, spec?.title, test?.title].filter(Boolean).join(" > ") || null,
          status: mapResultStatus(latest?.status || test?.outcome || test?.status),
          durationMs,
          errorMessage: firstError,
          errorStack: latest?.error?.stack || null,
          attempt: Number.isFinite(latest?.retry) ? latest.retry : null,
          projectName: String(test?.projectName || reportProjectNames[0] || "").trim() || null,
          tags: Array.isArray(test?.tags) ? test.tags.map((tag) => String(tag)).filter(Boolean) : [],
          steps: flattenStepDescriptions(latest?.steps, []).slice(0, 100),
          attachments: Array.isArray(latest?.attachments) ? latest.attachments : [],
        });
      }
    }
    for (const child of suite?.suites || []) walkSuite(child, suiteFile);
  }
  for (const root of report?.suites || []) walkSuite(root, root?.file || "");
  return out;
}

// Playwright records compile/collection/config-load failures (the ones that
// produce zero per-test results) in the JSON report's top-level `errors`
// array, NOT inside any suite. flattenTests() only walks `suites`, so without
// reading these the real cause is lost and the run surfaces the generic
// "Playwright project run failed" fallback. Returns plain message strings.
export function extractReportErrors(report) {
  const errors = Array.isArray(report?.errors) ? report.errors : [];
  return errors
    .map((e) => {
      if (typeof e === "string") return e.trim();
      return String(e?.message || e?.value || "").trim();
    })
    .filter(Boolean);
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

async function collectArtifactsAndLogs(report, workspaceDir) {
  const tests = flattenTests(report);
  const logs = [];
  // Push top-level report errors first so they survive the logs.slice(0, 2000)
  // truncation below and show up prominently in the run logs.
  for (const message of extractReportErrors(report)) {
    logs.push({ level: "error", message, ts: new Date().toISOString() });
  }
  let videoPath = null;
  let screenshotPath = null;
  let tracePath = null;

  for (const item of tests) {
    logs.push({
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
    });
    if (item.errorMessage) {
      logs.push({ level: "error", message: item.errorMessage, ts: new Date().toISOString() });
    }
    for (const att of item.attachments || []) {
      const p = att?.path;
      if (!p) continue;
      const abs = path.isAbsolute(p) ? p : path.join(workspaceDir, p);
      const lowered = String(att.name || "").toLowerCase();
      const ext = path.extname(abs).toLowerCase();
      if (!tracePath && (lowered.includes("trace") || ext === ".zip")) tracePath = abs;
      if (!videoPath && (lowered.includes("video") || ext === ".webm" || ext === ".mp4")) videoPath = abs;
      if (!screenshotPath && (lowered.includes("screenshot") || ext === ".png" || ext === ".jpg" || ext === ".jpeg")) {
        screenshotPath = abs;
      }
    }
  }

  if (!videoPath || !screenshotPath || !tracePath) {
    const scanned = await scanArtifactFiles(path.join(workspaceDir, "artifacts"));
    videoPath ||= scanned.videoPath;
    screenshotPath ||= scanned.screenshotPath;
    tracePath ||= scanned.tracePath;
  }

  return { logs: logs.slice(0, 2000), videoPath, screenshotPath, tracePath };
}

export function parseJUnitTestcases(xml) {
  const out = [];
  const testCaseRegex = /<testcase\b([^>]*)>([\s\S]*?)<\/testcase>|<testcase\b([^>]*)\/>/g;
  let match;
  while ((match = testCaseRegex.exec(xml))) {
    const attrsRaw = match[1] || match[3] || "";
    const body = match[2] || "";
    const attrs = {};
    const attrRegex = /(\w+)="([^"]*)"/g;
    let attrMatch;
    while ((attrMatch = attrRegex.exec(attrsRaw))) {
      attrs[attrMatch[1]] = attrMatch[2];
    }
    const failureMatch = body.match(/<(failure|error)\b[^>]*>([\s\S]*?)<\/(failure|error)>/);
    const skippedMatch = body.match(/<skipped\b[^>]*>/);
    out.push({
      spec: attrs.classname || "unknown",
      name: attrs.name || "Unnamed test",
      durationMs: Number.isFinite(Number(attrs.time)) ? Math.round(Number(attrs.time) * 1000) : null,
      status: failureMatch ? "Failed" : skippedMatch ? "Skipped" : "Passed",
      errorMessage: failureMatch ? String(failureMatch[2] || "").trim().slice(0, 4000) : null,
      steps: [],
      tags: [],
      projectName: null,
      fullTitle: null,
      errorStack: null,
      attempt: null,
      attachments: [],
    });
  }
  return out;
}

async function parseJUnitReports(workspaceDir) {
  const candidates = [
    path.join(workspaceDir, "target", "surefire-reports"),
    path.join(workspaceDir, "build", "test-results", "test"),
    path.join(workspaceDir, "test-results"),
  ];
  const tests = [];
  for (const dir of candidates) {
    const files = await walkFiles(dir);
    for (const file of files) {
      if (!file.toLowerCase().endsWith(".xml")) continue;
      let xml = "";
      try {
        xml = await fs.readFile(file, "utf8");
      } catch {
        continue;
      }
      tests.push(...parseJUnitTestcases(xml));
    }
  }
  return tests;
}

async function collectJavaArtifactsAndLogs(workspaceDir) {
  const tests = await parseJUnitReports(workspaceDir);
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
    failedMessage: tests.find((t) => t.status === "Failed")?.errorMessage || null,
  };
}

export function buildRuntimeCommand(payload, runtime, entryFile, configFile) {
  if (runtime.language === "python") {
    const args = [
      "-m",
      "playwright",
      "test",
      "--reporter=json",
      "--workers=1",
      "--output",
      "artifacts/test-results",
    ];
    if (entryFile) args.push(entryFile);
    return { command: "python3", args };
  }

  if (runtime.language === "java") {
    if (runtime.command) {
      return { shellCommand: runtime.command };
    }
    const testTitle = extractTestTitleFromJobTitle(payload.title);
    const command = testTitle
      ? `mvn -B -Dtest="${testTitle.replace(/"/g, '\\"')}" test`
      : "mvn -B test";
    return { shellCommand: command };
  }

  const cliPath = "/app/node_modules/playwright/cli.js";
  const args = [
    cliPath,
    "test",
    "--reporter=json",
    "--workers=1",
    "--output",
    "artifacts/test-results",
  ];
  if (configFile) {
    args.push("--config", configFile);
  }
  const testTitle = extractTestTitleFromJobTitle(payload.title);
  if (testTitle) {
    args.push("--grep", escapeRegExpForGrep(testTitle));
  }
  args.push(entryFile);
  return { command: "node", args };
}

export function extractTestTitleFromJobTitle(jobTitle) {
  if (!jobTitle || typeof jobTitle !== "string") return null;
  const sep = jobTitle.indexOf(" :: ");
  if (sep < 0) return null;
  return jobTitle.slice(sep + 4).trim() || null;
}

export function escapeRegExpForGrep(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export async function runPlaywrightProjectWithRuntime(payload, forcedLanguage = null) {
  const executionId = String(payload.externalRef || payload.executionId || payload.jobId || `job-${Date.now()}`);
  const startedAt = Date.now();
  const workspaceDir = path.resolve(`/app/execution-projects/${executionId}-${Date.now()}`);
  const providerPayload = payload?.providerPayload || {};
  const normalized = normalizeRuntime(payload);
  const runtime = {
    ...normalized,
    language: forcedLanguage || normalized.language,
  };
  let currentUrl = "";

  try {
    await fs.mkdir(workspaceDir, { recursive: true });
    const unpacked = await unpackBundle(workspaceDir, providerPayload.projectBundleGzipBase64);
    const entryFile = runtime.entrypoint || unpacked.entryFile || providerPayload.entryFile || payload.title || "";
    const configFile = runtime.configFile || unpacked.configFile || providerPayload.configFile || "";
    if (!entryFile && runtime.language !== "java") {
      throw new Error("Project mode requires runtime.entrypoint or entryFile");
    }

    const childEnv = {
      ...process.env,
      CI: "1",
      TESBOX_START_URL: String(payload.startUrl || ""),
      BASE_URL: String(payload.startUrl || ""),
      PLAYWRIGHT_HEADLESS: String(config.headless ? "1" : "0"),
    };
    // Apply AUT environment vars forwarded by the CLI on the provider payload
    // (base URL, custom/secret vars). Applied last so they can set
    // framework-convention names like PLAYWRIGHT_BASE_URL that the bundled
    // config/test reads at runtime.
    const forwardedEnv = providerPayload.env && typeof providerPayload.env === "object" ? providerPayload.env : {};
    for (const [key, value] of Object.entries(forwardedEnv)) {
      if (key) childEnv[key] = String(value);
    }
    const projectTimeoutMs = Math.max(0, config.queueJobTimeoutMs - 30000);
    const runtimeCommand = buildRuntimeCommand(payload, runtime, entryFile, configFile);
    const result = runtimeCommand.shellCommand
      ? await runShellCommand(workspaceDir, runtimeCommand.shellCommand, childEnv, projectTimeoutMs)
      : await runCommand(workspaceDir, runtimeCommand.command, runtimeCommand.args, childEnv, projectTimeoutMs);
    if (result.killed) {
      return {
        status: "failed",
        currentUrl,
        logs: [{ level: "error", message: `Test exceeded ${Math.round(projectTimeoutMs / 1000)}s timeout and was killed`, ts: new Date().toISOString() }],
        screenshotPath: null,
        videoPath: null,
        tracePath: null,
        errorMessage: `Test exceeded ${Math.round(projectTimeoutMs / 1000)}s timeout and was killed`,
        durationMs: Date.now() - startedAt,
      };
    }
    const report = parseJsonReporterOutput(result.stdout);
    const extracted = runtime.language === "java"
      ? await collectJavaArtifactsAndLogs(workspaceDir)
      : await collectArtifactsAndLogs(report, workspaceDir);
    const persisted = await persistArtifacts(extracted, executionId);
    const errorMessage = result.code === 0
      ? null
      : extracted.failedMessage
        || extracted.logs.find((l) => l.level === "error")?.message
        || result.stderr.split("\n").filter(Boolean).slice(-1)[0]
        || "Playwright project run failed";
    return {
      status: result.code === 0 ? "passed" : "failed",
      currentUrl,
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
      currentUrl,
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

export async function runPlaywrightProject(payload) {
  return runPlaywrightProjectWithRuntime(payload, null);
}
