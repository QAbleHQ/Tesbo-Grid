import crypto from "node:crypto";
import cookie from "cookie";
import { query } from "../db/database.js";
import { config } from "../config.js";
import { logger } from "../logger.js";

function hash(value) {
  const digest = crypto.createHash("sha256").update(value, "utf8").digest();
  return digest.toString("base64url");
}

/**
 * Parse tesbo_session cookie, resolve userId from sessions table,
 * and attach req.userId (or null).
 */
export async function sessionMiddleware(req, _res, next) {
  req.userId = null;
  req.sessionError = null;
  try {
    const cookies = cookie.parse(req.headers.cookie || "");
    const token = cookies[config.sessionCookieName];
    if (!token) return next();

    const tokenHash = hash(token);
    const result = await query(
      "SELECT user_id FROM sessions WHERE token_hash = $1 AND expires_at > now()",
      [tokenHash]
    );
    if (result.rows.length > 0) {
      req.userId = result.rows[0].user_id;
    }
  } catch (err) {
    // Infra failure (e.g. DB connection timeout / pool exhaustion) while
    // resolving the session. Do NOT mask this as "unauthenticated" — that
    // turns a transient outage into a misleading 401 for every logged-in
    // user on every page. Record it so requireAuth can return 503, and log
    // it so the incident is actually visible.
    req.sessionError = err;
    logger.error("session resolution failed:", err);
  }
  next();
}

export function requireAuth(req, res, next) {
  if (req.sessionError) {
    return res.status(503).json({ error: "Service temporarily unavailable" });
  }
  if (!req.userId) {
    return res.status(401).json({ error: "Authentication required" });
  }
  next();
}

export function setSessionCookie(res, token, req) {
  const isSecure =
    req.protocol === "https" ||
    req.headers["x-forwarded-proto"] === "https" ||
    config.frontendUrl.startsWith("https://");

  res.setHeader(
    "Set-Cookie",
    cookie.serialize(config.sessionCookieName, token, {
      httpOnly: true,
      sameSite: "lax",
      secure: isSecure,
      path: "/",
      maxAge: config.sessionDays * 86400,
    })
  );
}

export function clearSessionCookie(res, req) {
  const isSecure =
    req.protocol === "https" ||
    req.headers["x-forwarded-proto"] === "https" ||
    config.frontendUrl.startsWith("https://");

  res.setHeader(
    "Set-Cookie",
    cookie.serialize(config.sessionCookieName, "", {
      httpOnly: true,
      sameSite: "lax",
      secure: isSecure,
      path: "/",
      maxAge: 0,
    })
  );
}

export { hash };
