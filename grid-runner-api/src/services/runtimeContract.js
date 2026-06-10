const SUPPORTED_FRAMEWORKS = new Set(["playwright", "selenium"]);
const SUPPORTED_LANGUAGES = new Set(["javascript", "typescript", "python", "java"]);
const SUPPORTED_MODES = new Set(["script", "project"]);

function normalizeText(value) {
  if (typeof value !== "string") return "";
  return value.trim();
}

export function normalizeRuntime(job = {}) {
  const runtime = (job && typeof job.runtime === "object" && job.runtime) || {};
  const framework = normalizeText(runtime.framework || job.framework || "playwright").toLowerCase();
  const language = normalizeText(runtime.language || job.language || "javascript").toLowerCase();
  const runtimeLanguage = language || "javascript";

  const mode = normalizeText(runtime.executionMode || runtime.mode || job.runtimeMode || "").toLowerCase();
  const legacyMode = normalizeText(job?.providerPayload?.executionMode || "");
  const resolvedMode = mode || legacyMode.toLowerCase() || "script";
  const runtimeMode = SUPPORTED_MODES.has(resolvedMode) ? resolvedMode : "script";

  return {
    framework: SUPPORTED_FRAMEWORKS.has(framework) ? framework : "playwright",
    language: runtimeLanguage,
    executionMode: runtimeMode,
    entrypoint: normalizeText(runtime.entrypoint || job.runtimeEntrypoint || ""),
    command: normalizeText(runtime.command || ""),
    configFile: normalizeText(runtime.configFile || ""),
    browser: normalizeText(runtime.browser || job.browser || job?.providerConfig?.browser || "chrome").toLowerCase() || "chrome",
    testSelector: normalizeText(runtime.testSelector || job.runtimeTestSelector || ""),
    rawConfig: runtime && typeof runtime === "object" ? runtime : {},
  };
}

export function hasQueueableWork(job = {}, runtime = normalizeRuntime(job)) {
  if (runtime.executionMode === "script") {
    return !!(job.script && normalizeText(job.script));
  }
  const payload = job.providerPayload && typeof job.providerPayload === "object"
    ? job.providerPayload
    : {};
  const bundle = normalizeText(payload.projectBundleGzipBase64 || "");
  return bundle.length > 0;
}

function countPlaywrightTests(script) {
  if (!script || typeof script !== "string") return 0;
  const matches = script.match(/\btest(?:\.(?:only|skip|fixme|fail))?\s*\(/g);
  return matches ? matches.length : 0;
}

export function validateRuntimeJobs(jobs = []) {
  const invalid = [];

  for (let i = 0; i < jobs.length; i += 1) {
    const job = jobs[i] || {};
    const runtime = normalizeRuntime(job);
    const declared = Number(job.testCaseCount);

    if (!SUPPORTED_LANGUAGES.has(runtime.language)) {
      invalid.push({
        index: i + 1,
        title: job.title || null,
        reason: `unsupported runtime.language=${runtime.language}`,
      });
      continue;
    }

    if (!SUPPORTED_FRAMEWORKS.has(runtime.framework)) {
      invalid.push({
        index: i + 1,
        title: job.title || null,
        reason: `unsupported runtime.framework=${runtime.framework}`,
      });
      continue;
    }

    if (!SUPPORTED_MODES.has(runtime.executionMode)) {
      invalid.push({
        index: i + 1,
        title: job.title || null,
        reason: `unsupported runtime.executionMode=${runtime.executionMode}`,
      });
      continue;
    }

    if (Number.isFinite(declared) && Math.floor(declared) !== 1) {
      invalid.push({
        index: i + 1,
        title: job.title || null,
        reason: `declared testCaseCount=${declared}`,
      });
      continue;
    }

    if (runtime.framework === "selenium") {
      if (runtime.executionMode !== "project") {
        invalid.push({
          index: i + 1,
          title: job.title || null,
          reason: "selenium supports project mode only",
        });
        continue;
      }
      if (runtime.language !== "python" && runtime.language !== "java") {
        invalid.push({
          index: i + 1,
          title: job.title || null,
          reason: `selenium currently supports python/java only (received ${runtime.language})`,
        });
        continue;
      }
      const payload = job.providerPayload && typeof job.providerPayload === "object"
        ? job.providerPayload
        : {};
      if (!normalizeText(payload.projectBundleGzipBase64 || "")) {
        invalid.push({
          index: i + 1,
          title: job.title || null,
          reason: "project mode requires providerPayload.projectBundleGzipBase64",
        });
        continue;
      }
      if (!runtime.entrypoint) {
        invalid.push({
          index: i + 1,
          title: job.title || null,
          reason: "selenium project mode requires runtime.entrypoint",
        });
        continue;
      }
      if (!runtime.testSelector) {
        invalid.push({
          index: i + 1,
          title: job.title || null,
          reason: "selenium project mode requires runtime.testSelector",
        });
      }
      continue;
    }

    if (runtime.language === "python" || runtime.language === "java") {
      if (runtime.executionMode !== "project") {
        invalid.push({
          index: i + 1,
          title: job.title || null,
          reason: `${runtime.language} supports project mode only`,
        });
        continue;
      }
      const payload = job.providerPayload && typeof job.providerPayload === "object"
        ? job.providerPayload
        : {};
      if (!normalizeText(payload.projectBundleGzipBase64 || "")) {
        invalid.push({
          index: i + 1,
          title: job.title || null,
          reason: "project mode requires providerPayload.projectBundleGzipBase64",
        });
        continue;
      }
      if (!runtime.entrypoint) {
        invalid.push({
          index: i + 1,
          title: job.title || null,
          reason: "project mode requires runtime.entrypoint",
        });
      }
      continue;
    }

    if (runtime.executionMode === "script") {
      const inferred = countPlaywrightTests(job.script);
      if (inferred !== 1) {
        invalid.push({
          index: i + 1,
          title: job.title || null,
          reason: `detected ${inferred} test() blocks`,
        });
      }
      continue;
    }

    const payload = job.providerPayload && typeof job.providerPayload === "object"
      ? job.providerPayload
      : {};
    if (!normalizeText(payload.projectBundleGzipBase64 || "")) {
      invalid.push({
        index: i + 1,
        title: job.title || null,
        reason: "project mode requires providerPayload.projectBundleGzipBase64",
      });
    }
  }

  return invalid;
}
