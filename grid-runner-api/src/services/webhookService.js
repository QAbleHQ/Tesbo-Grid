import crypto from "node:crypto";
import { config } from "../config.js";
import { getRunWebhookConfig } from "./runService.js";
import { logInfo, logError } from "../logger.js";

export async function emitWebhook(runId, event, payload = {}) {
  const webhookConfig = await getRunWebhookConfig(runId);
  if (!webhookConfig || !webhookConfig.webhook_url) return;

  const body = {
    event,
    runId,
    externalRef: webhookConfig.external_ref || null,
    ...payload,
    timestamp: new Date().toISOString(),
  };
  const bodyStr = JSON.stringify(body);
  const headers = { "Content-Type": "application/json" };
  // Fallback auth header for backend webhook receivers that validate shared token
  // instead of (or in addition to) HMAC signatures.
  if (process.env.INTERNAL_SHARED_TOKEN) {
    headers["x-agent-token"] = process.env.INTERNAL_SHARED_TOKEN;
  }
  if (webhookConfig.webhook_secret) {
    const signature = crypto
      .createHmac("sha256", webhookConfig.webhook_secret)
      .update(bodyStr)
      .digest("hex");
    headers["x-webhook-signature"] = signature;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.webhookTimeoutMs);

  try {
    const response = await fetch(webhookConfig.webhook_url, {
      method: "POST",
      headers,
      body: bodyStr,
      signal: controller.signal,
    });
    logInfo("webhook_sent", {
      event,
      runId,
      url: webhookConfig.webhook_url,
      status: response.status,
    });
  } catch (err) {
    logError("webhook_failed", {
      event,
      runId,
      url: webhookConfig.webhook_url,
      error: err instanceof Error ? err.message : String(err),
    });
  } finally {
    clearTimeout(timeout);
  }
}

export async function emitJobWebhook(runId, jobId, event, data = {}) {
  await emitWebhook(runId, event, { jobId, ...data });
}
