import crypto from "node:crypto";
import { query } from "./db.js";
import { config } from "./config.js";
import { getEffectiveSessionCap } from "./projectLimits.js";
import { logError, logInfo, logWarn } from "./logger.js";

// W3C top-level capability fields we forward verbatim. Anything outside this
// list is dropped before the request leaves the proxy.
const ALLOWED_TOP_LEVEL_CAPS = new Set([
  "browserName",
  "browserVersion",
  "platformName",
  "acceptInsecureCerts",
  "pageLoadStrategy",
  "proxy",
  "timeouts",
  "strictFileInteractability",
  "unhandledPromptBehavior",
  "se:recordVideo",
]);

// Per-vendor option keys we allow through. The `binary` field is what lets a
// caller swap in their own browser executable, so we strip it on the way past.
const VENDOR_KEYS = ["goog:chromeOptions", "moz:firefoxOptions", "ms:edgeOptions"];

const ALLOWED_CHROME_KEYS = new Set([
  "args",
  "extensions",
  "prefs",
  "perfLoggingPrefs",
  "mobileEmulation",
  "windowTypes",
  "excludeSwitches",
]);
const ALLOWED_FIREFOX_KEYS = new Set(["args", "prefs", "log", "profile"]);
const ALLOWED_EDGE_KEYS = ALLOWED_CHROME_KEYS;

// Browser CLI flags we refuse to pass through. These either change the binary,
// disable the sandbox, or otherwise let the caller break out of the node.
const FORBIDDEN_ARGS = [
  /^--?user-data-dir/i,
  /^--?disable-web-security/i,
  /^--?no-sandbox/i,
  /^--?disable-setuid-sandbox/i,
  /^--?remote-debugging-pipe/i,
  /^--?load-extension/i,
];

function filterArgs(args) {
  if (!Array.isArray(args)) return [];
  return args.filter((arg) => {
    if (typeof arg !== "string") return false;
    return !FORBIDDEN_ARGS.some((pattern) => pattern.test(arg));
  });
}

function sanitiseVendorOptions(key, value) {
  if (!value || typeof value !== "object") return undefined;
  const allowedKeys =
    key === "moz:firefoxOptions"
      ? ALLOWED_FIREFOX_KEYS
      : key === "ms:edgeOptions"
      ? ALLOWED_EDGE_KEYS
      : ALLOWED_CHROME_KEYS;
  const cleaned = {};
  for (const [k, v] of Object.entries(value)) {
    if (!allowedKeys.has(k)) continue;
    if (k === "args") {
      cleaned.args = filterArgs(v);
    } else {
      cleaned[k] = v;
    }
  }
  return cleaned;
}

// Caps where an empty-string value would cause the Selenium Hub to queue the
// request forever (no slot has `browserVersion === ""`). The W3C spec treats
// these as exact-match strings, so an empty value matches nothing. Treating
// "" as "any" is the only sensible interpretation for clients passing through
// the proxy — so we drop these instead of forwarding the empty string.
const EXACT_MATCH_CAPS_DROP_IF_EMPTY = new Set(["browserVersion", "platformName"]);

function sanitiseCaps(caps) {
  if (!caps || typeof caps !== "object") return {};
  const cleaned = {};
  for (const [k, v] of Object.entries(caps)) {
    if (ALLOWED_TOP_LEVEL_CAPS.has(k)) {
      if (EXACT_MATCH_CAPS_DROP_IF_EMPTY.has(k) && (v === "" || v == null)) {
        continue;
      }
      cleaned[k] = v;
      continue;
    }
    if (VENDOR_KEYS.includes(k)) {
      const sanitised = sanitiseVendorOptions(k, v);
      if (sanitised) cleaned[k] = sanitised;
      continue;
    }
    // tesbo:options is read separately by the caller, then stripped here so
    // the Hub never sees it.
  }
  return cleaned;
}

// Top-level entry: pulls `tesbo:options`, sanitises every capabilities
// envelope, returns both the cleaned body and the extracted tesbo metadata.
export function sanitiseNewSessionBody(body) {
  if (!body || typeof body !== "object") {
    return { cleanedBody: body, tesboOptions: {}, sanitisedCaps: {} };
  }

  let tesboOptions = {};
  const cleanedBody = JSON.parse(JSON.stringify(body));

  if (cleanedBody.capabilities && typeof cleanedBody.capabilities === "object") {
    if (cleanedBody.capabilities.alwaysMatch) {
      tesboOptions = {
        ...tesboOptions,
        ...(cleanedBody.capabilities.alwaysMatch["tesbo:options"] || {}),
      };
      cleanedBody.capabilities.alwaysMatch = sanitiseCaps(
        cleanedBody.capabilities.alwaysMatch
      );
    }
    if (Array.isArray(cleanedBody.capabilities.firstMatch)) {
      cleanedBody.capabilities.firstMatch = cleanedBody.capabilities.firstMatch.map(
        (fm) => {
          tesboOptions = { ...tesboOptions, ...((fm || {})["tesbo:options"] || {}) };
          return sanitiseCaps(fm);
        }
      );
    }
  }

  if (cleanedBody.desiredCapabilities) {
    tesboOptions = {
      ...tesboOptions,
      ...(cleanedBody.desiredCapabilities["tesbo:options"] || {}),
    };
    cleanedBody.desiredCapabilities = sanitiseCaps(cleanedBody.desiredCapabilities);
  }

  // Strip access keys before storing — they're secrets.
  if (tesboOptions && typeof tesboOptions === "object") {
    const { accessKey, access_key, apiKey, ...rest } = tesboOptions;
    void accessKey;
    void access_key;
    void apiKey;
    tesboOptions = rest;
  }

  const sanitisedCaps =
    cleanedBody.capabilities?.alwaysMatch ||
    cleanedBody.desiredCapabilities ||
    {};

  return { cleanedBody, tesboOptions, sanitisedCaps };
}

// Active-session count for a project. Used to enforce per-project quota
// before we forward a `New Session` request to the Hub.
//
// Counts both `queued` (waiting for a node slot) and `active` (running on a
// node) so a misbehaving CI can't bypass the cap by spamming new requests
// while previous ones are still in the hub queue.
export async function countActiveSessions(projectId) {
  const { rows } = await query(
    `SELECT COUNT(*)::int AS count
     FROM selenium_sessions
     WHERE project_id = $1 AND status IN ('queued', 'active')`,
    [projectId]
  );
  return rows[0]?.count || 0;
}

// Resolve the effective concurrency cap for this project, then compare to the
// live `queued + active` count. Returns the cap and the current usage so the
// caller can put a useful number in the 429 message.
export async function evaluateProjectQuota(projectId) {
  const cap = await getEffectiveSessionCap(projectId);
  if (!cap || cap <= 0) {
    // 0 means unlimited — both for the global default and for an explicit
    // per-project override of 0.
    return { overQuota: false, cap: 0, active: null };
  }
  const active = await countActiveSessions(projectId);
  return { overQuota: active >= cap, cap, active };
}

// Back-compat shim: existing callers (and tests) only care about the boolean.
export async function isOverQuota(projectId) {
  const { overQuota } = await evaluateProjectQuota(projectId);
  return overQuota;
}

// Insert a `queued` placeholder row when the proxy first sees a New Session
// request. Returns the request_id so the caller can later upgrade the row
// with the real selenium_id once the hub assigns a slot.
//
// We insert BEFORE forwarding upstream so that:
//   * dashboard listings include sessions still waiting in the Selenium hub
//     queue (this used to be invisible — only 4-ish active rows showed up
//     even when 20+ parallel runs were queued behind SE_NODE_MAX_SESSIONS=4);
//   * concurrency caps count queued requests, preventing thundering-herd
//     when a CI starts a thousand tests at once.
export async function recordSessionQueued({
  projectId,
  apiKeyId,
  capabilities,
  tesboOptions,
}) {
  const requestId = crypto.randomUUID();
  try {
    await query(
      `INSERT INTO selenium_sessions
        (request_id, project_id, api_key_id, capabilities, tesbo_options,
         status, queued_at)
       VALUES ($1, $2, $3, $4, $5, 'queued', now())`,
      [
        requestId,
        projectId,
        apiKeyId,
        JSON.stringify(capabilities || {}),
        JSON.stringify(tesboOptions || {}),
      ]
    );
    logInfo("selenium_session_queued", { requestId, projectId, apiKeyId });
  } catch (err) {
    logError("selenium_session_queue_failed", {
      error: err instanceof Error ? err.message : String(err),
      requestId,
      projectId,
    });
    return null;
  }
  return requestId;
}

// Promote a queued row to `active` once the Selenium Hub has accepted the
// session and (optionally) we've discovered which node holds the slot.
//
// nodeUri is best-effort — if discovery fails we still mark the session as
// active (live VNC simply won't be available until the node is found later).
export async function recordSessionStart({
  requestId,
  seleniumId,
  projectId,
  apiKeyId,
  capabilities,
  tesboOptions,
  nodeUri = null,
}) {
  try {
    if (requestId) {
      await query(
        `UPDATE selenium_sessions
            SET selenium_id      = $2,
                status           = 'active',
                started_at       = now(),
                last_activity_at = now(),
                node_uri         = COALESCE($3, node_uri),
                capabilities     = $4,
                tesbo_options    = $5,
                api_key_id       = COALESCE($6, api_key_id)
          WHERE request_id       = $1`,
        [
          requestId,
          seleniumId,
          nodeUri,
          JSON.stringify(capabilities || {}),
          JSON.stringify(tesboOptions || {}),
          apiKeyId,
        ]
      );
    } else {
      await query(
        `INSERT INTO selenium_sessions
          (selenium_id, project_id, api_key_id, capabilities, tesbo_options,
           status, node_uri, last_activity_at)
         VALUES ($1, $2, $3, $4, $5, 'active', $6, now())
         ON CONFLICT (selenium_id) DO UPDATE
           SET project_id       = EXCLUDED.project_id,
               api_key_id       = EXCLUDED.api_key_id,
               capabilities     = EXCLUDED.capabilities,
               tesbo_options    = EXCLUDED.tesbo_options,
               node_uri         = COALESCE(EXCLUDED.node_uri, selenium_sessions.node_uri),
               status           = 'active',
               ended_at         = NULL,
               duration_ms      = NULL,
               end_reason       = NULL,
               last_activity_at = now()`,
        [
          seleniumId,
          projectId,
          apiKeyId,
          JSON.stringify(capabilities || {}),
          JSON.stringify(tesboOptions || {}),
          nodeUri,
        ]
      );
    }
    logInfo("selenium_session_started", {
      requestId,
      seleniumId,
      projectId,
      apiKeyId,
      nodeUri,
    });
  } catch (err) {
    logError("selenium_session_insert_failed", {
      error: err instanceof Error ? err.message : String(err),
      requestId,
      seleniumId,
      projectId,
    });
  }
}

// Mark a queued row as failed (e.g. hub returned 4xx/5xx, or upstream
// unreachable). We keep the row around so the dashboard can show the failure
// instead of silently dropping it.
export async function recordSessionFailed(requestId, reason) {
  if (!requestId) return;
  try {
    await query(
      `UPDATE selenium_sessions
          SET status      = 'failed',
              ended_at    = now(),
              duration_ms = GREATEST(0, EXTRACT(EPOCH FROM (now() - COALESCE(queued_at, started_at)))::int * 1000),
              end_reason  = $2
        WHERE request_id  = $1
          AND status      = 'queued'`,
      [requestId, String(reason || "upstream_error").slice(0, 200)]
    );
  } catch (err) {
    logError("selenium_session_fail_update_failed", {
      error: err instanceof Error ? err.message : String(err),
      requestId,
    });
  }
}

export async function recordSessionEnd(seleniumId, { reason = "client_quit" } = {}) {
  try {
    await query(
      `UPDATE selenium_sessions
         SET ended_at    = now(),
             duration_ms = GREATEST(0, EXTRACT(EPOCH FROM (now() - started_at))::int * 1000),
             status      = 'ended',
             end_reason  = $2
       WHERE selenium_id = $1 AND ended_at IS NULL`,
      [seleniumId, reason]
    );
    logInfo("selenium_session_ended", { seleniumId, reason });
  } catch (err) {
    logError("selenium_session_update_failed", {
      error: err instanceof Error ? err.message : String(err),
      seleniumId,
    });
  }
}

export async function getSessionRow(seleniumId) {
  const { rows } = await query(
    `SELECT id, selenium_id, project_id, api_key_id, status, node_uri
     FROM selenium_sessions
     WHERE selenium_id = $1`,
    [seleniumId]
  );
  return rows[0] || null;
}

// Update node_uri after the fact (e.g. when we discover it from the hub on
// the first proxied command rather than at start time).
export async function setSessionNodeUri(seleniumId, nodeUri) {
  if (!seleniumId || !nodeUri) return;
  try {
    await query(
      `UPDATE selenium_sessions
          SET node_uri = $2
        WHERE selenium_id = $1
          AND (node_uri IS NULL OR node_uri <> $2)`,
      [seleniumId, nodeUri]
    );
  } catch (err) {
    logWarn("selenium_session_node_uri_update_failed", {
      error: err instanceof Error ? err.message : String(err),
      seleniumId,
    });
  }
}

// ---- Command tail ----------------------------------------------------------
//
// The proxy logs every WebDriver command that flows past it so the dashboard
// can show what the test is currently doing. Storage is bounded:
//   * Each row holds heavily truncated request/response bodies.
//   * After every insert we delete everything beyond the most recent
//     MAX_LIVE_COMMANDS_PER_SESSION rows for that session.
//
// `sequence` is monotonic-per-session, assigned by counting existing rows; it
// makes the dashboard's "since last seen" polling cheap and order-stable even
// when occurred_at ties at the millisecond.

const MAX_LIVE_COMMANDS_PER_SESSION = Number(
  process.env.SELENIUM_MAX_LIVE_COMMANDS_PER_SESSION || 500
);
const MAX_LIVE_COMMAND_BODY_BYTES = Number(
  process.env.SELENIUM_MAX_LIVE_COMMAND_BODY_BYTES || 4 * 1024
);

export function summariseCommandBody(buffer) {
  if (!buffer || (Buffer.isBuffer(buffer) && buffer.length === 0)) return null;
  const raw = Buffer.isBuffer(buffer) ? buffer : Buffer.from(String(buffer));
  if (raw.length === 0) return null;
  // Try to decode as utf8 JSON for readable storage; fall back to a
  // `[binary, N bytes]` placeholder so we never persist a screenshot blob.
  const text = raw.toString("utf8");
  // Heuristic: if non-printable ratio is high, treat as binary.
  let nonPrintable = 0;
  for (let i = 0; i < Math.min(text.length, 256); i++) {
    const code = text.charCodeAt(i);
    if (code === 0xfffd || (code < 32 && code !== 9 && code !== 10 && code !== 13)) {
      nonPrintable++;
    }
  }
  if (nonPrintable > 16) {
    return `[binary ${raw.length} bytes]`;
  }
  if (raw.length > MAX_LIVE_COMMAND_BODY_BYTES) {
    return text.slice(0, MAX_LIVE_COMMAND_BODY_BYTES) +
      `…[truncated ${raw.length - MAX_LIVE_COMMAND_BODY_BYTES} bytes]`;
  }
  return text;
}

// Map a WebDriver URL to a friendly command label. Keeps the dashboard list
// readable without forcing the UI to know the W3C URL grammar.
export function deriveCommandName(method, path) {
  const m = (method || "").toUpperCase();
  const p = String(path || "").replace(/\/+$/, "");
  if (!p || p === "/") return m === "DELETE" ? "deleteSession" : "session";
  // Trim leading slash and split.
  const parts = p.replace(/^\/+/, "").split("/");
  // Most webdriver paths are `<verb-noun>` pairs, e.g. `element/<id>/click`.
  // We try to compose the most descriptive trailing segment.
  const tail = parts[parts.length - 1];
  const prevTail = parts.length >= 2 ? parts[parts.length - 2] : "";
  if (m === "POST" && tail === "url") return "navigateTo";
  if (m === "GET" && tail === "url") return "getCurrentUrl";
  if (m === "POST" && tail === "element") return "findElement";
  if (m === "POST" && tail === "elements") return "findElements";
  if (m === "POST" && tail === "click") return "click";
  if (m === "POST" && tail === "clear") return "clear";
  if (m === "POST" && tail === "value") return "sendKeys";
  if (m === "GET" && tail === "text") return "getText";
  if (m === "GET" && tail === "screenshot") return "takeScreenshot";
  if (m === "POST" && tail === "execute") return prevTail === "async" ? "executeAsyncScript" : "executeScript";
  if (m === "POST" && tail === "sync" && prevTail === "execute") return "executeScript";
  if (m === "POST" && tail === "async" && prevTail === "execute") return "executeAsyncScript";
  if (m === "POST" && tail === "back") return "back";
  if (m === "POST" && tail === "forward") return "forward";
  if (m === "POST" && tail === "refresh") return "refresh";
  if (m === "GET" && tail === "title") return "getTitle";
  if (m === "GET" && tail === "source") return "getPageSource";
  if (m === "GET" && tail === "cookie") return "getAllCookies";
  if (m === "POST" && tail === "cookie") return "addCookie";
  if (m === "DELETE" && tail === "cookie") return "deleteAllCookies";
  if (m === "GET" && tail === "rect") return "getElementRect";
  if (m === "GET" && tail === "displayed") return "isDisplayed";
  if (m === "GET" && tail === "enabled") return "isEnabled";
  if (m === "GET" && tail === "selected") return "isSelected";
  return `${m.toLowerCase()} ${tail}`;
}

export async function recordCommand({
  seleniumId,
  method,
  path,
  status,
  durationMs,
  requestBody,
  responseBody,
  error,
}) {
  if (!seleniumId) return;
  try {
    await query(
      `INSERT INTO selenium_session_commands
         (selenium_id, sequence, method, path, command, status, duration_ms,
          request_body, response_body, error)
       VALUES (
          $1,
          COALESCE(
            (SELECT MAX(sequence) FROM selenium_session_commands WHERE selenium_id = $1),
            0
          ) + 1,
          $2, $3, $4, $5, $6, $7, $8, $9
       )`,
      [
        seleniumId,
        method,
        path,
        deriveCommandName(method, path),
        status ?? null,
        Number.isFinite(durationMs) ? Math.max(0, Math.floor(durationMs)) : null,
        summariseCommandBody(requestBody),
        summariseCommandBody(responseBody),
        error ? String(error).slice(0, 500) : null,
      ]
    );
    // Trim ring buffer.
    await query(
      `DELETE FROM selenium_session_commands
        WHERE selenium_id = $1
          AND id NOT IN (
            SELECT id FROM selenium_session_commands
             WHERE selenium_id = $1
             ORDER BY sequence DESC
             LIMIT $2
          )`,
      [seleniumId, MAX_LIVE_COMMANDS_PER_SESSION]
    );

    // Touch the parent session so the cleanup sweep treats it as alive.
    // We deliberately keep this in a separate UPDATE rather than a trigger
    // so a missing column on an old DB still lets the proxy log commands.
    await query(
      `UPDATE selenium_sessions
          SET last_activity_at = now()
        WHERE selenium_id = $1
          AND status = 'active'`,
      [seleniumId]
    );
  } catch (err) {
    // Non-fatal — never break the WebDriver flow because logging failed.
    logWarn("selenium_command_log_failed", {
      error: err instanceof Error ? err.message : String(err),
      seleniumId,
    });
  }
}

// Periodic sweep — flips long-idle sessions to `abandoned`. Lets us reclaim
// concurrency slots when a user CI process dies without sending a
// `DELETE /session/{id}`.
//
// Idleness is measured from `last_activity_at` (bumped on every captured
// WebDriver command), NOT `started_at`. The old behaviour reaped sessions
// based on age — so a long test got killed at the timeout even though it
// was actively running, while a test that crashed 30 seconds in stayed
// `active` for the full timeout window. Using last-activity also drops the
// sensible default to ~3 minutes without breaking long-running flows,
// which keeps the dashboard's live count honest.
export function startCleanupTimer() {
  const interval = Math.max(5_000, config.cleanupIntervalMs);
  const timer = setInterval(async () => {
    try {
      const { rowCount } = await query(
        `UPDATE selenium_sessions
           SET status      = 'abandoned',
               ended_at    = now(),
               duration_ms = GREATEST(0, EXTRACT(EPOCH FROM (now() - started_at))::int * 1000),
               end_reason  = 'idle_timeout'
         WHERE status      = 'active'
           AND COALESCE(last_activity_at, started_at)
                 < now() - INTERVAL '1 millisecond' * $1`,
        [config.sessionIdleTimeoutMs]
      );
      if (rowCount > 0) {
        logWarn("selenium_session_idle_swept", { count: rowCount });
      }
      // Also expire `queued` sessions that never got a slot — usually means
      // the upstream hub crashed mid-request. Use a shorter timeout (the
      // hub's own newSessionTimeout) — but here we just key off the proxy
      // timeout setting.
      const queuedTimeout = Math.max(60_000, config.proxyTimeoutMs);
      const { rowCount: queuedSwept } = await query(
        `UPDATE selenium_sessions
           SET status      = 'failed',
               ended_at    = now(),
               duration_ms = GREATEST(0, EXTRACT(EPOCH FROM (now() - queued_at))::int * 1000),
               end_reason  = 'queue_timeout'
         WHERE status      = 'queued'
           AND queued_at   < now() - INTERVAL '1 millisecond' * $1`,
        [queuedTimeout]
      );
      if (queuedSwept > 0) {
        logWarn("selenium_session_queue_swept", { count: queuedSwept });
      }
    } catch (err) {
      logError("selenium_session_sweep_failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }, interval);
  timer.unref?.();
  return timer;
}
