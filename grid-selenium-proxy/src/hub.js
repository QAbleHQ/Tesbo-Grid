import { config } from "./config.js";
import { logWarn } from "./logger.js";

// In-memory cache of seleniumId → nodeUri to avoid hammering the hub on every
// command captured by the proxy. Entries are short-lived because the dashboard
// calls vnc-routing endpoints rarely; commands hit the hub at most once per
// session lifetime to discover the node.
const nodeCache = new Map();
const NODE_CACHE_TTL_MS = 5 * 60 * 1000;

function cacheGet(seleniumId) {
  const entry = nodeCache.get(seleniumId);
  if (!entry) return null;
  if (entry.expiresAt < Date.now()) {
    nodeCache.delete(seleniumId);
    return null;
  }
  return entry.value;
}

function cachePut(seleniumId, value) {
  nodeCache.set(seleniumId, {
    value,
    expiresAt: Date.now() + NODE_CACHE_TTL_MS,
  });
}

export function clearNodeCacheEntry(seleniumId) {
  nodeCache.delete(seleniumId);
}

// Selenium 4 Hub exposes session metadata at:
//   GET /se/grid/api/session?session_id=<id>
// Older docs reference `/grid/api/session` (no `/se` prefix). We try the
// modern path first and fall back to the legacy one.
//
// Returns a string like `http://10.244.1.42:5555` (no path), or null on
// failure. Failures are *non-fatal* — VNC viewing simply won't work for
// that session until the hub finds the node.
export async function discoverNodeForSession(seleniumId) {
  if (!seleniumId) return null;
  const cached = cacheGet(seleniumId);
  if (cached) return cached;

  const hub = config.seleniumHubUrl.replace(/\/+$/, "");
  const candidates = [
    `${hub}/se/grid/api/session?session_id=${encodeURIComponent(seleniumId)}`,
    `${hub}/grid/api/session?session_id=${encodeURIComponent(seleniumId)}`,
  ];

  for (const url of candidates) {
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) continue;
      const json = await res.json().catch(() => null);
      const nodeUri = extractNodeUri(json);
      if (nodeUri) {
        cachePut(seleniumId, nodeUri);
        return nodeUri;
      }
    } catch (err) {
      logWarn("selenium_hub_node_lookup_failed", {
        error: err instanceof Error ? err.message : String(err),
        seleniumId,
      });
    }
  }
  return null;
}

// The hub returns one of several shapes depending on Selenium version. We
// normalise to `http://<host>:<port>` (no path) so the caller can swap the
// port for the noVNC listener.
//
// We deliberately do NOT fall back to `value.id` here: in Selenium 4's
// `/se/grid/api/session?session_id=<id>` response, `id` is the SESSION uuid
// (not a node URI). Treating it as a host produced bogus rows like
// `http://<uuid>:5555` and prevented `noVncWsUrlForNode` from finding the
// real node — which is the whole reason live VNC silently failed for
// otherwise-active sessions.
function extractNodeUri(json) {
  if (!json || typeof json !== "object") return null;
  const value = json.value || json;
  // Selenium 4: { value: { proxyId: "...", uri: "http://node:5555", ... } }
  // Some builds expose `nodeUri` instead of `uri` / `proxyId`.
  const raw = value.proxyId || value.uri || value.nodeUri;
  if (!raw || typeof raw !== "string") return null;
  try {
    const parsed = new URL(raw);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    // Some hubs return `tcp://host:port` or plain `host:port`.
    const m = String(raw).match(/^(?:[a-z]+:\/\/)?([^/:]+)(?::(\d+))?/i);
    if (m) {
      const host = m[1];
      const port = m[2] || "5555";
      return `http://${host}:${port}`;
    }
    return null;
  }
}

// Pull the upstream node address straight from a /wd/hub/session response.
//
// Selenium 4 nodes embed their VNC endpoint in the new-session capabilities:
//   se:vncEnabled:      true
//   se:noVncPort:       7900
//   se:vncLocalAddress: ws://10.108.9.72:7900
//   se:vnc:             ws://10.108.9.72:4444/session/<id>
//
// `se:vncLocalAddress` is exactly the host:port we want to tunnel to, so
// preferring it eliminates an entire class of failures where the secondary
// `/se/grid/api/session` lookup returned an unexpected shape (or hadn't
// indexed the session yet) and we ended up storing node_uri = NULL — which
// makes the dashboard show "Live view not available" indefinitely even
// though the session is running fine.
//
// Returns a parseable URL string suitable for storing in
// `selenium_sessions.node_uri`, or null if the response doesn't expose VNC.
export function extractNodeUriFromNewSessionResponse(json) {
  if (!json || typeof json !== "object") return null;
  const caps = json?.value?.capabilities;
  if (!caps || typeof caps !== "object") return null;
  // Some node configurations advertise vncEnabled=false (headless run, or
  // SE_NODE_GRID_URL doesn't enable noVNC). Don't manufacture a node_uri in
  // that case — the dashboard's "Live VNC may not be enabled" placeholder
  // is the correct UX.
  if (caps["se:vncEnabled"] === false) return null;
  const direct =
    typeof caps["se:vncLocalAddress"] === "string"
      ? caps["se:vncLocalAddress"]
      : null;
  if (direct) {
    try {
      const u = new URL(direct);
      if (u.hostname) return `${u.protocol}//${u.host}`;
    } catch {
      /* fall through */
    }
  }
  const fallback =
    typeof caps["se:vnc"] === "string" ? caps["se:vnc"] : null;
  if (fallback) {
    try {
      const u = new URL(fallback);
      if (u.hostname) {
        // `se:vnc` carries the hub's port (4444) rather than the node's
        // noVNC port; we only need the hostname — `noVncWsUrlForNode`
        // ignores the stored port and uses SELENIUM_NODE_VNC_PORT.
        return `${u.protocol === "wss:" ? "https:" : "http:"}//${u.hostname}`;
      }
    } catch {
      /* noop */
    }
  }
  return null;
}

// Helper: convert a node base URI (e.g. http://10.244.1.42:5555) into the
// noVNC websocket endpoint used by the selenium-node-* images
// (`<host>:7900/websockify`).
export function noVncWsUrlForNode(nodeUri) {
  if (!nodeUri) return null;
  try {
    const parsed = new URL(nodeUri);
    return `ws://${parsed.hostname}:${
      Number(process.env.SELENIUM_NODE_VNC_PORT || 7900)
    }/websockify`;
  } catch {
    return null;
  }
}
