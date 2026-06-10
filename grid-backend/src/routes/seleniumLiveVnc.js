import crypto from "node:crypto";
import cookie from "cookie";
import { WebSocketServer, WebSocket } from "ws";
import { config } from "../config.js";
import { query } from "../db/database.js";
import { logger } from "../logger.js";

// Live VNC tunnel.
//
// Browser opens:
//   wss://<grid-backend>/api/projects/<projectId>/selenium-sessions/<seleniumId>/vnc
// authenticated by the tesbo_session cookie.
//
// We resolve the user's session, verify project membership, then open an
// upstream WebSocket to grid-selenium-proxy at
//   ws://<selenium-proxy>/sessions/<seleniumId>/vnc
// adding the INTERNAL_SHARED_TOKEN header. The proxy then pipes us to the
// selenium node's noVNC listener.
//
// Implementation notes:
//
// 1. We use an in-process `WebSocketServer({ noServer: true })` to upgrade
//    the client socket properly (so it gets a real `ws` instance with
//    frame-level forwarding + backpressure handling). The previous
//    implementation piped `upstream._socket` directly to the raw client TCP
//    socket, which raced the `ws` library's frame parser — bytes consumed
//    by the parser never made it through the pipe, producing a "Connection
//    lost" almost immediately on most browsers. Forwarding `message` events
//    is safer and only costs one in-memory copy per frame.
//
// 2. To give the dashboard actionable error messages we ALWAYS accept the
//    client's WS upgrade (so the browser exposes real close codes via the
//    JS WebSocket API; failed handshakes only produce opaque 1006s).
//    Failures are reported through application close codes 45xx-46xx that
//    the dashboard maps to user-facing strings.

const VNC_PATH = /^\/api\/projects\/([^/]+)\/selenium-sessions\/([^/]+)\/vnc\/?$/;

// Reuse a single noServer WebSocketServer instance.
const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });

// Application-level close codes (RFC 6455 §7.4 reserves 4000-4999 for
// applications). The frontend's LiveVncViewer renders friendly text per
// code — keep it in sync.
const CLOSE_UNAUTHENTICATED = 4401;
const CLOSE_FORBIDDEN = 4403;
const CLOSE_NOT_CONFIGURED = 4503;
const CLOSE_PROXY_UNREACHABLE = 4502;
const CLOSE_SESSION_NOT_ACTIVE = 4409;
const CLOSE_SESSION_NOT_FOUND = 4404;
const CLOSE_INTERNAL = 4500;

function hashToken(value) {
  return crypto.createHash("sha256").update(value, "utf8").digest("base64url");
}

async function resolveUserFromCookie(req) {
  try {
    const cookies = cookie.parse(req.headers.cookie || "");
    const token = cookies[config.sessionCookieName];
    if (!token) return null;
    const result = await query(
      "SELECT user_id FROM sessions WHERE token_hash = $1 AND expires_at > now()",
      [hashToken(token)]
    );
    return result.rows[0]?.user_id || null;
  } catch (err) {
    logger.warn("vnc cookie session lookup failed:", err);
    return null;
  }
}

async function userHasProjectAccess(userId, projectId) {
  if (!userId || !projectId) return false;
  try {
    const result = await query(
      `SELECT 1
         FROM execute_projects ep
         JOIN execute_project_members epm
           ON epm.execute_project_id = ep.id
          AND epm.user_id = $2
        WHERE ep.id = $1
          AND ep.archived_at IS NULL
        LIMIT 1`,
      [projectId, userId]
    );
    return result.rows.length > 0;
  } catch (err) {
    logger.warn("vnc project access lookup failed:", err);
    return false;
  }
}

// Accept the client's WS upgrade and immediately close with the supplied
// app-level code + reason. Only used for failures we can detect before
// upstream is open. Browser will fire `close` event with the code intact.
function acceptThenClose(req, socket, head, code, reason) {
  wss.handleUpgrade(req, socket, head, (client) => {
    try {
      client.close(code, String(reason || "").slice(0, 120));
    } catch {
      try { client.terminate(); } catch { /* noop */ }
    }
  });
}

// Public entry point — called from grid-backend/src/index.js as
//   server.on('upgrade', registerVncUpgrade)
export function registerVncUpgrade(server) {
  server.on("upgrade", async (req, socket, head) => {
    let url = req.url || "/";
    try {
      const match = url.split("?")[0].match(VNC_PATH);
      if (!match) {
        // Not our path — let the socket close gracefully so other listeners
        // (none today, but future-proofing) can claim the upgrade first.
        process.nextTick(() => {
          if (!socket.destroyed) {
            socket.write("HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
            socket.destroy();
          }
        });
        return;
      }
      const [, projectId, seleniumId] = match;

      const userId = await resolveUserFromCookie(req);
      if (!userId) {
        logger.info("vnc_upgrade_unauthenticated", {
          projectId,
          seleniumId,
          hasCookie: !!req.headers.cookie,
        });
        // Cookie auth requires a 401 BEFORE upgrade so the browser knows to
        // re-authenticate. App-code closes don't help here because the
        // browser would have already accepted the WS.
        socket.write(
          "HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
        );
        socket.destroy();
        return;
      }
      const allowed = await userHasProjectAccess(userId, projectId);
      if (!allowed) {
        logger.info("vnc_upgrade_forbidden", { projectId, seleniumId, userId });
        socket.write(
          "HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
        );
        socket.destroy();
        return;
      }

      if (!config.seleniumProxyUrl || !config.seleniumProxyInternalToken) {
        logger.warn("vnc_upgrade_unconfigured", {
          hasProxyUrl: !!config.seleniumProxyUrl,
          hasInternalToken: !!config.seleniumProxyInternalToken,
        });
        acceptThenClose(
          req,
          socket,
          head,
          CLOSE_NOT_CONFIGURED,
          "Live viewer not configured on this deployment"
        );
        return;
      }

      const upstreamUrl = buildUpstreamWsUrl(
        config.seleniumProxyUrl,
        seleniumId
      );
      let upstream;
      try {
        upstream = new WebSocket(upstreamUrl, ["binary"], {
          headers: {
            "x-internal-token": config.seleniumProxyInternalToken,
          },
          perMessageDeflate: false,
          handshakeTimeout: 10_000,
        });
      } catch (err) {
        logger.error("vnc_upstream_create_failed", {
          error: err instanceof Error ? err.message : String(err),
          upstreamUrl,
        });
        acceptThenClose(
          req,
          socket,
          head,
          CLOSE_PROXY_UNREACHABLE,
          "Could not reach the selenium proxy"
        );
        return;
      }

      let settled = false;
      const settle = () => {
        if (settled) return false;
        settled = true;
        return true;
      };

      // The selenium-proxy returns:
      //   401 — internal token mismatch (deployment misconfig)
      //   404 — selenium-proxy doesn't know this session id
      //   409 — session row exists but isn't `active` (test ended)
      //   502 — proxy can't reach the upstream node
      // Map each to a distinct app-level close code so the dashboard tells
      // the user something useful instead of "Connection lost".
      upstream.on("unexpected-response", (_request, response) => {
        if (!settle()) return;
        const status = response.statusCode || 502;
        logger.warn("vnc_upstream_rejected", {
          upstreamUrl,
          status,
          statusMessage: response.statusMessage,
        });
        let code = CLOSE_INTERNAL;
        let reason = `Upstream HTTP ${status}`;
        if (status === 401 || status === 403) {
          code = CLOSE_NOT_CONFIGURED;
          reason = "Selenium proxy rejected the dashboard's internal token";
        } else if (status === 404) {
          code = CLOSE_SESSION_NOT_FOUND;
          reason = "Session not found on the selenium proxy";
        } else if (status === 409) {
          code = CLOSE_SESSION_NOT_ACTIVE;
          reason = "Session is no longer active";
        } else if (status === 502 || status === 503 || status === 504) {
          code = CLOSE_PROXY_UNREACHABLE;
          reason = "Selenium proxy could not reach the browser node";
        }
        acceptThenClose(req, socket, head, code, reason);
        try { upstream.close(); } catch { /* noop */ }
      });

      upstream.on("error", (err) => {
        if (!settle()) return;
        logger.warn("vnc_upstream_handshake_error", {
          error: err instanceof Error ? err.message : String(err),
          code: err && err.code,
          upstreamUrl,
        });
        acceptThenClose(
          req,
          socket,
          head,
          CLOSE_PROXY_UNREACHABLE,
          err instanceof Error
            ? `Selenium proxy connect error: ${err.message}`
            : "Selenium proxy connect error"
        );
      });

      upstream.once("open", () => {
        if (!settle()) return;
        wss.handleUpgrade(req, socket, head, (client) => {
          relayBidirectional(client, upstream, { projectId, seleniumId });
        });
      });
    } catch (err) {
      logger.error("vnc_upgrade_handler_crashed", {
        error: err instanceof Error ? err.message : String(err),
        url,
      });
      try {
        if (!socket.destroyed) {
          socket.write(
            "HTTP/1.1 500 Internal Server Error\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
          );
          socket.destroy();
        }
      } catch {
        /* noop */
      }
    }
  });
}

// Forward both directions at the WS frame level. We propagate close codes
// downstream so the dashboard's mapping has accurate signal — e.g. when
// the test ends and the upstream proxy closes us with code 1000, the
// browser sees the same 1000 and renders "Live view ended" rather than
// the alarming "Connection lost" we used to show for any close.
function relayBidirectional(client, upstream, ctx) {
  let closed = false;
  const closeBoth = (code, reason) => {
    if (closed) return;
    closed = true;
    // Browsers reject close codes outside the allowed ranges (1000-1011
    // and 3000-4999); coerce out-of-range numerics to 1011 so the
    // dashboard never sees an "invalid frame" parsing error.
    let outCode = Number(code);
    if (
      !Number.isFinite(outCode) ||
      outCode < 1000 ||
      outCode === 1004 ||
      outCode === 1005 ||
      outCode === 1006 ||
      (outCode > 1011 && outCode < 3000) ||
      outCode > 4999
    ) {
      outCode = 1011;
    }
    const outReason = String(reason || "").slice(0, 120);
    try { client.close(outCode, outReason); } catch { /* noop */ }
    try { upstream.close(outCode, outReason); } catch { /* noop */ }
  };

  client.on("message", (data, isBinary) => {
    if (upstream.readyState !== WebSocket.OPEN) return;
    try {
      upstream.send(data, { binary: isBinary });
    } catch (err) {
      logger.warn("vnc_relay_client_to_upstream_send_failed", {
        error: err instanceof Error ? err.message : String(err),
        ...ctx,
      });
      closeBoth(1011, "relay error");
    }
  });
  upstream.on("message", (data, isBinary) => {
    if (client.readyState !== WebSocket.OPEN) return;
    try {
      client.send(data, { binary: isBinary });
    } catch (err) {
      logger.warn("vnc_relay_upstream_to_client_send_failed", {
        error: err instanceof Error ? err.message : String(err),
        ...ctx,
      });
      closeBoth(1011, "relay error");
    }
  });

  client.on("close", (code, reason) => closeBoth(code, reason?.toString?.() || ""));
  upstream.on("close", (code, reason) => closeBoth(code, reason?.toString?.() || ""));
  client.on("error", () => closeBoth(1011, "client error"));
  upstream.on("error", () => closeBoth(1011, "upstream error"));
}

// Convert the configured selenium-proxy URL (which may be http://... in
// dev or https://... in prod) into a ws:// or wss:// URL for the per-session
// VNC endpoint.
function buildUpstreamWsUrl(proxyUrl, seleniumId) {
  const u = new URL(proxyUrl);
  const wsProtocol = u.protocol === "https:" ? "wss:" : "ws:";
  return `${wsProtocol}//${u.host}/sessions/${encodeURIComponent(seleniumId)}/vnc`;
}
