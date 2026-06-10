import { glob } from "glob";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

export async function run(options) {
  const {
    globPattern,
    language: requestedLanguage,
    framework: requestedFramework,
    browser: requestedBrowser,
    entrypoint,
    runtimeCommand,
    apiKey,
    projectId,
    apiUrl,
    startUrl,
    envVars = {},
    pollInterval,
    waitForTesboMs,
    tesboApiUrl,
    tesboUiUrl,
    tesboAccessKey,
    runName,
    executionMode,
    timeoutMs = 3600000,
  } = options;

  const cliStartedAt = Date.now();

  log(`\n  Scanning  \x1b[2m${globPattern}\x1b[0m`);
  const files = await glob(globPattern, { cwd: process.cwd(), absolute: false });

  if (files.length === 0) {
    logError(`  No files matched "${globPattern}"`);
    return 1;
  }

  // If the user did not pass --language / --framework / --browser, try to use
  // the values that were locked in when the project was created. This keeps
  // CLI invocations short ("tesbox run …") while still respecting the
  // project's canonical stack. The project's settings always take precedence
  // over the file-extension auto-detect.
  let projectStackDefaults = null;
  if (
    (!requestedLanguage || requestedLanguage === "auto") ||
    (!requestedFramework || requestedFramework === "auto") ||
    !requestedBrowser
  ) {
    projectStackDefaults = await fetchProjectStack({ apiUrl, apiKey }).catch(
      () => null
    );
  }
  const effectiveRequestedLanguage =
    requestedLanguage && requestedLanguage !== "auto"
      ? requestedLanguage
      : projectStackDefaults?.language || requestedLanguage || "auto";
  const effectiveRequestedFramework =
    requestedFramework && requestedFramework !== "auto"
      ? requestedFramework
      : projectStackDefaults?.framework || requestedFramework || "auto";
  const effectiveRequestedBrowser =
    requestedBrowser || projectStackDefaults?.defaultBrowser || "";

  const resolvedLanguage = resolveLanguage(effectiveRequestedLanguage, files);
  const resolvedFramework = resolveFramework(effectiveRequestedFramework, resolvedLanguage);
  const resolvedBrowser = resolveBrowser(effectiveRequestedBrowser);

  let jobs;
  if (resolvedLanguage === "python") {
    jobs = buildPythonJobs(files, {
      startUrl,
      entrypoint,
      runtimeCommand,
      framework: resolvedFramework,
      browser: resolvedBrowser,
      envVars,
    });
  } else if (resolvedLanguage === "java") {
    jobs = buildJavaJobs(files, {
      startUrl,
      runtimeCommand,
      framework: resolvedFramework,
      browser: resolvedBrowser,
      envVars,
    });
  } else {
    jobs = buildJavascriptJobs(files, {
      executionMode,
      startUrl,
      framework: resolvedFramework,
      browser: resolvedBrowser,
      envVars,
    });
  }

  if (jobs.error) {
    console.error(jobs.error);
    return 1;
  }
  if (jobs.list.length === 0) {
    console.error("  No runnable tests found in matched files.");
    return 1;
  }

  const jobList = jobs.list;

  // Build a per-spec total count so we can show "X of N failed" live.
  const specTotals = new Map();
  for (const job of jobList) {
    const sn = extractSpecName(job.title);
    specTotals.set(sn, (specTotals.get(sn) || 0) + 1);
  }

  log(`  \x1b[32m✓\x1b[0m ${files.length} spec file${files.length === 1 ? "" : "s"}  ·  ${jobList.length} test${jobList.length === 1 ? "" : "s"}  ·  \x1b[2m${resolvedFramework}/${resolvedLanguage}\x1b[0m\n`);

  // 3. Start run submission, then continue appending while polling live status.
  log(`  Submitting  \x1b[2m${apiUrl}\x1b[0m`);
  const externalRef = `cli-${Date.now()}`;
  let runData;
  let runId = null;
  const submissionState = {
    submitted: 0,
    total: jobList.length,
    done: false,
    error: null,
  };
  let submissionTask = null;
  try {
    const firstChunkSize = 1;
    const firstChunk = jobList.slice(0, firstChunkSize);
    runData = await createRunWithRetry({
      apiUrl,
      apiKey,
      jobs: firstChunk,
      projectId,
      externalRef,
      tesboApiUrl,
      tesboUiUrl,
      tesboAccessKey,
      runName,
    });
    runId = runData?.runId;
    submissionState.submitted = firstChunk.length;

    const parallelNote = runData.maxParallel ? `  ·  up to ${runData.maxParallel} parallel` : "";
    log(`  \x1b[32m✓\x1b[0m ${runId}  ·  ${jobList.length} job${jobList.length === 1 ? "" : "s"}${parallelNote}\n`);

    const remainingJobs = jobList.slice(firstChunk.length);
    submissionTask = submitRemainingRunChunks({
      apiUrl,
      apiKey,
      runId,
      jobs: remainingJobs,
      submissionState,
    });
  } catch (err) {
    logError(`  Failed to submit run: ${err.message}`);
    return 1;
  }

  // 4. Poll for completion
  let finalStatus;
  let lastPrinted = "";
  let announcedStart = false;
  let lastHeartbeatAt = 0;
  let lastSample = null;
  const ASSUMED_JOB_SECONDS = 30;

  // Live per-test streaming state
  const printedJobKeys = new Set();
  const specCompleted = new Map(); // specName → { passed, failed }
  let lastCompletedCount = -1;
  let liveHeaderPrinted = false;

  while (true) {
    if (submissionState.error) {
      logError(`  Submission error: ${submissionState.error}`);
      try {
        await apiPost(`${apiUrl}/api/runs/${runId}/cancel`, {}, apiKey);
      } catch {
        // Best effort cancellation only.
      }
      return 1;
    }

    await sleep(pollInterval);

    let status;
    try {
      status = await apiGet(`${apiUrl}/api/runs/${runId}`, apiKey);
    } catch (err) {
      logError(`  Poll error: ${err.message}`);
      continue;
    }

    let queueStats = null;
    try {
      queueStats = await apiGet(`${apiUrl}/api/queue/stats`, apiKey);
    } catch {
      // Queue stats are optional for CLI status output.
    }

    const queued = asNumber(status.queuedJobs);
    const total = asNumber(status.totalJobs);
    const completed = asNumber(status.completedJobs);
    const passed = asNumber(status.passedJobs);
    const failed = asNumber(status.failedJobs);
    const totalTestCases = asNumber(status.totalTestCases || total);
    const queuedTestCases = asNumber(status.queuedTestCases || queued);
    const runningTestCases = Math.max(
      0,
      asNumber(status.runningTestCases || (totalTestCases - queuedTestCases - asNumber(status.completedTestCases)))
    );
    const running = Math.max(0, total - queued - completed);
    const progressPct = total > 0 ? Math.floor((completed / total) * 100) : 0;
    const now = Date.now();

    let progressRatePerMin = null;
    if (lastSample) {
      const dtMin = (now - lastSample.at) / 60000;
      const dCompleted = completed - lastSample.completed;
      if (dtMin > 0 && dCompleted > 0) {
        progressRatePerMin = dCompleted / dtMin;
      } else if (lastSample.progressRatePerMin) {
        progressRatePerMin = lastSample.progressRatePerMin;
      }
    }
    lastSample = { at: now, completed, progressRatePerMin };

    let line;
    if (queued === total && completed === 0) {
      const globalQueued = asNumber(queueStats?.queued_jobs);
      const globalRunning = asNumber(queueStats?.running_jobs || queueStats?.active);
      const globalQueuedTestCases = asNumber(queueStats?.queued_test_cases || queueStats?.queuedTestCases || globalQueued);
      const globalRunningTestCases = asNumber(queueStats?.running_test_cases || queueStats?.runningTestCases || globalRunning);
      const jobsAhead = queueStats
        ? Math.max(0, globalQueuedTestCases + globalRunningTestCases - totalTestCases)
        : null;
      const workerThroughput = Math.max(
        1,
        globalRunningTestCases || asNumber(queueStats?.active_test_cases) || asNumber(status.maxParallel) || totalTestCases
      );
      const etaToStartSec = jobsAhead != null ? Math.ceil((jobsAhead / workerThroughput) * ASSUMED_JOB_SECONDS) : null;
      const aheadNote = jobsAhead ? `  ·  \x1b[2m${jobsAhead} ahead\x1b[0m` : "";
      const etaNote = etaToStartSec ? `  ·  \x1b[2mest. ${formatEta(etaToStartSec)}\x1b[0m` : "";
      const reasonNote = status.schedulerReason ? `  ·  \x1b[2m${status.schedulerReason}\x1b[0m` : "";
      line = `  \x1b[33m◌\x1b[0m  Waiting for worker${aheadNote}${etaNote}${reasonNote}`;
    } else {
      if (!announcedStart) {
        log(`\n  Running  \x1b[2m${"─".repeat(50)}\x1b[0m\n`);
        log(`  \x1b[2m${"".padEnd(2)}  ${"Test".padEnd(48)}  ${"Node".padEnd(12)}  Duration\x1b[0m`);
        log(`  \x1b[2m${"─".repeat(2)}  ${"─".repeat(48)}  ${"─".repeat(12)}  ${"─".repeat(8)}\x1b[0m`);
        liveHeaderPrinted = true;
        announcedStart = true;
      }

      // Stream newly completed jobs as they finish
      if (completed !== lastCompletedCount) {
        lastCompletedCount = completed;
        try {
          const jobsData = await apiGet(`${apiUrl}/api/runs/${runId}/jobs`, apiKey);
          const allJobs = jobsData.jobs || [];

          for (const job of allJobs) {
            const jobKey = job.id || job.jobId || job.externalRef || job.title;
            if (printedJobKeys.has(jobKey)) continue;
            if (job.status === "passed" || job.status === "failed" || job.status === "cancelled") {
              printedJobKeys.add(jobKey);
              // Update running spec-level pass/fail counts
              const sn = extractSpecName(job.title);
              if (!specCompleted.has(sn)) specCompleted.set(sn, { passed: 0, failed: 0 });
              const sc = specCompleted.get(sn);
              if (job.status === "passed") sc.passed++;
              else if (job.status === "failed") sc.failed++;
              printLiveJobResult(job, sc, specTotals.get(sn) || 1);
            }
          }
        } catch {
          // Silently skip — final summary will still show all results.
        }
      }

      const remaining = Math.max(0, total - completed);
      const etaFinishSec = progressRatePerMin && progressRatePerMin > 0
        ? Math.ceil((remaining / progressRatePerMin) * 60)
        : null;
      const passedStr = passed > 0 ? `  \x1b[32m${passed} passed\x1b[0m` : `  ${passed} passed`;
      const failedStr = failed > 0 ? `  \x1b[31m${failed} failed\x1b[0m` : "";
      const etaStr = etaFinishSec ? `  \x1b[2m·  ${formatEta(etaFinishSec)}\x1b[0m` : "";
      line = `\n  \x1b[2m●\x1b[0m  ${completed}/${total}${passedStr}${failedStr}  \x1b[2m·  ${running} running  ·  ${queued} queued\x1b[0m${etaStr}`;
    }

    if (line !== lastPrinted || now - lastHeartbeatAt >= 30000) {
      log(line);
      lastPrinted = line;
      lastHeartbeatAt = now;
    }

    if (
      submissionState.done &&
      (status.status === "completed" || status.status === "failed" || status.status === "cancelled")
    ) {
      finalStatus = status;
      break;
    }

    if (timeoutMs > 0 && Date.now() - cliStartedAt > timeoutMs) {
      logError(`\n  Timed out after ${formatDurationMs(timeoutMs)}`);
      try {
        await apiPost(`${apiUrl}/api/runs/${runId}/cancel`, {}, apiKey);
      } catch {}
      finalStatus = status;
      finalStatus.status = "timeout";
      break;
    }
  }
  if (submissionTask) {
    await submissionTask;
  }

  // 5. Fetch per-job results
  let jobResults = [];
  try {
    const jobsData = await apiGet(`${apiUrl}/api/runs/${runId}/jobs`, apiKey);
    jobResults = jobsData.jobs || [];
  } catch {
    // Final summary will fall back to aggregate counts.
  }

  // 6. Print summary table
  const totalWallClockMs = Date.now() - cliStartedAt;
  printSummary(finalStatus, jobResults, totalWallClockMs);

  // 7. Wait briefly for background Tesbo ingestion and print run URL.
  let runAfterIngestion = finalStatus;
  const canTrackTesbo = Boolean(finalStatus.tesboIngestionStatus || tesboApiUrl || tesboAccessKey);
  if (canTrackTesbo) {
    runAfterIngestion = await waitForTesboRunLink({
      apiUrl,
      apiKey,
      runId: finalStatus.runId,
      pollInterval,
      timeoutMs: waitForTesboMs,
      initial: finalStatus,
    });
    printTesboResultLink(runAfterIngestion);
  }

  return finalStatus.failedJobs > 0 || finalStatus.status === "failed" || finalStatus.status === "timeout" ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Language resolution
// ---------------------------------------------------------------------------

function resolveLanguage(requested, files) {
  if (requested && requested !== "auto") {
    if (requested === "typescript") return "javascript";
    return requested;
  }
  const sample = files[0] || "";
  if (sample.endsWith(".py")) return "python";
  if (sample.endsWith(".java")) return "java";
  return "javascript";
}

function resolveFramework(requested, language) {
  if (requested && requested !== "auto") return requested;
  if (language === "python") {
    if (projectFileContains("requirements.txt", /\bselenium([<>=~! ]|$)/i)) return "selenium";
    if (projectFileContains("pyproject.toml", /\bselenium\b/i)) return "selenium";
    return "playwright";
  }
  if (language === "java") {
    if (projectFileContains("pom.xml", /selenium/i)) return "selenium";
    if (projectFileContains("build.gradle", /selenium/i)) return "selenium";
    if (projectFileContains("build.gradle.kts", /selenium/i)) return "selenium";
    return "playwright";
  }
  return "playwright";
}

function resolveBrowser(requested) {
  const value = String(requested || "").trim().toLowerCase();
  if (!value) return "chrome";
  if (["chrome", "firefox", "edge"].includes(value)) return value;
  throw new Error(`Unsupported browser "${requested}". Use chrome, firefox, or edge.`);
}

function projectFileContains(fileName, pattern) {
  try {
    const abs = path.resolve(process.cwd(), fileName);
    if (!fs.existsSync(abs)) return false;
    return pattern.test(fs.readFileSync(abs, "utf8"));
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// JavaScript / Playwright job builder (existing logic)
// ---------------------------------------------------------------------------

function buildJavascriptJobs(files, { executionMode, startUrl, framework, browser, envVars }) {
  if (framework === "selenium") {
    return { list: [], error: "  Selenium CLI support currently targets Java and Python projects only." };
  }
  const jobs = [];
  const invalidSpecs = [];

  for (const filePath of files) {
    const absolutePath = path.resolve(process.cwd(), filePath);
    const script = fs.readFileSync(absolutePath, "utf-8");
    const useProjectMode = shouldUseProjectMode({ executionMode, script, filePath });
    const testEntries = extractPlaywrightTests(script);
    if (testEntries.length === 0) {
      invalidSpecs.push({ filePath, reason: "no Playwright test() blocks detected" });
      continue;
    }

    if (useProjectMode) {
      let providerPayloadBase;
      try {
        providerPayloadBase = buildProjectProviderPayload(filePath, "javascript", envVars);
      } catch (err) {
        return { list: [], error: `\n  Error bundling project: ${err.message}\n  Tip: make sure your project doesn't contain large or unnecessary files.\n  Ignored dirs: node_modules, .git, dist, build, coverage, test-results, ...` };
      }
      for (let i = 0; i < testEntries.length; i++) {
        const entry = testEntries[i];
        const testLabel = entry.title || `test-${i + 1}`;
        jobs.push({
          title: `${filePath} :: ${testLabel}`,
          script: scriptFromSingleTest(entry.code),
          runtime: {
            framework: framework || "playwright",
            browser: browser || "chrome",
          },
          testCaseCount: 1,
          startUrl: startUrl || undefined,
          providerPayload: providerPayloadBase,
        });
      }
      continue;
    }

    for (let i = 0; i < testEntries.length; i++) {
      const entry = testEntries[i];
      const testLabel = entry.title || `test-${i + 1}`;
      jobs.push({
        title: `${filePath} :: ${testLabel}`,
        script: scriptFromSingleTest(entry.code),
        runtime: {
          framework: framework || "playwright",
          browser: browser || "chrome",
        },
        testCaseCount: 1,
        startUrl: startUrl || undefined,
      });
    }
  }

  if (invalidSpecs.length > 0) {
    const lines = ["  Could not extract runnable Playwright tests from some spec files:"];
    for (const item of invalidSpecs.slice(0, 20)) {
      lines.push(`    ${item.filePath} (${item.reason})`);
    }
    if (invalidSpecs.length > 20) {
      lines.push(`    ... and ${invalidSpecs.length - 20} more`);
    }
    return { list: [], error: lines.join("\n") };
  }
  return { list: jobs };
}

// ---------------------------------------------------------------------------
// Python job builder
// ---------------------------------------------------------------------------

function buildPythonJobs(files, { startUrl, entrypoint, runtimeCommand, framework, browser, envVars }) {
  const jobs = [];
  const invalidSpecs = [];

  let providerPayloadBase;
  try {
    providerPayloadBase = buildProjectProviderPayload(files[0], "python", envVars);
  } catch (err) {
    return { list: [], error: `\n  Error bundling project: ${err.message}\n  Tip: make sure your project doesn't contain large or unnecessary files.\n  Ignored dirs: __pycache__, .venv, .tox, .pytest_cache, ...` };
  }

  for (const filePath of files) {
    const absolutePath = path.resolve(process.cwd(), filePath);
    const script = fs.readFileSync(absolutePath, "utf-8");
    const testEntries = extractPythonTests(script);
    if (testEntries.length === 0) {
      invalidSpecs.push({ filePath, reason: "no test functions detected (def test_* or async def test_*)" });
      continue;
    }

    for (let i = 0; i < testEntries.length; i++) {
      const entry = testEntries[i];
      const testLabel = entry.title || `test_${i + 1}`;
      jobs.push({
        title: `${filePath} :: ${testLabel}`,
        language: "python",
        runtime: {
          framework: framework || "playwright",
          language: "python",
          executionMode: "project",
          entrypoint: entrypoint || filePath,
          command: runtimeCommand || "",
          browser: browser || "chrome",
          testSelector: framework === "selenium"
            ? `${filePath}::${entry.title}`
            : "",
        },
        testCaseCount: 1,
        startUrl: startUrl || undefined,
        providerPayload: providerPayloadBase,
      });
    }
  }

  if (invalidSpecs.length > 0 && jobs.length === 0) {
    const lines = ["  Could not extract runnable Python tests from some files:"];
    for (const item of invalidSpecs.slice(0, 20)) {
      lines.push(`    ${item.filePath} (${item.reason})`);
    }
    return { list: [], error: lines.join("\n") };
  }
  if (invalidSpecs.length > 0) {
    console.warn("  Skipped files with no test functions:");
    for (const item of invalidSpecs.slice(0, 10)) {
      console.warn(`    ${item.filePath}`);
    }
  }
  return { list: jobs };
}

function extractPythonTests(script) {
  const source = String(script || "");
  const out = [];
  const pattern = /^[ \t]*(async\s+)?def\s+(test_\w+)\s*\(/gm;
  let match;
  while ((match = pattern.exec(source)) !== null) {
    out.push({ title: match[2] });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Java job builder
// ---------------------------------------------------------------------------

function buildJavaJobs(files, { startUrl, runtimeCommand, framework, browser, envVars }) {
  const jobs = [];
  const invalidSpecs = [];

  let providerPayloadBase;
  try {
    providerPayloadBase = buildProjectProviderPayload(files[0], "java", envVars);
  } catch (err) {
    return { list: [], error: `\n  Error bundling project: ${err.message}\n  Tip: make sure your project doesn't contain large or unnecessary files.\n  Ignored dirs: target, .gradle, .mvn, build, ...` };
  }

  for (const filePath of files) {
    const absolutePath = path.resolve(process.cwd(), filePath);
    const script = fs.readFileSync(absolutePath, "utf-8");
    const testEntries = extractJavaTests(script);
    const className = extractJavaClassName(filePath, script);
    if (testEntries.length === 0) {
      invalidSpecs.push({ filePath, reason: "no @Test annotated methods detected" });
      continue;
    }

    for (let i = 0; i < testEntries.length; i++) {
      const entry = testEntries[i];
      const testLabel = entry.title || `test${i + 1}`;
      jobs.push({
        title: `${filePath} :: ${testLabel}`,
        language: "java",
        runtime: {
          framework: framework || "playwright",
          language: "java",
          executionMode: "project",
          entrypoint: filePath,
          command: runtimeCommand || "",
          browser: browser || "chrome",
          testSelector: framework === "selenium"
            ? `${className}#${entry.title}`
            : "",
        },
        testCaseCount: 1,
        startUrl: startUrl || undefined,
        providerPayload: providerPayloadBase,
      });
    }
  }

  if (invalidSpecs.length > 0 && jobs.length === 0) {
    const lines = ["  Could not extract runnable Java tests from some files:"];
    for (const item of invalidSpecs.slice(0, 20)) {
      lines.push(`    ${item.filePath} (${item.reason})`);
    }
    return { list: [], error: lines.join("\n") };
  }
  if (invalidSpecs.length > 0) {
    console.warn("  Skipped files with no @Test methods:");
    for (const item of invalidSpecs.slice(0, 10)) {
      console.warn(`    ${item.filePath}`);
    }
  }
  return { list: jobs };
}

function extractJavaTests(script) {
  const source = String(script || "");
  const out = [];
  const pattern = /@Test\b[^]*?(?:public|protected|private)?\s+(?:static\s+)?void\s+(\w+)\s*\(/g;
  let match;
  while ((match = pattern.exec(source)) !== null) {
    out.push({ title: match[1] });
  }
  if (out.length > 0) return out;

  // Fallback: find @Test immediately followed by method signature on the next line
  const lines = source.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (/@Test\b/.test(lines[i])) {
      for (let j = i; j < Math.min(i + 5, lines.length); j++) {
        const methodMatch = lines[j].match(/(?:public|protected|private)?\s*(?:static\s+)?void\s+(\w+)\s*\(/);
        if (methodMatch) {
          out.push({ title: methodMatch[1] });
          break;
        }
      }
    }
  }
  return out;
}

function extractJavaClassName(filePath, script) {
  const packageMatch = String(script || "").match(/\bpackage\s+([a-zA-Z0-9_.]+)\s*;/);
  const packageName = packageMatch?.[1] || "";
  const baseName = path.basename(filePath, path.extname(filePath));
  return packageName ? `${packageName}.${baseName}` : baseName;
}

// ---------------------------------------------------------------------------
// JavaScript helpers (unchanged)
// ---------------------------------------------------------------------------

function scriptFromSingleTest(testCallSource) {
  return `import { test, expect } from "@playwright/test";\n\n${testCallSource}\n`;
}

function extractPlaywrightTests(script) {
  const source = String(script || "");
  const out = [];
  const pattern = /\btest(?:\.(?:only|skip|fixme|fail))?\s*\(/g;
  let match;
  while ((match = pattern.exec(source)) !== null) {
    const start = match.index;
    const end = findCallEndIndex(source, start);
    if (end < 0) continue;
    const code = source.slice(start, end + 1).trim();
    out.push({
      code,
      title: extractTestTitle(code),
    });
    pattern.lastIndex = end + 1;
  }
  return out;
}

function extractTestTitle(testCallSource) {
  const source = String(testCallSource || "");
  const openParen = source.indexOf("(");
  if (openParen < 0) return null;
  let i = openParen + 1;
  while (i < source.length && /\s/.test(source[i])) i += 1;
  const quote = source[i];
  if (quote !== "'" && quote !== '"' && quote !== "`") return null;
  i += 1;
  let escaped = false;
  let title = "";
  while (i < source.length) {
    const ch = source[i];
    if (escaped) {
      title += ch;
      escaped = false;
      i += 1;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      i += 1;
      continue;
    }
    if (ch === quote) break;
    title += ch;
    i += 1;
  }
  const trimmed = title.trim();
  return trimmed || null;
}

function findCallEndIndex(source, startIndex) {
  let depthParen = 0;
  let depthBrace = 0;
  let depthBracket = 0;
  let inSingle = false;
  let inDouble = false;
  let inTemplate = false;
  let escaped = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let i = startIndex; i < source.length; i += 1) {
    const ch = source[i];
    const next = source[i + 1];

    if (inLineComment) {
      if (ch === "\n") inLineComment = false;
      continue;
    }
    if (inBlockComment) {
      if (ch === "*" && next === "/") {
        inBlockComment = false;
        i += 1;
      }
      continue;
    }

    if (escaped) {
      escaped = false;
      continue;
    }
    if (inSingle) {
      if (ch === "\\") escaped = true;
      else if (ch === "'") inSingle = false;
      continue;
    }
    if (inDouble) {
      if (ch === "\\") escaped = true;
      else if (ch === '"') inDouble = false;
      continue;
    }
    if (inTemplate) {
      if (ch === "\\") escaped = true;
      else if (ch === "`") inTemplate = false;
      continue;
    }

    if (ch === "/" && next === "/") {
      inLineComment = true;
      i += 1;
      continue;
    }
    if (ch === "/" && next === "*") {
      inBlockComment = true;
      i += 1;
      continue;
    }
    if (ch === "'") {
      inSingle = true;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      continue;
    }
    if (ch === "`") {
      inTemplate = true;
      continue;
    }

    if (ch === "(") depthParen += 1;
    else if (ch === ")") {
      depthParen -= 1;
      if (depthParen === 0 && depthBrace === 0 && depthBracket === 0) {
        return i;
      }
    } else if (ch === "{") depthBrace += 1;
    else if (ch === "}") depthBrace = Math.max(0, depthBrace - 1);
    else if (ch === "[") depthBracket += 1;
    else if (ch === "]") depthBracket = Math.max(0, depthBracket - 1);
  }

  return -1;
}

function shouldUseProjectMode({ executionMode, script, filePath }) {
  const mode = String(executionMode || "auto").toLowerCase();
  if (mode === "project") return true;
  if (mode === "script") return false;

  const hasRelativeImport = /\bfrom\s+["'](\.{1,2}\/|\/)/.test(script)
    || /\brequire\(\s*["'](\.{1,2}\/|\/)/.test(script)
    || /\bimport\(\s*["'](\.{1,2}\/|\/)/.test(script);
  if (hasRelativeImport) return true;

  if (filePath.includes("generated")) return false;
  return false;
}

// ---------------------------------------------------------------------------
// Config detection per language
// ---------------------------------------------------------------------------

function detectConfigFile(projectRoot, language) {
  if (language === "python") {
    const candidates = ["pytest.ini", "pyproject.toml", "setup.cfg", "conftest.py"];
    for (const file of candidates) {
      if (fs.existsSync(path.join(projectRoot, file))) return file;
    }
    return null;
  }
  if (language === "java") {
    const candidates = ["pom.xml", "build.gradle", "build.gradle.kts"];
    for (const file of candidates) {
      if (fs.existsSync(path.join(projectRoot, file))) return file;
    }
    return null;
  }
  // javascript/typescript — Playwright config
  const candidates = [
    "playwright.config.ts",
    "playwright.config.js",
    "playwright.config.mjs",
    "playwright.config.cjs",
  ];
  for (const file of candidates) {
    if (fs.existsSync(path.join(projectRoot, file))) return file;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Project bundling (shared across all languages)
// ---------------------------------------------------------------------------

const IGNORED_DIRS = new Set([
  // General
  ".git", "artifacts", "test-results", "coverage", "tmp", ".tmp",
  ".idea", ".vscode", ".cursor", ".DS_Store", ".svn", ".hg",
  // JavaScript
  "node_modules", "playwright-report", "dist", "build",
  ".next", ".nuxt", ".output", ".cache", ".parcel-cache", "bower_components",
  // Python
  "__pycache__", ".tox", ".mypy_cache", ".venv", "venv", ".pytest_cache",
  ".eggs", "htmlcov",
  // Java
  "target", ".gradle", ".mvn", "bin", "out",
]);

const BINARY_EXTS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".ico", ".webp", ".avif", ".svg",
  ".mp4", ".webm", ".avi", ".mov", ".mkv", ".mp3", ".wav", ".ogg", ".flac",
  ".woff", ".woff2", ".ttf", ".otf", ".eot",
  ".zip", ".tar", ".gz", ".bz2", ".7z", ".rar",
  ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx",
  ".exe", ".dll", ".so", ".dylib", ".bin", ".o", ".a",
  ".pyc", ".class", ".jar", ".wasm",
]);

const MAX_FILE_SIZE = 2 * 1024 * 1024;       // 2 MB per file
const MAX_BUNDLE_SIZE = 200 * 1024 * 1024;    // 200 MB total (raw, before gzip)

function buildProjectProviderPayload(entryFile, language = "javascript", envVars = {}) {
  const projectRoot = process.cwd();
  const configFile = detectConfigFile(projectRoot, language);
  const all = fs.readdirSync(projectRoot);
  const files = [];
  let totalSize = 0;

  function addFile(abs, rel) {
    const ext = path.extname(rel).toLowerCase();
    if (BINARY_EXTS.has(ext)) return;
    const stat = fs.statSync(abs);
    if (!stat.isFile() || stat.size > MAX_FILE_SIZE) return;
    if (totalSize + stat.size > MAX_BUNDLE_SIZE) {
      const mbUsed = (totalSize / (1024 * 1024)).toFixed(1);
      throw new RangeError(
        `Project bundle exceeds ${MAX_BUNDLE_SIZE / (1024 * 1024)} MB limit ` +
        `(${mbUsed} MB so far, ${files.length} files). ` +
        `Add a .tesboxignore file or reduce the project size.`
      );
    }
    const content = fs.readFileSync(abs);
    totalSize += content.length;
    files.push({ path: rel, contentBase64: content.toString("base64") });
  }

  function walk(dir) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const ent of entries) {
      if (IGNORED_DIRS.has(ent.name)) continue;
      if (ent.name.endsWith(".egg-info")) continue;
      const abs = path.join(dir, ent.name);
      const rel = path.relative(projectRoot, abs);
      if (!rel) continue;
      if (ent.isDirectory()) {
        walk(abs);
        continue;
      }
      addFile(abs, rel);
    }
  }

  for (const name of all) {
    if (IGNORED_DIRS.has(name)) continue;
    if (name.endsWith(".egg-info")) continue;
    const abs = path.join(projectRoot, name);
    const stat = fs.statSync(abs);
    if (stat.isDirectory()) walk(abs);
    else if (stat.isFile()) addFile(abs, name);
  }

  const payload = {
    executionMode: "project",
    entryFile,
    configFile,
    files,
  };
  const json = Buffer.from(JSON.stringify(payload), "utf8");
  const gz = zlib.gzipSync(json, { level: zlib.constants.Z_BEST_SPEED });
  const providerPayload = {
    executionMode: "project",
    projectBundleGzipBase64: gz.toString("base64"),
    entryFile,
    configFile,
  };
  // Env vars (AUT base URL, custom/secret vars) ride along on the provider
  // payload — it's persisted verbatim by the runner-api and handed to the
  // worker, so this reaches the machine that actually runs the test.
  const env = envVars && typeof envVars === "object" ? envVars : {};
  if (Object.keys(env).length > 0) providerPayload.env = { ...env };
  return providerPayload;
}

// ---------------------------------------------------------------------------
// Run submission helpers (unchanged)
// ---------------------------------------------------------------------------

async function createRunWithRetry({
  apiUrl,
  apiKey,
  jobs,
  projectId,
  externalRef,
  tesboApiUrl,
  tesboUiUrl,
  tesboAccessKey,
  runName,
}) {
  let batchSize = Math.max(1, jobs.length);
  while (true) {
    const chunk = jobs.slice(0, batchSize);
    try {
      const payload = {
        jobs: chunk,
        projectId,
        externalRef,
      };
      if (tesboApiUrl) payload.tesboApiUrl = tesboApiUrl;
      if (tesboUiUrl) payload.tesboUiUrl = tesboUiUrl;
      if (tesboAccessKey) payload.tesboAccessKey = tesboAccessKey;
      if (runName) payload.tesboRunName = runName;
      const runData = await apiPost(`${apiUrl}/api/runs`, payload, apiKey);
      if (!runData?.runId) {
        throw new Error("Run submission failed: missing runId");
      }
      return runData;
    } catch (err) {
      if (isRequestTooLargeError(err) && batchSize > 1) {
        batchSize = Math.max(1, Math.floor(batchSize / 2));
        continue;
      }
      throw err;
    }
  }
}

async function submitRemainingRunChunks({
  apiUrl,
  apiKey,
  runId,
  jobs,
  submissionState,
}) {
  if (!Array.isArray(jobs) || jobs.length === 0) {
    submissionState.done = true;
    return;
  }

  let submittedFromRemainder = 0;
  while (submittedFromRemainder < jobs.length) {
    const chunk = [jobs[submittedFromRemainder]];
    try {
      await apiPost(`${apiUrl}/api/runs/${runId}/jobs`, { jobs: chunk }, apiKey);
    } catch (err) {
      submissionState.error = err.message || String(err);
      submissionState.done = true;
      return;
    }

    submittedFromRemainder += chunk.length;
    submissionState.submitted += chunk.length;
  }
  submissionState.done = true;
}

function isRequestTooLargeError(err) {
  const message = String(err?.message || "");
  return message.includes("HTTP 413");
}

// ---------------------------------------------------------------------------
// Tesbo integration (unchanged)
// ---------------------------------------------------------------------------

export async function connectTesbo(options) {
  const { apiUrl, apiKey, tesboApiUrl, tesboUiUrl, tesboAccessKey } = options;
  if (!tesboApiUrl || !tesboAccessKey) {
    logError("  tesboApiUrl and tesboAccessKey are required.");
    return 1;
  }
  try {
    await apiPut(`${apiUrl}/api/apikeys/self/tesbo`, {
      tesboApiUrl,
      tesboUiUrl: tesboUiUrl || null,
      tesboAccessKey,
    }, apiKey);
    log("  \x1b[32m✓\x1b[0m  Tesbo integration connected\n");
    return 0;
  } catch (err) {
    logError(`  \x1b[31m✗\x1b[0m  Failed to connect: ${err.message}`);
    return 1;
  }
}

export async function disconnectTesbo(options) {
  const { apiUrl, apiKey } = options;
  try {
    await apiDelete(`${apiUrl}/api/apikeys/self/tesbo`, apiKey);
    log("  \x1b[32m✓\x1b[0m  Tesbo integration removed\n");
    return 0;
  } catch (err) {
    logError(`  \x1b[31m✗\x1b[0m  Failed to disconnect: ${err.message}`);
    return 1;
  }
}

// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------

function log(msg) { console.log(msg); }
function logError(msg) { console.error(msg); }

// ---------------------------------------------------------------------------
// Output formatting
// ---------------------------------------------------------------------------

function extractSpecName(title) {
  if (!title) return "untitled";
  // title is like "path/to/auth.login.spec.ts :: Test name"
  const filePart = String(title).split(" :: ")[0] || title;
  return path.basename(filePart);
}

function extractTestName(title) {
  if (!title) return null;
  const parts = String(title).split(" :: ");
  return parts.length > 1 ? parts.slice(1).join(" :: ").trim() : null;
}

function printLiveJobResult(job, specStats, specTotal) {
  const isPassed = job.status === "passed";
  const isFailed = job.status === "failed";
  const icon = isPassed
    ? "\x1b[32m✓\x1b[0m"
    : isFailed
    ? "\x1b[31m✗\x1b[0m"
    : "\x1b[90m-\x1b[0m";

  const specName = extractSpecName(job.title);
  const testName = extractTestName(job.title);
  const rawLabel = testName ? `${specName} › ${testName}` : specName;
  const label = rawLabel.length > 48
    ? rawLabel.slice(0, 47) + "…"
    : rawLabel.padEnd(48);
  const node = String(
    job.workerId || job.nodeId || job.worker || job.executionNodeId || job.runnerId || "—"
  ).padEnd(12);
  const duration = formatDuration(job.startedAt, job.endedAt);

  // Show per-spec failure count only when the spec has more than one test
  let failBadge = "";
  if (specTotal > 1 && specStats) {
    const done = specStats.passed + specStats.failed;
    if (specStats.failed > 0) {
      failBadge = `  \x1b[31m(${specStats.failed}/${specTotal} failed)\x1b[0m`;
    } else if (done === specTotal) {
      failBadge = `  \x1b[32m(${specTotal}/${specTotal} passed)\x1b[0m`;
    }
  }

  console.log(`  ${icon}  ${label}  ${node}  ${duration}${failBadge}`);

  if (isFailed && job.errorMessage) {
    const firstLine = String(job.errorMessage).split("\n")[0].trim().slice(0, 120);
    if (firstLine) {
      console.log(`       \x1b[31m└ ${firstLine}\x1b[0m`);
    }
  }
}

function printSummary(runStatus, jobs, totalWallClockMs) {
  const passed = runStatus.passedJobs || 0;
  const failed = runStatus.failedJobs || 0;
  const total = runStatus.totalJobs || 0;
  const serverDuration = formatDuration(runStatus.startedAt, runStatus.endedAt);
  const wallClock = formatDurationMs(totalWallClockMs);
  const divider = `  \x1b[2m${"─".repeat(58)}\x1b[0m`;

  log(`\n${divider}`);

  if (failed === 0 && runStatus.status !== "timeout") {
    log(`  \x1b[32m✓\x1b[0m  All ${passed} test${passed === 1 ? "" : "s"} passed  \x1b[2m·  ${serverDuration} server  ·  ${wallClock} total\x1b[0m`);
  } else if (runStatus.status === "timeout") {
    log(`  \x1b[31m✗\x1b[0m  Timed out  ·  ${passed} passed  ·  ${failed} failed  ·  ${Math.max(0, total - passed - failed)} unfinished  \x1b[2m·  ${wallClock} total\x1b[0m`);
  } else {
    log(`  \x1b[31m✗\x1b[0m  ${failed} of ${total} test${total === 1 ? "" : "s"} failed  \x1b[2m·  ${serverDuration} server  ·  ${wallClock} total\x1b[0m`);
  }

  log(divider);
  log("");
}


function formatDuration(startedAt, endedAt) {
  if (!startedAt || !endedAt) return "—";
  const ms = new Date(endedAt).getTime() - new Date(startedAt).getTime();
  return formatDurationMs(ms);
}

function formatDurationMs(ms) {
  if (!ms || ms < 0) return "—";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const mins = Math.floor(ms / 60000);
  const secs = ((ms % 60000) / 1000).toFixed(0);
  return `${mins}m ${secs}s`;
}

async function waitForTesboRunLink({ apiUrl, apiKey, runId, pollInterval, timeoutMs, initial }) {
  const startedAt = Date.now();
  let latest = initial;
  while (Date.now() - startedAt < Math.max(0, Number(timeoutMs || 0))) {
    if (
      latest?.tesboIngestionStatus === "completed" ||
      latest?.tesboIngestionStatus === "failed"
    ) {
      return latest;
    }
    await sleep(Math.max(1000, Number(pollInterval || 5000)));
    try {
      latest = await apiGet(`${apiUrl}/api/runs/${runId}`, apiKey);
    } catch {
      // best effort only; keep existing latest
    }
  }
  return latest;
}

function printTesboResultLink(runStatus) {
  if (runStatus?.tesboIngestionStatus === "completed" && runStatus?.tesboRunUrl) {
    log(`  \x1b[2mReport\x1b[0m  ${runStatus.tesboRunUrl}\n`);
    return;
  }
  if (runStatus?.tesboIngestionStatus === "failed") {
    log(`  \x1b[31m✗\x1b[0m  Report ingestion failed  \x1b[2m${runStatus.tesboIngestionError || ""}\x1b[0m\n`);
    return;
  }
  if (runStatus?.tesboIngestionStatus === "pending" || runStatus?.tesboIngestionStatus === "in_progress") {
    log(`  \x1b[2mReport ingestion still processing in background\x1b[0m\n`);
  }
}

// ---------------------------------------------------------------------------
// HTTP helpers (unchanged)
// ---------------------------------------------------------------------------

async function fetchProjectStack({ apiUrl, apiKey }) {
  if (!apiUrl || !apiKey) return null;
  try {
    const res = await fetch(`${apiUrl}/api/projects/me/stack`, {
      headers: { "x-api-key": apiKey },
    });
    if (!res.ok) return null;
    const data = await res.json();
    return {
      framework: data?.framework || null,
      language: data?.language || null,
      defaultBrowser: data?.defaultBrowser || null,
    };
  } catch {
    return null;
  }
}

async function apiPost(url, body, apiKey) {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status}: ${text}`);
  }
  return res.json();
}

async function apiGet(url, apiKey) {
  const res = await fetch(url, {
    headers: { "x-api-key": apiKey },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status}: ${text}`);
  }
  return res.json();
}

async function apiPut(url, body, apiKey) {
  const res = await fetch(url, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status}: ${text}`);
  }
  if (res.status === 204) return {};
  return res.json();
}

async function apiDelete(url, apiKey) {
  const res = await fetch(url, {
    method: "DELETE",
    headers: { "x-api-key": apiKey },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status}: ${text}`);
  }
  if (res.status === 204) return {};
  return res.json();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function asNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function formatEta(seconds) {
  if (!seconds || seconds <= 0) return "n/a";
  if (seconds < 60) return `~${seconds}s`;
  const mins = Math.ceil(seconds / 60);
  if (mins < 60) return `~${mins}m`;
  const hours = Math.floor(mins / 60);
  const remMins = mins % 60;
  return remMins ? `~${hours}h ${remMins}m` : `~${hours}h`;
}
