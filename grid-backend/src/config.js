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

function parseCsv(csv) {
  return csv
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function normalizeUrl(url) {
  return String(url || "").trim().replace(/\/+$/, "");
}

const frontendUrl = normalizeUrl(env("FRONTEND_URL", ""));
const corsAllowedOrigins = Array.from(
  new Set([
    ...parseCsv(env("CORS_ALLOWED_ORIGINS", "")).map(normalizeUrl),
    frontendUrl,
  ].filter(Boolean))
);

export const config = {
  port: Number(env("PORT", "7100")),

  dbUrl: requireEnv("DATABASE_URL"),

  sessionCookieName: "tesbo_session",
  sessionDays: Number(env("SESSION_DAYS", "30")),

  otpExpiryMinutes: Number(env("OTP_EXPIRY_MINUTES", "10")),
  otpMaxAttempts: Number(env("OTP_MAX_ATTEMPTS", "5")),
  otpRateLimitWindowMinutes: Number(env("OTP_RATE_LIMIT_WINDOW_MINUTES", "15")),

  postmarkApiToken: env("POSTMARK_API_TOKEN", ""),
  postmarkFromEmail: env("POSTMARK_FROM_EMAIL", "noreply@example.com"),

  corsAllowedOrigins,

  frontendUrl,

  executionApiUrl: env(
    "EXECUTION_API_URL",
    "http://localhost:7420"
  ),
  executionApiSharedToken: env("EXECUTION_API_SHARED_TOKEN", ""),

  // Public URL the customer's GitHub Actions runner uses to reach the
  // grid-runner-api (the host that mounts POST /api/runs). MUST be the
  // runner-api host, NOT the app API, because /api/runs is only registered
  // on grid-runner-api/src/index.js. Set RUNNER_PUBLIC_API_URL to your
  // publicly-reachable runner-api endpoint in production.
  runnerPublicApiUrl: normalizeUrl(
    env("RUNNER_PUBLIC_API_URL", "http://localhost:7420")
  ),

  // grid-selenium-proxy — URL the dashboard reaches when streaming a live
  // session's VNC. We pipe a WS through grid-backend (cookie auth) → proxy
  // (internal token) → selenium node :7900/websockify so node IPs never
  // leave the cluster.
  seleniumProxyUrl: env("SELENIUM_PROXY_URL", "http://localhost:7430"),
  seleniumProxyInternalToken: env("INTERNAL_SHARED_TOKEN", ""),

  // Auto-close report_runs that stay IN_PROGRESS without any test-result
  // update for longer than this. Default 3 hours — matches what we tell
  // users in the dashboard. Set to 0 to disable the sweeper entirely.
  runIdleTimeoutMs: Number(
    env("RUN_IDLE_TIMEOUT_MS", String(3 * 60 * 60 * 1000))
  ),
  runSweepIntervalMs: Number(
    env("RUN_SWEEP_INTERVAL_MS", String(10 * 60 * 1000))
  ),

  // GitHub App — leave any of these blank to disable the /api/github routes entirely.
  // Names use the GH_* prefix (not GITHUB_*) because GitHub reserves GITHUB_* for its
  // own Actions secrets and rejects user-defined secrets with that prefix. The
  // private key is a PEM string; for env-var transport, base64-encode it and we
  // decode here. WEBHOOK_SECRET is a fallback; each integration row has its own
  // per-installation secret stored in github_integrations.webhook_secret.
  github: {
    appId: env("GH_APP_ID", ""),
    appName: env("GH_APP_NAME", ""),
    appClientId: env("GH_APP_CLIENT_ID", ""),
    appClientSecret: env("GH_APP_CLIENT_SECRET", ""),
    privateKey: (() => {
      const raw = env("GH_APP_PRIVATE_KEY", "");
      if (!raw) return "";
      if (raw.startsWith("-----BEGIN")) return raw;
      try { return Buffer.from(raw, "base64").toString("utf8"); } catch { return raw; }
    })(),
    webhookSecret: env("GH_APP_WEBHOOK_SECRET", ""),
    cronTickMs: Number(env("GH_CRON_TICK_MS", "30000")),
  },
};
