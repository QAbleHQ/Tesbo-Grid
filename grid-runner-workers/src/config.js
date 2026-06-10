import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";

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

function parseSupportedLanguages(raw) {
  const items = String(raw || "javascript,typescript,python,java")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  return Array.from(new Set(items));
}

function parseCsv(raw) {
  return Array.from(
    new Set(
      String(raw || "")
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean)
    )
  );
}

// Mirrors grid-runner-api/src/config.js#buildQueueName. Keep these in sync.
function buildQueueName(base, framework, language) {
  const normalizedFramework = String(framework || "playwright").trim().toLowerCase();
  const normalizedLanguage = String(language || "javascript").trim().toLowerCase();
  if (normalizedFramework === "playwright") {
    if (normalizedLanguage === "javascript" || normalizedLanguage === "typescript") {
      return base;
    }
    return `${base}-${normalizedLanguage}`;
  }
  return `${base}-${normalizedFramework}-${normalizedLanguage}`;
}

function resolveQueueNames(queueBaseName) {
  const explicit = parseCsv(env("QUEUE_NAMES", ""));
  if (explicit.length > 0) return explicit;

  const frameworks = parseCsv(env("WORKER_FRAMEWORKS", ""));
  const languages = parseCsv(env("WORKER_LANGUAGES", ""));
  if (frameworks.length === 0 || languages.length === 0) {
    return [queueBaseName];
  }

  const names = [];
  for (const framework of frameworks) {
    for (const language of languages) {
      names.push(buildQueueName(queueBaseName, framework, language));
    }
  }
  return Array.from(new Set(names));
}

const queueBaseName = env("QUEUE_NAME", "execution-jobs");

export const config = {
  port: Number(env("PORT", "7411")),
  headless: env("PLAYWRIGHT_HEADLESS", "true") !== "false",
  startUrlTimeoutMs: Number(env("START_URL_TIMEOUT_MS", "60000")),
  screenshotDir: path.resolve(env("SCREENSHOT_DIR", "./artifacts/screenshots")),
  videoDir: path.resolve(env("VIDEO_DIR", "./artifacts/videos")),
  traceDir: path.resolve(env("TRACE_DIR", "./artifacts/traces")),
  recordVideo: env("RECORD_VIDEO", "true") !== "false",
  sharedToken: env("AGENT_SHARED_TOKEN", ""),
  workerId: env("WORKER_ID", `worker-${crypto.randomBytes(4).toString("hex")}`),
  executionApiBaseUrl: requireEnv("EXECUTION_API_BASE_URL"),
  executionApiSharedToken: env("EXECUTION_API_SHARED_TOKEN", ""),
  redisUrl: env("REDIS_URL", "redis://localhost:6379"),
  queuePrefix: env("QUEUE_PREFIX", "bull"),
  queueName: queueBaseName,
  queueNames: resolveQueueNames(queueBaseName),
  queueConcurrency: Number(env("QUEUE_CONCURRENCY", "2")),
  queueHeartbeatMs: Number(env("QUEUE_HEARTBEAT_MS", "5000")),
  queueJobTimeoutMs: Number(env("QUEUE_JOB_TIMEOUT_MS", "900000")),
  queueDefaultRetries: Number(env("QUEUE_MAX_RETRIES", "2")),
  // Artifact storage. "none" keeps artifacts on the local volume (./artifacts);
  // "s3" uploads to any S3-compatible store — AWS S3, GCS (S3 interop), MinIO,
  // DigitalOcean Spaces, etc. The legacy "do_spaces" value and the SPACES_*
  // env names are still honored as aliases for the generic S3_* names.
  artifactStorageProvider: env("ARTIFACT_STORAGE_PROVIDER", "none"),
  storageEndpoint: env("S3_ENDPOINT", env("SPACES_ENDPOINT", "")),
  storageRegion: env("S3_REGION", env("SPACES_REGION", "us-east-1")),
  storageBucket: env("S3_BUCKET", env("SPACES_BUCKET", "")),
  storageAccessKey: env("S3_ACCESS_KEY", env("SPACES_ACCESS_KEY", "")),
  storageSecretKey: env("S3_SECRET_KEY", env("SPACES_SECRET_KEY", "")),
  storagePublicBaseUrl: env("S3_PUBLIC_BASE_URL", env("SPACES_PUBLIC_BASE_URL", "")),
  // Path-style addressing is required by MinIO and some S3-compatibles; AWS S3
  // and DO Spaces use virtual-hosted style (false).
  storageForcePathStyle: env("S3_FORCE_PATH_STYLE", "false") === "true",
  // Object ACL to set on upload. "public-read" makes artifacts directly
  // linkable (DO Spaces default). Set to "" for buckets that block ACLs
  // (e.g. AWS S3 with "Bucket owner enforced") and serve via S3_PUBLIC_BASE_URL.
  storageObjectAcl: env("S3_OBJECT_ACL", "public-read"),
  enableLambdaTestProvider: env("PROVIDER_LAMBDATEST_ENABLED", "false") === "true",
  enableBrowserStackProvider: env("PROVIDER_BROWSERSTACK_ENABLED", "false") === "true",
  supportedLanguages: parseSupportedLanguages(env("SUPPORTED_LANGUAGES", "javascript,typescript,python,java")),
  supportedFrameworks: parseCsv(env("SUPPORTED_FRAMEWORKS", "playwright,selenium")),
  seleniumGridUrl: env("SELENIUM_REMOTE_URL", ""),
  seleniumDefaultBrowser: env("SELENIUM_DEFAULT_BROWSER", "chrome"),
  validateQueueRouting: env("VALIDATE_QUEUE_ROUTING", "true") !== "false",
};

// Playwright auto-detects SELENIUM_REMOTE_URL (and friends) at browserType.launch
// time and re-routes through Selenium Grid. When these vars are inherited from
// a shared k8s Secret on the framework=playwright worker pool, every test fails
// with a CDP connect error. Capture the value into config above, then scrub
// process.env so neither in-process Playwright nor spawned `playwright test`
// children pick it up. Selenium-framework runners pass config.seleniumGridUrl
// through explicitly, so they're unaffected by this delete.
delete process.env.SELENIUM_REMOTE_URL;
delete process.env.SELENIUM_REMOTE_HEADERS;
delete process.env.SELENIUM_REMOTE_CAPABILITIES;

// Asserts that every queue this worker subscribes to is reachable by at least
// one (framework, language) pair the worker actually has installed runtimes
// for. Catches deployment misconfig (e.g. a JS-only image subscribed to
// `execution-jobs-python`) at boot rather than per-job.
export function validateQueueRoutingOrThrow() {
  if (!config.validateQueueRouting) return;
  const supportedQueueNames = new Set();
  for (const framework of config.supportedFrameworks) {
    for (const language of config.supportedLanguages) {
      supportedQueueNames.add(buildQueueName(queueBaseName, framework, language));
    }
  }
  const orphaned = config.queueNames.filter((q) => !supportedQueueNames.has(q));
  if (orphaned.length > 0) {
    const allowed = Array.from(supportedQueueNames).join(", ");
    throw new Error(
      `[worker config] Queue/runtime mismatch: this pod subscribes to ` +
        `[${orphaned.join(", ")}] but its installed runtimes ` +
        `(frameworks=${config.supportedFrameworks.join("|")}, ` +
        `languages=${config.supportedLanguages.join("|")}) only handle ` +
        `[${allowed}]. Either fix QUEUE_NAMES, SUPPORTED_FRAMEWORKS, ` +
        `SUPPORTED_LANGUAGES, or build the right Docker image. ` +
        `Set VALIDATE_QUEUE_ROUTING=false to bypass.`
    );
  }
}
