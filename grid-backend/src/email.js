import { config } from "./config.js";
import { logger } from "./logger.js";

/**
 * Send a transactional email via Postmark.
 * Returns { sent: true } on success, { sent: false, reason } when skipped or failed.
 * Never throws – callers should treat email as best-effort.
 */
export async function sendEmail({ to, subject, textBody, htmlBody }) {
  if (!config.postmarkApiToken) {
    logger.warn(
      `POSTMARK_API_TOKEN not set; would send "${subject}" to ${Array.isArray(to) ? to.join(", ") : to}`
    );
    return { sent: false, reason: "postmark_not_configured" };
  }

  const recipients = Array.isArray(to) ? to.filter(Boolean).join(",") : to;
  if (!recipients) return { sent: false, reason: "no_recipients" };

  const payload = {
    From: config.postmarkFromEmail,
    To: recipients,
    Subject: subject,
    TextBody: textBody,
  };
  if (htmlBody) payload.HtmlBody = htmlBody;

  try {
    const res = await fetch("https://api.postmarkapp.com/email", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Postmark-Server-Token": config.postmarkApiToken,
      },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      logger.error(`Postmark send failed (${res.status}): ${text}`);
      return { sent: false, reason: `postmark_${res.status}` };
    }
    return { sent: true };
  } catch (err) {
    logger.error("Postmark send error:", err);
    return { sent: false, reason: "network_error" };
  }
}
