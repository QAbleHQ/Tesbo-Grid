const SUPPORTED_FRAMEWORKS = new Set(["playwright", "selenium"]);
const SUPPORTED_LANGUAGES = new Set(["javascript", "typescript", "python", "java"]);

function text(value) {
  if (typeof value !== "string") return "";
  return value.trim();
}

export function normalizeRuntime(payload = {}) {
  const runtime = (payload && typeof payload.runtime === "object" && payload.runtime) || {};
  const framework = text(runtime.framework || payload.framework || "playwright").toLowerCase();
  const language = text(runtime.language || payload.language || "javascript").toLowerCase();
  const executionMode = text(
    runtime.executionMode
    || runtime.mode
    || payload.runtimeMode
    || payload?.providerPayload?.executionMode
    || "script"
  ).toLowerCase();

  return {
    framework: SUPPORTED_FRAMEWORKS.has(framework) ? framework : "playwright",
    language: SUPPORTED_LANGUAGES.has(language) ? language : "javascript",
    executionMode: executionMode === "project" ? "project" : "script",
    entrypoint: text(runtime.entrypoint || payload.runtimeEntrypoint || ""),
    command: text(runtime.command || ""),
    configFile: text(runtime.configFile || ""),
    browser: text(runtime.browser || payload.browser || payload?.providerConfig?.browser || "chrome").toLowerCase() || "chrome",
    testSelector: text(runtime.testSelector || payload.runtimeTestSelector || ""),
  };
}
