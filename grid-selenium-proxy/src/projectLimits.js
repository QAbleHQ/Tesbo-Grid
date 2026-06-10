// Per-project resource limits — currently just the maximum number of
// concurrent Selenium sessions the project is allowed to keep open.
//
// The cap is set per-project from the dashboard
// (execute_projects.settings.maxConcurrentSessions in grid-backend). When a
// project has no override, sessions are unlimited at the proxy layer — the
// only ceiling that still applies is the cluster's node capacity (Chrome /
// Firefox replicas × SE_NODE_MAX_SESSIONS), which the Hub itself enforces
// by queuing requests once all node slots are busy.
//
// Lookups are TTL-cached so a 100-thread burst doesn't fan out into 100
// backend HTTP calls. The cache also has a "negative" path: when the backend
// 404s or 5xx's we cache `null` for a shorter window so transient backend
// failures don't trigger a backend-storming retry on every session-create.

import { config } from "./config.js";
import { logError, logWarn } from "./logger.js";

// Treats `0` as "unlimited" to match the existing env-var semantic. Any
// other non-negative integer is the hard cap.
function isValidCap(value) {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

const cache = new Map(); // projectId -> { value: number | null, expiresAt: number }
const NEGATIVE_TTL_MS = 5_000;

function cacheGet(projectId) {
  const entry = cache.get(projectId);
  if (!entry) return undefined;
  if (entry.expiresAt < Date.now()) {
    cache.delete(projectId);
    return undefined;
  }
  return entry.value;
}

function cachePut(projectId, value, ttlMs) {
  cache.set(projectId, {
    value,
    expiresAt: Date.now() + ttlMs,
  });
}

// Exposed for tests / for callers that already have a fresher value (e.g.
// auth.js receives the cap as part of /project-by-key's response and can
// preload the cache so the next isOverQuota lookup is free).
export function primeProjectMaxConcurrentSessions(projectId, value) {
  if (!projectId) return;
  const normalised = isValidCap(value) ? value : null;
  cachePut(projectId, normalised, config.projectLimitsCacheTtlMs);
}

// Clears the cache. Tests use this; the request path doesn't.
export function _clearProjectLimitsCache() {
  cache.clear();
}

// Resolve the per-project cap. Returns:
//   * a non-negative integer when the project has an explicit override
//     (0 means "unlimited" for that project)
//   * `null` when the project has no override set — the proxy treats this
//     as "unlimited" too (cluster capacity is the only remaining ceiling)
async function fetchProjectMaxConcurrentSessions(projectId) {
  const url = `${String(config.tesboApiUrl).replace(/\/+$/, "")}/api/internal/projects/${encodeURIComponent(projectId)}/limits`;
  let response;
  try {
    response = await fetch(url, {
      method: "GET",
      headers: config.tesboInternalToken
        ? { "x-agent-token": config.tesboInternalToken }
        : {},
      signal: AbortSignal.timeout(5_000),
    });
  } catch (err) {
    logWarn("project_limits_fetch_failed", {
      projectId,
      error: err instanceof Error ? err.message : String(err),
    });
    return undefined; // caller will fall back to env default; do NOT cache
  }
  if (response.status === 404) {
    // Project no longer exists or was archived — treat as "no override".
    return null;
  }
  if (!response.ok) {
    logWarn("project_limits_fetch_non_ok", {
      projectId,
      status: response.status,
    });
    return undefined;
  }
  let payload;
  try {
    payload = await response.json();
  } catch (err) {
    logError("project_limits_fetch_bad_json", {
      projectId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
  const cap = payload?.maxConcurrentSessions;
  if (cap === null || cap === undefined) return null;
  if (!isValidCap(cap)) {
    logWarn("project_limits_invalid_cap", { projectId, cap });
    return null;
  }
  return cap;
}

// Public API: returns the effective concurrency cap for `projectId`, or
// `null` to mean "no per-project override set" (which the proxy treats as
// unlimited). Caches both positive and negative results.
export async function getProjectMaxConcurrentSessions(projectId) {
  if (!projectId) return null;

  const cached = cacheGet(projectId);
  if (cached !== undefined) return cached;

  const value = await fetchProjectMaxConcurrentSessions(projectId);
  if (value === undefined) {
    // Transient backend failure — cache `null` for a short window so we
    // don't DOS the backend with retries on every session-create. Falling
    // back to "no override" (i.e. unlimited) is fine: the cluster's own
    // node capacity is still enforced by the Hub.
    cachePut(projectId, null, NEGATIVE_TTL_MS);
    return null;
  }
  cachePut(projectId, value, config.projectLimitsCacheTtlMs);
  return value;
}

// Returns the cap that should be enforced for this project. Returns 0 when
// no cap applies (either the project explicitly opted into 0 = unlimited,
// or no per-project override is set at all). Callers — see
// evaluateProjectQuota — interpret 0 as "skip the quota check".
export async function getEffectiveSessionCap(projectId) {
  const override = await getProjectMaxConcurrentSessions(projectId);
  if (override === null) return 0; // no override = unlimited at proxy layer
  return override;
}
