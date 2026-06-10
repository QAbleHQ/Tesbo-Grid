import http from "node:http";
import express from "express";
import httpProxy from "http-proxy";
import net from "node:net";
import { URL } from "node:url";
import { config } from "./config.js";
import { logError, logInfo, logWarn } from "./logger.js";
import { extractCredentials, resolveAccessKey } from "./auth.js";
import {
  sanitiseNewSessionBody,
  evaluateProjectQuota,
  recordSessionQueued,
  recordSessionStart,
  recordSessionFailed,
  recordSessionEnd,
  recordCommand,
  setSessionNodeUri,
  getSessionRow,
  startCleanupTimer,
} from "./sessions.js";
import {
  discoverNodeForSession,
  extractNodeUriFromNewSessionResponse,
  noVncWsUrlForNode,
  clearNodeCacheEntry,
} from "./hub.js";

// Selenium 4 standalone listens on `/wd/hub/session` (and historically `/session`).
// We accept both prefixes.
const NEW_SESSION_PATH = /^\/(?:wd\/hub\/)?session\/?$/;
const SESSION_ID_PATH = /^\/(?:wd\/hub\/)?session\/([^/]+)(?:\/.*)?$/;
// Live VNC tunnel (WebSocket only). The frontend opens this through grid-backend
// which adds the internal shared token.
const VNC_PATH = /^\/sessions\/([^/]+)\/vnc\/?$/;
const HEALTH_PATHS = new Set(["/health", "/status"]);

const PASSTHROUGH_HEADERS = [
  "content-type",
  "cache-control",
  "x-request-id",
];

// Capping captured request bodies at 64 KiB keeps screenshots / file uploads
// out of Postgres while preserving the small JSON payloads that webdriver
// commands actually send. Larger payloads still get forwarded to the hub
// untouched — only the *captured* copy is truncated.
const MAX_CAPTURED_BODY_BYTES = 64 * 1024;

// Selenium Grid embeds the Node's INTERNAL pod address in the new-session
// response (e.g. `se:cdp: ws://10.108.x.y:4444/session/.../cdp` and the W3C
// `webSocketUrl`). External clients reaching the Grid through this proxy
// cannot route to that cluster-internal CIDR, so the Selenium 4 client opens
// the BiDi/CDP WebSocket to an unreachable host, times out after ~30s, and
// surfaces "RemoteWebDriver session creation failed" — even though the
// session itself was created successfully on the Node.
//
// Stripping these fields tells the client "no BiDi/CDP available", which is
// the correct view for a public client. Tests that rely on plain WebDriver
// HTTP (the vast majority) keep working transparently. Customers who need
// CDP must use the in-cluster service URL or run their tests as Tesbo
// workers (which have direct pod-IP routing).
const WEBSOCKET_CAP_KEYS_TO_DROP = [
  "se:cdp",
  "se:cdpVersion",
  "se:bidi",
  "webSocketUrl",
];

function stripUnreachableWebSocketCaps(payload) {
  if (!payload || typeof payload !== "object") return payload;
  const caps = payload?.value?.capabilities;
  if (!caps || typeof caps !== "object") return payload;
  for (const key of WEBSOCKET_CAP_KEYS_TO_DROP) {
    if (key in caps) {
      delete caps[key];
    }
  }
  if (caps["se:bidiEnabled"] === true) {
    caps["se:bidiEnabled"] = false;
  }
  return payload;
}

function send(res, status, body) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
}

// Returns true for errors that look like backend-infra failures (Postgres
// connection-pool exhaustion, network blips, upstream 5xx) — i.e. things the
// client should retry rather than treat as a permanent auth/config problem.
//
// Postgres errors carry a SQLSTATE in `code` (e.g. "53300" for
// too_many_connections). Node net errors carry codes like ECONNREFUSED /
// ETIMEDOUT. Anything with a `code` here is operational, not "your key is
// wrong", so we surface a retryable 503 instead of a misleading 401.
function isInfraError(err) {
  if (!err) return false;
  if (Number(err.upstreamStatus) >= 500) return true;
  if (typeof err.code === "string" && err.code.length > 0) return true;
  return false;
}

function readJsonBody(req, limit = 4 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let total = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > limit) {
        reject(new Error("Body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks);
      if (!raw.length) return resolve({ raw, body: null });
      try {
        resolve({ raw, body: JSON.parse(raw.toString("utf8")) });
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

function readRawBody(req, limit = 16 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let total = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > limit) {
        reject(new Error("Body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function handleNewSession(req, res) {
  let parsed;
  try {
    parsed = await readJsonBody(req);
  } catch {
    return send(res, 400, { error: "Invalid JSON body" });
  }

  const body = parsed.body;
  const creds = extractCredentials(req, body);
  if (!creds) {
    return send(res, 401, {
      error:
        "Authentication required. Provide basic-auth, x-api-key, or tesbo:options.accessKey.",
    });
  }

  let resolved;
  try {
    resolved = await resolveAccessKey(creds.accessKey);
  } catch (err) {
    if (isInfraError(err)) {
      logWarn("selenium_proxy_auth_infra_error", {
        error: err instanceof Error ? err.message : String(err),
        code: err?.code,
      });
      return send(res, 503, {
        error: "Auth service temporarily unavailable, please retry",
      });
    }
    return send(res, 401, { error: "Invalid API key" });
  }
  if (!resolved) {
    return send(res, 401, { error: "Invalid API key" });
  }
  if (creds.declaredProjectId && creds.declaredProjectId !== resolved.projectId) {
    return send(res, 403, {
      error: "API key does not belong to the declared projectId",
    });
  }

  let quota;
  try {
    quota = await evaluateProjectQuota(resolved.projectId);
  } catch (err) {
    if (isInfraError(err)) {
      logWarn("selenium_proxy_quota_infra_error", {
        error: err instanceof Error ? err.message : String(err),
        code: err?.code,
        projectId: resolved.projectId,
      });
      return send(res, 503, {
        error: "Quota check temporarily unavailable, please retry",
      });
    }
    throw err;
  }
  if (quota.overQuota) {
    // Surface the *actual* cap that's blocking the request (per-project
    // override OR the global default), plus the live count, so callers can
    // tell at a glance whether they need to bump the dashboard setting or
    // wait for in-flight sessions to drain.
    return send(res, 429, {
      error: `Concurrent session limit reached (${quota.cap})`,
      limit: quota.cap,
      active: quota.active,
    });
  }

  const { cleanedBody, tesboOptions, sanitisedCaps } = sanitiseNewSessionBody(body);

  // Insert a `queued` row BEFORE we await the hub so the dashboard can
  // immediately see "N sessions waiting for a node slot" — without this the
  // dashboard appeared frozen at SE_NODE_MAX_SESSIONS active rows even when
  // dozens more were piled up in the hub queue.
  const requestId = await recordSessionQueued({
    projectId: resolved.projectId,
    apiKeyId: resolved.apiKeyId,
    capabilities: sanitisedCaps,
    tesboOptions,
  });

  const upstreamUrl = `${config.seleniumHubUrl.replace(/\/+$/, "")}/wd/hub/session`;

  let upstream;
  try {
    upstream = await fetch(upstreamUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify(cleanedBody || {}),
      signal: AbortSignal.timeout(config.proxyTimeoutMs),
    });
  } catch (err) {
    logError("selenium_new_session_upstream_failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    await recordSessionFailed(requestId, "hub_unreachable");
    return send(res, 502, { error: "Selenium hub unreachable" });
  }

  const upstreamText = await upstream.text();
  let upstreamJson = null;
  try {
    upstreamJson = upstreamText ? JSON.parse(upstreamText) : null;
  } catch {
    // Upstream returned non-JSON (rare); we'll forward as-is.
  }

  res.statusCode = upstream.status;
  for (const header of PASSTHROUGH_HEADERS) {
    const value = upstream.headers.get(header);
    if (value) res.setHeader(header, value);
  }
  if (!res.getHeader("content-type")) res.setHeader("content-type", "application/json");

  if (upstream.ok && upstreamJson) {
    const seleniumId =
      upstreamJson?.value?.sessionId || upstreamJson?.sessionId || null;
    if (seleniumId) {
      // Selenium 4 nodes embed their VNC endpoint in the new-session
      // capabilities (`se:vncLocalAddress`). Reading it from the response
      // we already have is the most reliable signal — the upstream grid
      // API can race the session, return an unexpected shape, or omit
      // `uri` entirely on some builds, all of which used to leave node_uri
      // NULL and surface a misleading "Live VNC may not be enabled in
      // your cluster" on the dashboard. Fall back to the grid API only
      // when the response didn't carry VNC info.
      let nodeUri = extractNodeUriFromNewSessionResponse(upstreamJson);
      if (!nodeUri) {
        try {
          nodeUri = await discoverNodeForSession(seleniumId);
        } catch {
          nodeUri = null;
        }
      }
      await recordSessionStart({
        requestId,
        seleniumId,
        projectId: resolved.projectId,
        apiKeyId: resolved.apiKeyId,
        capabilities: sanitisedCaps,
        tesboOptions,
        nodeUri,
      });
    } else {
      logWarn("selenium_new_session_no_id", {
        status: upstream.status,
        projectId: resolved.projectId,
      });
      await recordSessionFailed(requestId, "missing_session_id");
    }
  } else if (upstream.status >= 400) {
    logWarn("selenium_new_session_upstream_error", {
      status: upstream.status,
      projectId: resolved.projectId,
    });
    await recordSessionFailed(requestId, `hub_status_${upstream.status}`);
  }

  // Rewrite the response body so the client never sees the cluster-internal
  // BiDi/CDP WebSocket URLs. See `stripUnreachableWebSocketCaps` for why.
  let responseBody = upstreamText;
  if (upstream.ok && upstreamJson) {
    stripUnreachableWebSocketCaps(upstreamJson);
    responseBody = JSON.stringify(upstreamJson);
    res.setHeader("content-length", Buffer.byteLength(responseBody));
  }
  res.end(responseBody);
}

async function authoriseSessionRequest(req, res, seleniumId) {
  const creds = extractCredentials(req, null);
  if (!creds) {
    send(res, 401, { error: "Authentication required" });
    return null;
  }
  let resolved;
  try {
    resolved = await resolveAccessKey(creds.accessKey);
  } catch (err) {
    if (isInfraError(err)) {
      logWarn("selenium_proxy_auth_infra_error", {
        error: err instanceof Error ? err.message : String(err),
        code: err?.code,
      });
      send(res, 503, { error: "Auth service temporarily unavailable" });
      return null;
    }
    send(res, 401, { error: "Invalid API key" });
    return null;
  }
  if (!resolved) {
    send(res, 401, { error: "Invalid API key" });
    return null;
  }
  let row;
  try {
    row = await getSessionRow(seleniumId);
  } catch (err) {
    if (isInfraError(err)) {
      logWarn("selenium_proxy_session_lookup_infra_error", {
        error: err instanceof Error ? err.message : String(err),
        code: err?.code,
        seleniumId,
      });
      send(res, 503, { error: "Session lookup temporarily unavailable" });
      return null;
    }
    throw err;
  }
  if (!row) {
    send(res, 404, { error: "Session not found" });
    return null;
  }
  if (String(row.project_id) !== String(resolved.projectId)) {
    send(res, 403, { error: "Session belongs to a different project" });
    return null;
  }
  return { resolved, row };
}

// Forward a per-session WebDriver command to the hub via fetch() so we can
// capture method/path/status/duration into selenium_session_commands.
//
// Why not use http-proxy here? It's stream-based and would force us to
// duplicate the response stream, which races with the live session timing
// budget. fetch() buffers the response (typical webdriver responses are
// small JSON), making accurate duration measurement and body summarisation
// trivial. Large responses (screenshots) are capped via MAX_CAPTURED_BODY_BYTES
// for the *captured* copy only — the full response is still forwarded to the
// client.
async function forwardSessionCommand(req, res, seleniumId, urlPath) {
  const startedAt = Date.now();
  const upstream = `${config.seleniumHubUrl.replace(/\/+$/, "")}${urlPath}`;
  const method = req.method || "GET";

  // Read request body so we can both forward it and capture a summary.
  let bodyBuffer = null;
  try {
    if (method !== "GET" && method !== "HEAD" && method !== "DELETE") {
      bodyBuffer = await readRawBody(req);
    }
  } catch (err) {
    return send(res, 413, {
      error: err instanceof Error ? err.message : "Body too large",
    });
  }

  // Pass through a minimal set of headers — webdriver clients may set
  // content-type, accept, user-agent.
  const upstreamHeaders = {};
  for (const name of ["content-type", "accept", "user-agent", "x-request-id"]) {
    const v = req.headers[name];
    if (v) upstreamHeaders[name] = Array.isArray(v) ? v[0] : v;
  }

  let upstreamRes;
  let upstreamErr;
  try {
    upstreamRes = await fetch(upstream, {
      method,
      headers: upstreamHeaders,
      body: bodyBuffer && bodyBuffer.length ? bodyBuffer : undefined,
      signal: AbortSignal.timeout(config.proxyTimeoutMs),
    });
  } catch (err) {
    upstreamErr = err;
  }

  const durationMs = Date.now() - startedAt;
  const pathAfterSession = urlPath
    .replace(/^\/(?:wd\/hub\/)?session\/[^/]+/, "")
    || "/";

  if (upstreamErr) {
    // Don't await the log write — failing to log must never delay the
    // error response.
    void recordCommand({
      seleniumId,
      method,
      path: pathAfterSession,
      status: 502,
      durationMs,
      requestBody: bodyBuffer && bodyBuffer.length <= MAX_CAPTURED_BODY_BYTES
        ? bodyBuffer
        : Buffer.from(`[oversize ${bodyBuffer?.length || 0} bytes]`),
      responseBody: null,
      error: upstreamErr instanceof Error ? upstreamErr.message : String(upstreamErr),
    });
    return send(res, 502, { error: "Selenium hub unreachable" });
  }

  const upstreamBody = Buffer.from(await upstreamRes.arrayBuffer());

  // Mirror status, content-type and a few cache-friendly headers.
  res.statusCode = upstreamRes.status;
  for (const name of ["content-type", "cache-control", "x-request-id"]) {
    const v = upstreamRes.headers.get(name);
    if (v) res.setHeader(name, v);
  }
  if (!res.getHeader("content-type")) {
    res.setHeader("content-type", "application/json");
  }
  res.end(upstreamBody);

  // Async fire-and-forget: persist the captured command. Truncate before
  // sending to the DB layer.
  const capturedRequest =
    bodyBuffer && bodyBuffer.length
      ? bodyBuffer.length <= MAX_CAPTURED_BODY_BYTES
        ? bodyBuffer
        : Buffer.from(`[oversize ${bodyBuffer.length} bytes]`)
      : null;
  const capturedResponse =
    upstreamBody.length <= MAX_CAPTURED_BODY_BYTES
      ? upstreamBody
      : Buffer.from(`[oversize ${upstreamBody.length} bytes]`);

  void recordCommand({
    seleniumId,
    method,
    path: pathAfterSession,
    status: upstreamRes.status,
    durationMs,
    requestBody: capturedRequest,
    responseBody: capturedResponse,
    error: upstreamRes.ok ? null : `status_${upstreamRes.status}`,
  });

  // Lazily cache the node URI on first command in case discovery failed at
  // session-start time — handy when the node took an extra moment to register
  // with the hub.
  if (upstreamRes.ok) {
    void (async () => {
      try {
        const fresh = await discoverNodeForSession(seleniumId);
        if (fresh) await setSessionNodeUri(seleniumId, fresh);
      } catch {
        /* noop */
      }
    })();
  }
}

// Authorise a VNC WebSocket upgrade. Distinct from authoriseSessionRequest
// because the request comes through grid-backend with the internal shared
// token rather than a webdriver API key — only grid-backend has access to it.
async function authoriseVncUpgrade(req) {
  const token =
    req.headers["x-internal-token"] ||
    req.headers["x-agent-token"] ||
    "";
  const expected = process.env.INTERNAL_SHARED_TOKEN || "";
  if (!expected || !token || String(token) !== String(expected)) {
    return { error: 401 };
  }
  return { ok: true };
}

export function createServer() {
  const proxy = httpProxy.createProxyServer({
    target: config.seleniumHubUrl,
    changeOrigin: true,
    ws: true,
    proxyTimeout: config.proxyTimeoutMs,
    timeout: config.proxyTimeoutMs,
  });

  proxy.on("error", (err, _req, res) => {
    logError("selenium_proxy_upstream_error", {
      error: err instanceof Error ? err.message : String(err),
    });
    if (res && !res.headersSent && typeof res.writeHead === "function") {
      send(res, 502, { error: "Selenium hub unreachable" });
    } else if (res && typeof res.end === "function") {
      try {
        res.end();
      } catch {
        /* noop */
      }
    }
  });

  const healthApp = express();
  healthApp.disable("x-powered-by");
  healthApp.get(["/health", "/status"], (_req, res) => {
    res.json({ status: "ok", service: "tesbox-grid-selenium-proxy" });
  });

  const server = http.createServer(async (req, res) => {
    try {
      const url = req.url || "/";

      if (HEALTH_PATHS.has(url.split("?")[0])) {
        healthApp(req, res);
        return;
      }

      if (req.method === "POST" && NEW_SESSION_PATH.test(url)) {
        // Must `await` so the surrounding try/catch sees rejections.
        // Without this, a thrown error escapes as an unhandled rejection and
        // the client hangs waiting for a response that never arrives.
        await handleNewSession(req, res);
        return;
      }

      const sessionMatch = url.match(SESSION_ID_PATH);
      if (sessionMatch) {
        const seleniumId = sessionMatch[1];
        const ok = await authoriseSessionRequest(req, res, seleniumId);
        if (!ok) return;

        if (
          req.method === "DELETE" &&
          /^\/(?:wd\/hub\/)?session\/[^/]+\/?$/.test(url)
        ) {
          // Mark ended *before* forwarding so concurrency frees up even if
          // the Hub is slow to respond. Also drop the cached node URI so a
          // subsequent session reusing the id (rare but possible) re-resolves.
          await recordSessionEnd(seleniumId, { reason: "client_quit" });
          clearNodeCacheEntry(seleniumId);
        }

        // Forward the command via fetch() so we can capture it for the
        // dashboard's live commands view. We deliberately do NOT capture
        // the DELETE-session response body (it's just `{value: null}`)
        // beyond status/duration.
        await forwardSessionCommand(req, res, seleniumId, url);
        return;
      }

      // Anything else (e.g. /grid/api, /downloads) is treated as informational
      // and forwarded without auth.
      proxy.web(req, res, { target: config.seleniumHubUrl });
    } catch (err) {
      logError("selenium_proxy_unhandled", {
        error: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      });
      if (!res.headersSent) {
        send(res, 500, { error: "Internal proxy error" });
      } else {
        res.end();
      }
    }
  });

  server.on("upgrade", async (req, socket, head) => {
    try {
      const rawUrl = req.url || "/";
      const url = new URL(rawUrl, "http://placeholder");
      const vncMatch = url.pathname.match(VNC_PATH);
      if (vncMatch) {
        await handleVncUpgrade(req, socket, head, vncMatch[1]);
        return;
      }

      const sessionMatch = url.pathname.match(SESSION_ID_PATH);
      if (!sessionMatch) {
        socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
        socket.destroy();
        return;
      }
      const seleniumId = sessionMatch[1];
      const creds = extractCredentials(req, null);
      if (!creds) {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }
      let resolved;
      try {
        resolved = await resolveAccessKey(creds.accessKey);
      } catch {
        socket.write("HTTP/1.1 503 Service Unavailable\r\n\r\n");
        socket.destroy();
        return;
      }
      if (!resolved) {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }
      const row = await getSessionRow(seleniumId);
      if (!row || String(row.project_id) !== String(resolved.projectId)) {
        socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
        socket.destroy();
        return;
      }
      proxy.ws(req, socket, head, { target: config.seleniumHubUrl });
    } catch (err) {
      logError("selenium_proxy_ws_error", {
        error: err instanceof Error ? err.message : String(err),
      });
      try {
        socket.destroy();
      } catch {
        /* noop */
      }
    }
  });

  startCleanupTimer();

  return { server, proxy };
}

// ----- Live VNC tunnel ------------------------------------------------------
//
// grid-backend opens a websocket here using INTERNAL_SHARED_TOKEN; we look
// up the node holding the session and pipe the websocket bytes directly to
// the node's noVNC `/websockify` listener (port 7900 by default).
//
// We use a raw TCP socket pipe rather than `proxy.ws()` because the upstream
// is a *different host* than `config.seleniumHubUrl` — http-proxy expects a
// fixed target. Doing the upgrade by hand is also faster (no extra HTTP
// reparsing) and lets us swap port 5555→7900 without recreating a proxy.
async function handleVncUpgrade(req, socket, head, seleniumId) {
  // Auth.
  const auth = await authoriseVncUpgrade(req);
  if (!auth.ok) {
    socket.write(`HTTP/1.1 ${auth.error} Unauthorized\r\n\r\n`);
    socket.destroy();
    return;
  }

  let row;
  try {
    row = await getSessionRow(seleniumId);
  } catch {
    socket.write("HTTP/1.1 503 Service Unavailable\r\n\r\n");
    socket.destroy();
    return;
  }
  if (!row) {
    socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
    socket.destroy();
    return;
  }
  if (row.status !== "active") {
    socket.write("HTTP/1.1 409 Conflict\r\n\r\n");
    socket.destroy();
    return;
  }

  let nodeUri = row.node_uri;
  if (!nodeUri) {
    nodeUri = await discoverNodeForSession(seleniumId);
    if (nodeUri) await setSessionNodeUri(seleniumId, nodeUri);
  }
  if (!nodeUri) {
    socket.write("HTTP/1.1 502 Bad Gateway\r\n\r\n");
    socket.destroy();
    return;
  }

  const wsUrl = noVncWsUrlForNode(nodeUri);
  if (!wsUrl) {
    socket.write("HTTP/1.1 502 Bad Gateway\r\n\r\n");
    socket.destroy();
    return;
  }
  let parsed;
  try {
    parsed = new URL(wsUrl);
  } catch {
    socket.write("HTTP/1.1 502 Bad Gateway\r\n\r\n");
    socket.destroy();
    return;
  }

  // Open a TCP connection to the node and replay the upgrade request so the
  // node's websockify accepts the WebSocket handshake. Headers are minimal
  // and explicit — we only forward what's needed for an RFB-over-WS upgrade.
  const upstream = net.createConnection({
    host: parsed.hostname,
    port: Number(parsed.port),
  });

  let settled = false;
  const cleanup = (err) => {
    if (settled) return;
    settled = true;
    if (err) {
      logWarn("selenium_vnc_pipe_error", {
        error: err instanceof Error ? err.message : String(err),
        seleniumId,
      });
    }
    try { upstream.destroy(); } catch { /* noop */ }
    try { socket.destroy(); } catch { /* noop */ }
  };

  upstream.on("error", cleanup);
  socket.on("error", cleanup);
  upstream.on("close", () => cleanup());
  socket.on("close", () => cleanup());

  upstream.once("connect", () => {
    const wsKey = req.headers["sec-websocket-key"] || "";
    const wsVersion = req.headers["sec-websocket-version"] || "13";
    const wsProto = req.headers["sec-websocket-protocol"] || "binary";
    const lines = [
      `GET ${parsed.pathname || "/websockify"} HTTP/1.1`,
      `Host: ${parsed.host}`,
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Key: ${wsKey}`,
      `Sec-WebSocket-Version: ${wsVersion}`,
      `Sec-WebSocket-Protocol: ${wsProto}`,
      "Origin: tesbo-grid-proxy",
      "",
      "",
    ];
    upstream.write(lines.join("\r\n"));
    if (head && head.length) upstream.write(head);
    // Now pipe bytes both ways — the upstream replies with the 101 Switching
    // Protocols handshake which the browser's WS client consumes directly.
    upstream.pipe(socket);
    socket.pipe(upstream);
  });

  // If the node doesn't connect within a few seconds, give up.
  setTimeout(() => {
    if (!upstream.connecting && upstream.destroyed) return;
    if (!settled && upstream.connecting) {
      cleanup(new Error("VNC upstream connect timeout"));
    }
  }, 8000).unref?.();
}

export function startServer() {
  const { server } = createServer();
  server.listen(config.port, () => {
    logInfo("selenium_proxy_started", {
      port: config.port,
      hub: config.seleniumHubUrl,
    });
  });
  return server;
}
