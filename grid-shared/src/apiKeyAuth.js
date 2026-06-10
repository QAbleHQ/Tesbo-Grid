// Shared API-key auth helpers used by both grid-runner-api and grid-selenium-proxy.
//
// This file deliberately depends only on `node:crypto` and a `query(sql, params)`
// function the caller passes in — that lets each service plug in its own
// `pg`/Postgres pool without grid-shared having a hard dependency on `pg`.

import crypto from "node:crypto";

export function hashApiKey(key) {
  return crypto.createHash("sha256").update(String(key || "")).digest("hex");
}

// Scopes a `tesbo_*` access key is allowed to act under. These keys are
// resolved out-of-band against the grid-backend's project-by-key endpoint;
// the proxy / runner only needs to know which scopes they cover.
export const TESBO_KEY_SCOPES = new Set(["runs:write", "runs:read", "queue:read"]);

// Look up a `txe_*` key in the api_keys table.
// Returns `null` when the key is unknown / revoked.
//
// The `query` argument is `(sql, params) => Promise<{ rows: any[] }>` —
// this matches the shape used by `node-postgres`'s pool.query.
export async function lookupApiKeyRow(query, key) {
  const keyHash = hashApiKey(key);
  const { rows } = await query(
    `SELECT id, project_id, scopes, metadata_json
     FROM api_keys
     WHERE key_hash = $1 AND revoked_at IS NULL`,
    [keyHash]
  );
  return rows[0] || null;
}

// Resolve a tesbo_*-prefixed access key to a projectId by hitting the
// grid-backend project-by-key endpoint. Caller passes a `fetcher` (defaults to
// `globalThis.fetch`) and the backend URL.
//
// Returns `{ projectId }` on success or `null` when the key is invalid.
// Throws (with `upstreamStatus`) on 5xx so the caller can return 503.
export async function resolveProjectFromTesboKey(
  accessKey,
  { tesboApiUrl, fetcher = globalThis.fetch } = {}
) {
  if (!tesboApiUrl) return null;
  const endpoint = `${String(tesboApiUrl).replace(/\/+$/, "")}/api/tesbo-reports/project-by-key`;
  const response = await fetcher(endpoint, {
    method: "GET",
    headers: { "x-project-access-key": accessKey },
  });
  if (!response.ok) {
    if (response.status >= 500) {
      const err = new Error(`Auth service error: ${response.status}`);
      err.upstreamStatus = response.status;
      throw err;
    }
    return null;
  }
  const payload = await response.json().catch(() => ({}));
  const projectId = payload?.projectId ? String(payload.projectId) : null;
  return projectId ? { projectId } : null;
}

// Variant of resolveProjectFromTesboKey that returns the FULL backend payload
// (e.g. `{ projectId, limits }`) so callers like grid-selenium-proxy can pick
// up extra metadata (per-project session caps, etc.) without a second
// round-trip. Returns `null` for unknown keys; throws on 5xx.
export async function resolveTesboKeyPayload(
  accessKey,
  { tesboApiUrl, fetcher = globalThis.fetch } = {}
) {
  if (!tesboApiUrl) return null;
  const endpoint = `${String(tesboApiUrl).replace(/\/+$/, "")}/api/tesbo-reports/project-by-key`;
  const response = await fetcher(endpoint, {
    method: "GET",
    headers: { "x-project-access-key": accessKey },
  });
  if (!response.ok) {
    if (response.status >= 500) {
      const err = new Error(`Auth service error: ${response.status}`);
      err.upstreamStatus = response.status;
      throw err;
    }
    return null;
  }
  const payload = await response.json().catch(() => ({}));
  if (!payload?.projectId) return null;
  return { ...payload, projectId: String(payload.projectId) };
}

// Convenience: tiny TTL-cache wrapper around resolveProjectFromTesboKey so
// multiple consumers don't each have to hand-roll their own.
//
// Pass `onResolved(payload, { accessKey })` to receive the full backend
// payload (including limits) on every successful resolution — both fresh
// fetches and cache hits. This is how grid-selenium-proxy primes its
// project-limits cache without an extra HTTP round-trip per session-create.
export function createTesboKeyResolver({
  tesboApiUrl,
  fetcher = globalThis.fetch,
  ttlMs = 5 * 60 * 1000,
  onResolved,
} = {}) {
  const cache = new Map();
  return async function resolveCached(accessKey) {
    const cached = cache.get(accessKey);
    if (cached && Date.now() < cached.expiresAt) {
      if (typeof onResolved === "function") {
        try {
          onResolved(cached.payload, { accessKey });
        } catch {
          // Callback failures must never break the auth path.
        }
      }
      return cached.projectId;
    }
    const payload = await resolveTesboKeyPayload(accessKey, {
      tesboApiUrl,
      fetcher,
    });
    if (payload?.projectId) {
      cache.set(accessKey, {
        projectId: payload.projectId,
        payload,
        expiresAt: Date.now() + ttlMs,
      });
      if (typeof onResolved === "function") {
        try {
          onResolved(payload, { accessKey });
        } catch {
          // see above
        }
      }
      return payload.projectId;
    }
    return null;
  };
}
