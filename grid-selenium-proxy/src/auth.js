import {
  lookupApiKeyRow,
  createTesboKeyResolver,
} from "@tesbox/playwright-runner/apiKeyAuth";
import { query } from "./db.js";
import { config } from "./config.js";
import { primeProjectMaxConcurrentSessions } from "./projectLimits.js";

const resolveTesboKey = createTesboKeyResolver({
  tesboApiUrl: config.tesboApiUrl,
  // Backend includes the per-project session cap in /project-by-key's
  // response. Prime the limits cache so the immediately-following
  // isOverQuota check is a pure in-memory lookup — no second round-trip.
  onResolved(payload) {
    const cap = payload?.limits?.maxConcurrentSessions;
    if (payload?.projectId && (cap === null || typeof cap === "number")) {
      primeProjectMaxConcurrentSessions(payload.projectId, cap);
    }
  },
});

// Reads a header off either an Express request (`req.header(name)`) or a raw
// Node.js `http.IncomingMessage` (`req.headers[name.toLowerCase()]`). The
// proxy invokes `extractCredentials` from both contexts, so we must support
// both shapes — otherwise raw-Node call sites throw `req.header is not a
// function` and the request hangs until the client times out.
function readHeader(req, name) {
  if (!req) return undefined;
  if (typeof req.header === "function") {
    return req.header(name);
  }
  const headers = req.headers;
  if (!headers) return undefined;
  const value = headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

// Pull a candidate access key out of every place a WebDriver client might
// stash it — basic-auth header, x-api-key header, or `tesbo:options` capability.
export function extractCredentials(req, body) {
  const headerKey = readHeader(req, "x-api-key");
  if (headerKey) return { accessKey: String(headerKey).trim(), source: "x-api-key" };

  const auth = readHeader(req, "authorization") || "";
  if (auth.toLowerCase().startsWith("basic ")) {
    try {
      const decoded = Buffer.from(auth.slice(6).trim(), "base64").toString("utf8");
      // Format is `<username>:<password>`. Many vendors put the access key in
      // the password slot and leave the username as the projectId; we only
      // care about the access key.
      const colon = decoded.indexOf(":");
      const password = colon >= 0 ? decoded.slice(colon + 1) : decoded;
      const username = colon >= 0 ? decoded.slice(0, colon) : "";
      const accessKey = (password || username).trim();
      if (accessKey) {
        return {
          accessKey,
          declaredProjectId: (username || "").trim() || null,
          source: "basic-auth",
        };
      }
    } catch {
      // fall through
    }
  }

  if (body && typeof body === "object") {
    const fromCaps = pickKeyFromBody(body);
    if (fromCaps) return { accessKey: fromCaps, source: "tesbo:options" };
  }

  return null;
}

function pickKeyFromBody(body) {
  const candidates = [];
  if (body.capabilities && typeof body.capabilities === "object") {
    candidates.push(body.capabilities.alwaysMatch);
    if (Array.isArray(body.capabilities.firstMatch)) {
      for (const fm of body.capabilities.firstMatch) candidates.push(fm);
    }
  }
  candidates.push(body.desiredCapabilities);
  for (const caps of candidates) {
    if (caps && typeof caps === "object") {
      const tesbo = caps["tesbo:options"];
      if (tesbo && typeof tesbo === "object") {
        const k = tesbo.accessKey || tesbo.access_key || tesbo.apiKey;
        if (k) return String(k).trim();
      }
    }
  }
  return null;
}

// In-memory cache for resolved access keys.
//
// The proxy receives one POST /session per WebDriver thread; with 100+ parallel
// runs this used to fan out to 100+ Postgres lookups in the same instant and
// exhaust the managed-Postgres connection pool ("remaining connection slots are
// reserved for roles with the SUPERUSER attribute"). That error then bubbled
// up as a 401 to the client, which made tests look like they were failing with
// "Invalid API key".
//
// We cache successful resolutions for a short TTL so repeated session creates
// from the same key share a single DB round-trip. Negative results are NOT
// cached — a freshly-rotated key should start working immediately.
//
// Cache is intentionally simple (Map with FIFO eviction). Per-pod, no cross-pod
// invalidation needed: TTL is short and stale entries only mean a session is
// attributed to the previously-valid project for at most TTL seconds.
const resolutionCache = new Map();
const CACHE_TTL_MS = Number(process.env.AUTH_CACHE_TTL_MS) || 60_000;
const CACHE_MAX_ENTRIES = Number(process.env.AUTH_CACHE_MAX_ENTRIES) || 5_000;

function cacheGet(accessKey) {
  const entry = resolutionCache.get(accessKey);
  if (!entry) return undefined;
  if (entry.expiresAt < Date.now()) {
    resolutionCache.delete(accessKey);
    return undefined;
  }
  return entry.value;
}

function cachePut(accessKey, value) {
  if (resolutionCache.size >= CACHE_MAX_ENTRIES) {
    const oldestKey = resolutionCache.keys().next().value;
    if (oldestKey !== undefined) resolutionCache.delete(oldestKey);
  }
  resolutionCache.set(accessKey, {
    value,
    expiresAt: Date.now() + CACHE_TTL_MS,
  });
}

// Exposed for tests / ops tooling. Not used by the request path.
export function _clearAuthCache() {
  resolutionCache.clear();
}

// Resolve an access key to a `{ projectId, apiKeyId }` pair.
// Returns `null` for unknown keys; throws on upstream 5xx or DB infra errors
// so the caller can surface a 503.
export async function resolveAccessKey(accessKey) {
  if (!accessKey) return null;

  const cached = cacheGet(accessKey);
  if (cached !== undefined) return cached;

  const row = await lookupApiKeyRow(query, accessKey);
  if (row) {
    if (!row.project_id) {
      // Org-scoped key — not allowed on the grid (we need a project to
      // attribute concurrency / billing / sessions to).
      return null;
    }
    const value = {
      projectId: String(row.project_id),
      apiKeyId: row.id,
      source: "api_key",
    };
    cachePut(accessKey, value);
    return value;
  }

  if (accessKey.startsWith("tesbo_")) {
    const projectId = await resolveTesboKey(accessKey);
    if (!projectId) return null;
    const value = { projectId, apiKeyId: null, source: "tesbo_key" };
    cachePut(accessKey, value);
    return value;
  }

  return null;
}
