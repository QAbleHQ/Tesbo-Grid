import path from "node:path";
import fs from "node:fs";

function loadDotEnv() {
  const envPath = path.resolve(process.cwd(), ".env");
  const map = new Map();
  if (!fs.existsSync(envPath)) return map;
  const raw = fs.readFileSync(envPath, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    map.set(key, value);
  }
  return map;
}

const DOT_ENV = loadDotEnv();
const UNBOUNDED_LIMIT = Number.MAX_SAFE_INTEGER;

function uniqueStrings(values) {
  return Array.from(new Set(values.filter(Boolean)));
}

function env(name, fallback) {
  const fromDotEnv = DOT_ENV.get(name);
  if (fromDotEnv != null && fromDotEnv !== "") return fromDotEnv;
  const value = process.env[name];
  if (value == null || value === "") return fallback;
  return value;
}

function requireEnv(name) {
  const value = env(name, undefined);
  if (value == null || value === "") {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function parseIntEnv(name, fallback) {
  const value = Number(env(name, String(fallback)));
  if (!Number.isFinite(value)) return fallback;
  return Math.floor(value);
}

function parseCapEnv(name, fallback) {
  const parsed = parseIntEnv(name, fallback);
  if (parsed <= 0) return UNBOUNDED_LIMIT;
  return parsed;
}

const autoscaleMaxWorkers = parseIntEnv("AUTOSCALE_MAX_WORKERS", 500);
const autoscaleTargetJobsPerWorker = parseIntEnv("AUTOSCALE_TARGET_JOBS_PER_WORKER", 1);
const autoscaleTargetTestCasesPerWorker = Number(
  env("AUTOSCALE_TARGET_TESTCASES_PER_WORKER", String(autoscaleTargetJobsPerWorker))
);
const schedulerGlobalConcurrentTestCases = parseCapEnv(
  "SCHEDULER_GLOBAL_CONCURRENT_TESTCASES",
  Math.max(1, autoscaleMaxWorkers * Math.max(1, autoscaleTargetTestCasesPerWorker))
);
const queueBaseName = env("QUEUE_NAME", "execution-jobs");

// Queue naming convention (must match KEDA `listName` + worker `QUEUE_NAMES`):
//   playwright + javascript|typescript → execution-jobs            (legacy base)
//   playwright + python                → execution-jobs-python
//   playwright + java                  → execution-jobs-java
//   selenium   + python                → execution-jobs-selenium-python
//   selenium   + java                  → execution-jobs-selenium-java
// Adding a new framework/language pair?  Add it here AND add a matching
// Deployment + ScaledObject in infra/kubernetes/, AND a worker service in
// docker-compose.yml. All three must agree on the queue name.
function buildQueueName(framework, language) {
  const normalizedFramework = String(framework || "playwright").trim().toLowerCase();
  const normalizedLanguage = String(language || "javascript").trim().toLowerCase();
  if (normalizedFramework === "playwright") {
    if (normalizedLanguage === "javascript" || normalizedLanguage === "typescript") {
      return queueBaseName;
    }
    return `${queueBaseName}-${normalizedLanguage}`;
  }
  return `${queueBaseName}-${normalizedFramework}-${normalizedLanguage}`;
}

export const config = {
  port: Number(env("PORT", "7420")),

  dbUrl: requireEnv("DATABASE_URL"),

  redisUrl: env("REDIS_URL", "redis://localhost:6379"),
  queuePrefix: env("QUEUE_PREFIX", "bull"),
  queueName: queueBaseName,
  queueNameJavascript: env("QUEUE_NAME_JS", queueBaseName),
  queueNamePython: env("QUEUE_NAME_PYTHON", buildQueueName("playwright", "python")),
  queueNameJava: env("QUEUE_NAME_JAVA", buildQueueName("playwright", "java")),
  queueNameSeleniumPython: env("QUEUE_NAME_SELENIUM_PYTHON", buildQueueName("selenium", "python")),
  queueNameSeleniumJava: env("QUEUE_NAME_SELENIUM_JAVA", buildQueueName("selenium", "java")),

  // NOTE: per-project concurrency / queue limits are intentionally NOT
  // configured here. Customer-meaningful limits (e.g. live WebDriver session
  // cap) live in `execute_projects.settings` and are managed from the
  // dashboard. Internal-only limits (jobs / test cases / runs / queue
  // depth) used to be governed by env vars defaulting to 0 (unbounded);
  // they have been removed because (a) they were never enforced in
  // production and (b) "limit a user's project" should always be a
  // first-class UI control, not an ops-set env var.

  defaultMaxRetries: Number(env("DEFAULT_MAX_RETRIES", "2")),
  schedulerGlobalConcurrentTestCases,
  dispatchBatchSize: Number(env("DISPATCH_BATCH_SIZE", "50")),
  staleJobMinutes: Number(env("STALE_JOB_MINUTES", "15")),
  schedulerTickMs: Number(env("SCHEDULER_TICK_MS", "5000")),

  autoscaleMinWorkers: Number(env("AUTOSCALE_MIN_WORKERS", "0")),
  autoscaleMaxWorkers,
  autoscaleTargetJobsPerWorker,
  autoscaleTargetTestCasesPerWorker,
  autoscaleWarmWorkers: Number(env("AUTOSCALE_WARM_WORKERS", "0")),
  schedulerDefaultTenantWeight: Number(env("SCHEDULER_DEFAULT_TENANT_WEIGHT", "1")),
  // Per-organization concurrency ceiling enforced by the dispatcher. Caps the
  // total in-flight test cases an organization can hold across all its
  // projects. Overridden per-org by `organizations.settings.maxConcurrentJobs`.
  // Default of 5 keeps a single customer from saturating the worker pool and
  // driving up the infra bill.
  schedulerDefaultOrganizationConcurrentJobs: Number(
    env("SCHEDULER_DEFAULT_ORG_CONCURRENT_JOBS", "5")
  ),

  webhookTimeoutMs: Number(env("WEBHOOK_TIMEOUT_MS", "10000")),

  tesboApiUrl: env("TESBO_API_URL", "http://localhost:7100"),
  tesboUiUrl: env("TESBO_UI_URL", "http://localhost:3100"),
  supportedFrameworks: ["playwright", "selenium"],
  supportedLanguages: ["javascript", "typescript", "python", "java"],
  allQueueNames: uniqueStrings([
    env("QUEUE_NAME_JS", queueBaseName),
    env("QUEUE_NAME_PYTHON", buildQueueName("playwright", "python")),
    env("QUEUE_NAME_JAVA", buildQueueName("playwright", "java")),
    env("QUEUE_NAME_SELENIUM_PYTHON", buildQueueName("selenium", "python")),
    env("QUEUE_NAME_SELENIUM_JAVA", buildQueueName("selenium", "java")),
  ]),
};

export function resolveQueueNameForRuntime({ framework = "playwright", language = "javascript" } = {}) {
  const normalizedFramework = String(framework || "playwright").trim().toLowerCase();
  const normalizedLanguage = String(language || "javascript").trim().toLowerCase();
  if (normalizedFramework === "selenium" && normalizedLanguage === "python") {
    return config.queueNameSeleniumPython;
  }
  if (normalizedFramework === "selenium" && normalizedLanguage === "java") {
    return config.queueNameSeleniumJava;
  }
  if (normalizedLanguage === "python") return config.queueNamePython;
  if (normalizedLanguage === "java") return config.queueNameJava;
  return config.queueNameJavascript;
}
