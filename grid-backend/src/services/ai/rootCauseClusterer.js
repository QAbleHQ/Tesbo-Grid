import crypto from "node:crypto";

function normalizeToken(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[0-9a-f]{8,}/g, "#")
    .replace(/\d+/g, "#")
    .replace(/\s+/g, " ")
    .trim();
}

function extractFirstFrame(errorStack) {
  if (!errorStack) return "";
  const lines = String(errorStack).split("\n").map((l) => l.trim());
  const frame = lines.find((l) => l.startsWith("at "));
  return normalizeToken(frame || "");
}

function extractSelectorHint(errorMessage) {
  const msg = String(errorMessage || "");
  const quoted = msg.match(/["'`](\.[^"'`]+|#[^"'`]+|\/\/[^"'`]+|[a-z0-9_-]+\[[^"'`]+\])["'`]/i);
  if (quoted?.[1]) return normalizeToken(quoted[1]);
  return "";
}

function inferCategoryHint(errorMessage) {
  const msg = String(errorMessage || "").toLowerCase();
  // Check element/locator signals first — a `findElement` wait that exceeds
  // its timeout surfaces with the word "timeout" in the message, but is a
  // SCRIPT_ISSUE, not ENVIRONMENT_ISSUE.
  if (/no such element|element not found|could not be located|stale element|detached from dom|waiting for (?:selector|locator|element)|findelement|element is not (?:visible|interactable|displayed|attached)|locator|selector/.test(msg)) {
    return "SCRIPT_ISSUE";
  }
  if (/econnrefused|connection refused|enotfound|getaddrinfo|dns|service unavailable|\b503\b|browser (?:crashed|disconnected)|session not created|chromedriver|grid (?:unreachable|down)|net::err|certificate|out of memory|etimedout|connection timed out|socket hang up/.test(msg)) {
    return "ENVIRONMENT_ISSUE";
  }
  if (/assert|expected|received|mismatch/.test(msg)) {
    return "ACTUAL_BUG";
  }
  return null;
}

export function buildFailureSignature(test) {
  const message = normalizeToken(test.error_message || "");
  const frame = extractFirstFrame(test.error_stack);
  const selector = extractSelectorHint(test.error_message);
  const signature = [message.slice(0, 220), frame, selector].filter(Boolean).join(" | ");
  return signature || "unknown failure signature";
}

export function buildClusterKey(signature) {
  return crypto.createHash("sha256").update(signature).digest("hex").slice(0, 32);
}

// ── Human-friendly title / summary helpers ─────────────────────────────────
//
// The clustering pipeline aggressively normalizes raw error text (replacing
// digits, hashes and whitespace with `#`) so that two failures with the same
// shape collide on the same cluster_key. That normalized form is great for
// grouping but unreadable for humans, so we derive a separate display title
// from the *original* error text. A couple of design choices:
//
//   - We strip CDATA wrappers and Selenium boilerplate ("build info:",
//     "system info:", "driver info:", and the first stack frame), since
//     none of that is actionable to a developer scanning a list of clusters.
//   - We surface the exception/error class name first when present, because
//     it's the single highest-signal token for triage.
//   - Everything we expose stays bounded in length so the UI never has to
//     deal with megabyte-long titles from runaway stack traces.

const SELENIUM_NOISE_RE =
  /(?:^|\n)\s*(?:build info|system info|driver info|capabilities|session id|command duration or timeout)\s*[:=]/i;

const STACK_FRAME_RE = /(?:^|\n)\s*at\s+/;

function cleanRawErrorText(text) {
  if (!text) return "";
  return String(text)
    .replace(/^\s*<!\[CDATA\[/i, "")
    .replace(/\]\]>\s*$/, "")
    .replace(/\r\n?/g, "\n");
}

function truncate(value, max) {
  const s = String(value || "");
  if (s.length <= max) return s;
  return s.slice(0, max - 1).trimEnd() + "…";
}

function trimNoiseAndStack(cleaned) {
  let cutAt = cleaned.length;
  const noise = cleaned.match(SELENIUM_NOISE_RE);
  if (noise && noise.index < cutAt) cutAt = noise.index;
  const stack = cleaned.match(STACK_FRAME_RE);
  if (stack && stack.index < cutAt) cutAt = stack.index;
  return cleaned.slice(0, cutAt).trim();
}

export function extractErrorType(text) {
  if (!text) return null;
  const fqdn = String(text).match(
    /\b(?:[a-z][a-z0-9_]*\.)+([A-Z][A-Za-z0-9_]*(?:Exception|Error|Failure))\b/
  );
  if (fqdn) return fqdn[1];
  const simple = String(text).match(
    /\b([A-Z][A-Za-z0-9_]*(?:Exception|Error|Failure))\b/
  );
  if (simple) return simple[1];
  return null;
}

// Collapse fully-qualified Java/JVM-style exception names (e.g.
// "org.openqa.selenium.TimeoutException") down to just the simple class name
// so the title we show users is short and readable. Without this we'd surface
// the whole FQDN, which dominates the title and adds no signal.
function shortenFqdnExceptions(text) {
  if (!text) return text;
  return text.replace(
    /\b(?:[a-z][a-z0-9_]*\.){1,}([A-Z][A-Za-z0-9_]*(?:Exception|Error|Failure))\b/g,
    "$1"
  );
}

export function buildHumanFailureTitle(test) {
  const message = cleanRawErrorText(test?.error_message);
  const stack = cleanRawErrorText(test?.error_stack);
  const headlineRaw =
    trimNoiseAndStack(message).split("\n").map((l) => l.trim()).find(Boolean) ||
    trimNoiseAndStack(stack).split("\n").map((l) => l.trim()).find(Boolean) ||
    "";
  const headline = shortenFqdnExceptions(headlineRaw)
    .replace(/\s+/g, " ")
    .trim();
  const errorType = extractErrorType(message) || extractErrorType(stack);

  if (errorType) {
    if (!headline) return errorType;
    if (headline.toLowerCase().includes(errorType.toLowerCase())) {
      return truncate(headline, 160);
    }
    const detail = headline.replace(/^[^:]{0,80}:\s*/, "");
    return truncate(`${errorType}: ${detail || headline}`, 160);
  }

  if (headline) return truncate(headline, 160);
  return "Test failure";
}

export function buildHumanFailureSummary(test) {
  const cleaned = cleanRawErrorText(test?.error_message);
  if (!cleaned) return null;
  const lines = cleaned.split("\n").map((l) => l.trim()).filter(Boolean);
  const useful = [];
  for (const ln of lines) {
    if (/^(build info|system info|driver info|capabilities|session id|command duration or timeout)\s*[:=]/i.test(ln)) {
      break;
    }
    if (/^at\s+/i.test(ln)) break;
    useful.push(ln);
    if (useful.join(" ").length > 320) break;
  }
  const summary = useful.join(" ").replace(/\s+/g, " ").trim();
  return summary ? truncate(summary, 320) : null;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function similarityConfidence(signature) {
  const len = signature.length;
  if (len >= 120) return 90;
  if (len >= 70) return 80;
  if (len >= 30) return 70;
  return 60;
}

export async function clusterFailedTestsForRun({ projectId, runId, query }) {
  const failedRes = await query(
    `SELECT id, error_message, error_stack, ai_analysis_category
     FROM report_tests
     WHERE report_run_id = $1
       AND status = 'Failed'`,
    [runId]
  );

  if (failedRes.rows.length === 0) return { clustered: 0, clustersCreated: 0 };

  let clustered = 0;
  let clustersCreated = 0;

  for (const test of failedRes.rows) {
    const signature = buildFailureSignature(test);
    const clusterKey = buildClusterKey(signature);
    const categoryHint = test.ai_analysis_category || inferCategoryHint(test.error_message);
    const humanTitle = buildHumanFailureTitle(test);

    const upsertCluster = await query(
      `INSERT INTO report_failure_clusters
         (project_id, cluster_key, title, primary_signature, category_hint, occurrence_count, first_seen_at, last_seen_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, 1, now(), now(), now())
       ON CONFLICT (project_id, cluster_key)
       DO UPDATE SET
         title = EXCLUDED.title,
         primary_signature = COALESCE(report_failure_clusters.primary_signature, EXCLUDED.primary_signature),
         category_hint = COALESCE(EXCLUDED.category_hint, report_failure_clusters.category_hint),
         occurrence_count = report_failure_clusters.occurrence_count + 1,
         last_seen_at = now(),
         updated_at = now()
       RETURNING id, (xmax = 0) AS inserted`,
      [
        projectId,
        clusterKey,
        truncate(humanTitle, 500),
        signature,
        categoryHint,
      ]
    );

    const cluster = upsertCluster.rows[0];
    if (cluster?.inserted) clustersCreated += 1;

    const confidence = similarityConfidence(signature);
    await query(
      `INSERT INTO report_test_cluster_links (report_test_id, cluster_id, match_confidence, match_reason)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (report_test_id, cluster_id)
       DO UPDATE SET
         match_confidence = EXCLUDED.match_confidence,
         match_reason = EXCLUDED.match_reason`,
      [test.id, cluster.id, clamp(confidence, 0, 100), "normalized_failure_signature"]
    );

    clustered += 1;
  }

  return { clustered, clustersCreated };
}
