import { Router } from "express";
import crypto from "node:crypto";
import { query } from "../db/database.js";
import { config } from "../config.js";
import { logger } from "../logger.js";
import {
  hash,
  requireAuth,
  setSessionCookie,
  clearSessionCookie,
} from "../middleware/session.js";

const router = Router();

// ---------- helpers ----------

function generateOtp() {
  let code = "";
  for (let i = 0; i < 6; i++) code += crypto.randomInt(10);
  return code;
}

async function isRateLimited(key) {
  const result = await query(
    "SELECT locked_until FROM otp_rate_limit WHERE email = $1",
    [key]
  );
  if (result.rows.length === 0) return false;
  const locked = result.rows[0].locked_until;
  return locked != null && new Date(locked) > new Date();
}

async function recordAttempt(key) {
  await query(
    `INSERT INTO otp_rate_limit (email, attempt_count, locked_until, updated_at)
     VALUES ($1, 1, NULL, now())
     ON CONFLICT (email) DO UPDATE SET
       attempt_count = otp_rate_limit.attempt_count + 1,
       locked_until = CASE
         WHEN otp_rate_limit.attempt_count + 1 >= $2
         THEN now() + ($3 || ' minutes')::interval
         ELSE otp_rate_limit.locked_until
       END,
       updated_at = now()`,
    [key, config.otpMaxAttempts, config.otpRateLimitWindowMinutes]
  );
}

async function clearRateLimit(key) {
  await query("DELETE FROM otp_rate_limit WHERE email = $1", [key]);
}

async function sendOtpEmail(email, code) {
  if (!config.postmarkApiToken) {
    logger.warn(`POSTMARK_API_TOKEN not set; would send OTP to ${email}: ${code}`);
    return;
  }
  const body = JSON.stringify({
    From: config.postmarkFromEmail,
    To: email,
    Subject: `Your TesboGrid login code: ${code}`,
    TextBody: `Welcome to TesboGrid.\n\nYour verification code is: ${code}\n\nIt expires in ${config.otpExpiryMinutes} minutes. Do not share this code with anyone.\n\nIf you didn't request this code, you can safely ignore this email.\n\n— The TesboGrid team`,
  });
  const res = await fetch("https://api.postmarkapp.com/email", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Postmark-Server-Token": config.postmarkApiToken,
    },
    body,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Postmark returned ${res.status}: ${text}`);
  }
}

async function findOrCreateUser(email) {
  const sel = await query("SELECT id FROM users WHERE email = $1", [email]);
  if (sel.rows.length > 0) return sel.rows[0].id;

  const ins = await query(
    "INSERT INTO users (email, name) VALUES ($1, $2) ON CONFLICT (email) DO NOTHING RETURNING id",
    [email, email.split("@")[0]]
  );
  if (ins.rows.length > 0) return ins.rows[0].id;

  const retry = await query("SELECT id FROM users WHERE email = $1", [email]);
  return retry.rows[0]?.id ?? null;
}

function createSessionToken() {
  const bytes = crypto.randomBytes(32);
  return bytes.toString("base64url");
}

async function acceptPendingInvitations(userId, email) {
  await query(
    `WITH pending AS (
       SELECT id, organization_id, role
       FROM workspace_invitations
       WHERE email = $1
         AND accepted_at IS NULL
         AND expires_at > now()
     ),
     accepted AS (
       UPDATE workspace_invitations wi
       SET accepted_at = now()
       FROM pending p
       WHERE wi.id = p.id
       RETURNING p.organization_id, p.role
     )
     INSERT INTO organization_members (organization_id, user_id, role)
     SELECT organization_id, $2::uuid, role
     FROM accepted
     ON CONFLICT (organization_id, user_id) DO NOTHING`,
    [email, userId]
  );

  await query(
    `WITH pending AS (
       SELECT epi.id, epi.execute_project_id, epi.role, ep.organization_id
       FROM execute_project_invitations epi
       JOIN execute_projects ep ON ep.id = epi.execute_project_id
       WHERE epi.email = $1
         AND epi.accepted_at IS NULL
         AND epi.expires_at > now()
         AND ep.archived_at IS NULL
     ),
     accepted AS (
       UPDATE execute_project_invitations epi
       SET accepted_at = now()
       FROM pending p
       WHERE epi.id = p.id
       RETURNING p.execute_project_id, p.organization_id, p.role
     ),
     ensure_org AS (
       INSERT INTO organization_members (organization_id, user_id, role)
       SELECT DISTINCT organization_id, $2::uuid, 'member'
       FROM accepted
       ON CONFLICT (organization_id, user_id) DO NOTHING
     )
     INSERT INTO execute_project_members (execute_project_id, user_id, role)
     SELECT execute_project_id, $2::uuid, role
     FROM accepted
     ON CONFLICT (execute_project_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
    [email, userId]
  );
}

// ---------- routes ----------

router.post("/otp/request", async (req, res) => {
  try {
    let { email } = req.body || {};
    if (!email || typeof email !== "string") {
      return res.status(400).json({ error: "Email is required" });
    }
    email = email.trim().toLowerCase();
    const reqKey = "req:" + email;

    if (await isRateLimited(reqKey)) {
      return res.status(429).json({ error: "Too many attempts. Try again later." });
    }

    const code = generateOtp();
    const codeHash = hash(code);
    const expiresAt = new Date(
      Date.now() + config.otpExpiryMinutes * 60 * 1000
    );

    await query(
      "INSERT INTO otp_codes (email, code_hash, expires_at) VALUES ($1, $2, $3)",
      [email, codeHash, expiresAt]
    );

    await recordAttempt(reqKey);
    await sendOtpEmail(email, code);

    res.json({ ok: true });
  } catch (err) {
    logger.error("OTP request error:", err);
    res.status(500).json({ error: "Failed to send verification code" });
  }
});

router.post("/otp/verify", async (req, res) => {
  try {
    let { email, code } = req.body || {};
    if (!email || !code) {
      return res.status(400).json({ error: "Email and code are required" });
    }
    email = email.trim().toLowerCase();
    code = code.trim();
    const verifyKey = "verify:" + email;

    if (await isRateLimited(verifyKey)) {
      return res.status(429).json({ error: "Too many attempts. Try again later." });
    }

    const codeHash = hash(code);
    const result = await query(
      `SELECT id FROM otp_codes
       WHERE email = $1 AND code_hash = $2 AND expires_at > now() AND used_at IS NULL
       ORDER BY created_at DESC LIMIT 1`,
      [email, codeHash]
    );

    if (result.rows.length === 0) {
      await recordAttempt(verifyKey);
      return res.status(401).json({ error: "Invalid or expired code" });
    }

    await query("UPDATE otp_codes SET used_at = now() WHERE id = $1", [
      result.rows[0].id,
    ]);

    const userId = await findOrCreateUser(email);
    if (!userId) {
      return res.status(500).json({ error: "Failed to resolve user" });
    }

    await acceptPendingInvitations(userId, email);

    const token = createSessionToken();
    const tokenHash = hash(token);
    const expiresAt = new Date(
      Date.now() + config.sessionDays * 86400 * 1000
    );

    await query(
      `INSERT INTO sessions (user_id, token_hash, user_agent, ip_address, expires_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        userId,
        tokenHash,
        req.headers["user-agent"] || null,
        req.ip || null,
        expiresAt,
      ]
    );

    await clearRateLimit(verifyKey);
    await clearRateLimit("req:" + email);

    setSessionCookie(res, token, req);
    res.json({ ok: true, userId });
  } catch (err) {
    logger.error("OTP verify error:", err);
    res.status(500).json({ error: "Verification failed" });
  }
});

router.post("/logout", requireAuth, async (req, res) => {
  try {
    const cookies = (await import("cookie")).parse(req.headers.cookie || "");
    const token = cookies[config.sessionCookieName];
    if (token) {
      const tokenHash = hash(token);
      await query("DELETE FROM sessions WHERE token_hash = $1", [tokenHash]);
    }
    clearSessionCookie(res, req);
    res.json({ ok: true });
  } catch (err) {
    logger.error("Logout error:", err);
    res.status(500).json({ error: "Logout failed" });
  }
});

router.get("/me", requireAuth, async (req, res) => {
  res.json({ userId: req.userId });
});

export default router;
