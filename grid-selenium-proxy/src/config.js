function env(name, fallback) {
  const value = process.env[name];
  if (value == null || value === "") return fallback;
  return value;
}

function requireEnv(name) {
  const value = process.env[name];
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

export const config = {
  port: parseIntEnv("PORT", 7430),

  dbUrl: requireEnv("DATABASE_URL"),

  // Address of the in-cluster Selenium Hub. Stays ClusterIP so it never gets
  // a public IP — the proxy is the only ingress point.
  seleniumHubUrl: requireEnv("SELENIUM_HUB_URL"),

  // grid-backend; used to resolve `tesbo_*` access keys to a project AND to
  // fetch per-project resource limits (concurrency cap, etc.) from
  // /api/internal/projects/:id/limits.
  tesboApiUrl: env("TESBO_API_URL", "http://localhost:7100"),

  // Shared secret the proxy uses when calling grid-backend's
  // /api/internal/* endpoints. Same value as grid-backend's
  // EXECUTION_API_SHARED_TOKEN — when both ends are unset, the backend's
  // requireAgentToken middleware falls open (dev/local).
  tesboInternalToken: env("INTERNAL_SHARED_TOKEN", ""),

  // NOTE: there is intentionally no global default cap on concurrent
  // WebDriver sessions per project. Concurrency is governed entirely by:
  //   1. The dashboard per-project override
  //      (execute_projects.settings.maxConcurrentSessions in grid-backend),
  //      0/null = unlimited.
  //   2. The cluster's actual node capacity (selenium-node-chrome /
  //      selenium-node-firefox replicas × SE_NODE_MAX_SESSIONS), which is
  //      always the hard ceiling regardless of what the proxy says.
  // The legacy MAX_CONCURRENT_SELENIUM_SESSIONS_PER_PROJECT env var has
  // been removed — set the cap from the dashboard instead.

  // How long to cache a per-project limits lookup. Short enough that an
  // operator-initiated bump in the dashboard takes effect within ~30s, long
  // enough to absorb a 100-burst without 100 backend round-trips.
  projectLimitsCacheTtlMs: parseIntEnv("PROJECT_LIMITS_CACHE_TTL_MS", 30 * 1000),

  // How long a session can stay `active` without a successful upstream lookup
  // before the cleanup tick flips it to `abandoned`.
  sessionIdleTimeoutMs: parseIntEnv("SELENIUM_SESSION_IDLE_TIMEOUT_MS", 10 * 60 * 1000),

  cleanupIntervalMs: parseIntEnv("SELENIUM_CLEANUP_INTERVAL_MS", 30 * 1000),

  proxyTimeoutMs: parseIntEnv("SELENIUM_PROXY_TIMEOUT_MS", 10 * 60 * 1000),
};
