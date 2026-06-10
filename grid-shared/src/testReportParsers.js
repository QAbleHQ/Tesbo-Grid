/**
 * Shared test report parsers — TestNG XML, JUnit XML, and pytest JSON.
 *
 * Pure functions: take a string, return a normalized array of test rows.
 * No I/O, no DB access. Used by:
 *   - grid-runner-workers (managed Selenium project runs)
 *   - grid-backend (POST /tesbo-reports/ingest/test-report)
 *
 * Normalized test shape:
 *   {
 *     spec, name, fullTitle,
 *     status: "Passed" | "Failed" | "Skipped",
 *     durationMs,
 *     errorMessage, errorStack,
 *     attempt, projectName,
 *     tags: string[],
 *     steps: Array<{ description: string }>,
 *   }
 */

function parseAttributes(raw) {
  const attrs = {};
  const pattern = /([\w:-]+)="([^"]*)"/g;
  let match;
  while ((match = pattern.exec(raw))) {
    attrs[match[1]] = match[2];
  }
  return attrs;
}

export function parseJUnitXml(xml) {
  if (!xml || typeof xml !== "string") return [];
  const out = [];
  const testCaseRegex = /<testcase\b([^>]*)>([\s\S]*?)<\/testcase>|<testcase\b([^>]*)\/>/g;
  let match;
  while ((match = testCaseRegex.exec(xml))) {
    const attrs = parseAttributes(match[1] || match[3] || "");
    const body = match[2] || "";
    const failureMatch = body.match(/<(failure|error)\b[^>]*>([\s\S]*?)<\/(failure|error)>/);
    const skippedMatch = body.match(/<skipped\b[^>]*>/);
    out.push({
      spec: attrs.classname || "unknown",
      name: attrs.name || "Unnamed test",
      fullTitle: attrs.classname && attrs.name ? `${attrs.classname}#${attrs.name}` : null,
      durationMs: Number.isFinite(Number(attrs.time)) ? Math.round(Number(attrs.time) * 1000) : null,
      status: failureMatch ? "Failed" : skippedMatch ? "Skipped" : "Passed",
      errorMessage: failureMatch ? String(failureMatch[2] || "").trim().slice(0, 4000) : null,
      errorStack: null,
      attempt: null,
      projectName: null,
      tags: [],
      steps: [],
    });
  }
  return out;
}

function extractCdata(raw) {
  if (!raw) return "";
  const m = raw.match(/<!\[CDATA\[([\s\S]*?)\]\]>/);
  return m ? m[1] : raw;
}

function stripHtmlTags(s) {
  return String(s || "")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

// TestNG reporter-output `<line>` HTML lines often render as
// `<h1 style="color:green;...">Test Passed</h1>`. Detect that so we can
// merge them with the preceding action description into a single step row.
function detectStepStatus(text) {
  const lower = String(text || "").toLowerCase().trim();
  if (!lower) return null;
  if (lower === "test passed" || lower === "passed" || lower === "pass") return "Passed";
  if (lower === "test failed" || lower === "failed" || lower === "fail") return "Failed";
  if (lower === "test skipped" || lower === "skipped" || lower === "skip") return "Skipped";
  return null;
}

/**
 * Convert the contents of a `<reporter-output>` block into normalized step
 * rows. Each row carries `description` (the human-readable action) and a
 * best-effort `status` ("Passed" | "Failed" | "Skipped" | undefined).
 *
 * The TestNG report typically emits pairs:
 *   <line>verify e_mail_text_box is displayed</line>
 *   <line><h1 style="color:green;...">Test Passed</h1></line>
 * which collapse into one step:
 *   { description: "verify e_mail_text_box is displayed", status: "Passed" }
 *
 * Action-only lines like "Click on login_button_web" become steps with no
 * explicit status (they're implicit pre-conditions, not assertions).
 */
function buildActionSteps(reporterOutputBody) {
  const lines = [];
  const lineRegex = /<line\b[^>]*>([\s\S]*?)<\/line>/g;
  let m;
  while ((m = lineRegex.exec(reporterOutputBody || ""))) {
    const text = stripHtmlTags(extractCdata(m[1]));
    if (text) lines.push(text);
  }

  const steps = [];
  for (const text of lines) {
    const status = detectStepStatus(text);
    if (status) {
      const prev = steps[steps.length - 1];
      if (prev && !prev.status) {
        // Attach the verdict to the preceding action description.
        prev.status = status;
        prev.description = `${prev.description} — ${status}`;
      } else {
        // Orphan status line; keep it as its own row so we don't lose data.
        steps.push({ description: text, status });
      }
    } else {
      steps.push({ description: text });
    }
  }
  return steps;
}

function parseTestNgMethod(attrs, body) {
  const isConfig = String(attrs["is-config"] || "").toLowerCase() === "true";
  const exceptionMatch = body.match(/<exception\b[^>]*>([\s\S]*?)<\/exception>/);
  const messageMatch = body.match(
    /<message\b[^>]*><!\[CDATA\[([\s\S]*?)\]\]><\/message>|<message\b[^>]*>([\s\S]*?)<\/message>/
  );
  const reporterOutput = body.match(
    /<reporter-output\b[^>]*>([\s\S]*?)<\/reporter-output>/
  );
  const reporterBody = reporterOutput?.[1] || "";

  // Inline screenshot refs: <img src="..."> embedded in reporter-output CDATA.
  const screenshotPaths = [];
  if (reporterBody) {
    const imgRegex = /<img\b[^>]*src=["']([^"']+)["'][^>]*>/g;
    let imgMatch;
    while ((imgMatch = imgRegex.exec(reporterBody))) {
      screenshotPaths.push(imgMatch[1]);
    }
  }

  const actionSteps = buildActionSteps(reporterBody);

  return {
    isConfig,
    name: attrs.name || "unnamed",
    rawStatus: String(attrs.status || "").toUpperCase(),
    durationMs: Number.isFinite(Number(attrs["duration-ms"])) ? Number(attrs["duration-ms"]) : null,
    errorMessage:
      (messageMatch?.[1] || messageMatch?.[2] || exceptionMatch?.[1] || "")
        .trim()
        .slice(0, 4000) || null,
    errorStack: exceptionMatch ? String(exceptionMatch[1] || "").trim().slice(0, 8000) : null,
    screenshotPaths,
    actionSteps,
  };
}

function configMethodToStep(method, tag) {
  const statusLabel = method.rawStatus === "PASS" ? "PASS" : "FAIL";
  const suffix = method.errorMessage ? `: ${method.errorMessage}` : "";
  return { description: `[${tag}] ${method.name} — ${statusLabel}${suffix}` };
}

export function parseTestNgXml(xml) {
  if (!xml || typeof xml !== "string") return [];
  const out = [];
  const classRegex = /<class\b([^>]*)>([\s\S]*?)<\/class>/g;
  let classMatch;
  while ((classMatch = classRegex.exec(xml))) {
    const classAttrs = parseAttributes(classMatch[1] || "");
    const className = classAttrs.name || "unknown";
    const classBody = classMatch[2] || "";

    const allMethods = [];
    const methodRegex = /<test-method\b([^>]*)>([\s\S]*?)<\/test-method>|<test-method\b([^>]*)\/>/g;
    let methodMatch;
    while ((methodMatch = methodRegex.exec(classBody))) {
      const attrs = parseAttributes(methodMatch[1] || methodMatch[3] || "");
      allMethods.push(parseTestNgMethod(attrs, methodMatch[2] || ""));
    }

    // Group config methods around real tests as setup/teardown steps.
    const testEntries = [];
    let pendingBefore = [];
    for (let i = 0; i < allMethods.length; i++) {
      const m = allMethods[i];
      if (m.isConfig) {
        pendingBefore.push(m);
        continue;
      }
      const beforeConfigs = pendingBefore;
      pendingBefore = [];
      const afterConfigs = [];
      while (i + 1 < allMethods.length && allMethods[i + 1].isConfig) {
        i++;
        afterConfigs.push(allMethods[i]);
      }
      testEntries.push({ method: m, beforeConfigs, afterConfigs });
    }
    if (pendingBefore.length > 0 && testEntries.length > 0) {
      testEntries[testEntries.length - 1].afterConfigs.push(...pendingBefore);
    }

    for (const { method, beforeConfigs, afterConfigs } of testEntries) {
      // Order matters: show setup config methods first, then the actual test
      // actions/assertions extracted from the test-method's reporter-output,
      // then teardown configs. This mirrors how the test ran in time.
      const steps = [
        ...beforeConfigs.map((m) => configMethodToStep(m, "setup")),
        ...(method.actionSteps || []),
        ...afterConfigs.map((m) => configMethodToStep(m, "teardown")),
      ];

      let errorMessage = method.errorMessage;
      let errorStack = method.errorStack;
      if (!errorMessage && method.rawStatus === "SKIP") {
        const failedSetup = beforeConfigs.find((m) => m.rawStatus !== "PASS");
        if (failedSetup) {
          errorMessage = failedSetup.errorMessage;
          errorStack = failedSetup.errorStack || null;
        }
      }

      out.push({
        spec: className,
        name: method.name,
        fullTitle: `${className}#${method.name}`,
        durationMs: method.durationMs,
        status:
          method.rawStatus === "FAIL"
            ? "Failed"
            : method.rawStatus === "SKIP"
            ? "Skipped"
            : "Passed",
        errorMessage,
        errorStack,
        attempt: null,
        projectName: null,
        tags: [],
        steps,
        // Non-DB hint used by the ingestion endpoint to attach uploaded
        // screenshot files to this test row when filenames match.
        _screenshotPaths: method.screenshotPaths,
      });
    }
  }
  return out;
}

export function parsePytestJson(raw) {
  if (!raw) return [];
  let parsed;
  try {
    parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    return [];
  }

  const tests = Array.isArray(parsed?.tests) ? parsed.tests : [];
  return tests.map((item) => {
    const phases = ["setup", "call", "teardown"]
      .map((phase) => item?.[phase])
      .filter(Boolean);
    const durationMs =
      phases.reduce((sum, phase) => {
        const duration = Number(phase?.duration);
        return sum + (Number.isFinite(duration) ? Math.round(duration * 1000) : 0);
      }, 0) || null;
    const failure = phases.find((phase) => phase?.crash?.message || phase?.longrepr);
    const outcome = String(item?.outcome || "").toLowerCase();
    return {
      spec: String(item?.nodeid || "").split("::")[0] || "unknown",
      name: String(item?.nodeid || "").split("::").slice(1).join("::") || "Unnamed test",
      fullTitle: item?.nodeid || null,
      durationMs,
      status: outcome === "failed" ? "Failed" : outcome === "skipped" ? "Skipped" : "Passed",
      errorMessage:
        String(failure?.crash?.message || failure?.longrepr || "")
          .trim()
          .slice(0, 4000) || null,
      errorStack: String(failure?.longrepr || "").trim().slice(0, 8000) || null,
      attempt: null,
      projectName: null,
      tags: Array.isArray(item?.keywords)
        ? item.keywords.filter((keyword) => typeof keyword === "string")
        : [],
      steps: [],
    };
  });
}

// ── Suite-level metadata extraction ─────────────────────────────────────────

/**
 * A fast, dependency-free 32-bit FNV-1a hash turned into a hex string.
 * Used to derive a deterministic `externalRef` from suite name + start time
 * so the same report re-uploaded doesn't create a duplicate run.
 */
function fnv1aHex(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = (Math.imul(h, 0x01000193) >>> 0);
  }
  return h.toString(16).padStart(8, "0");
}

/**
 * Normalise a TestNG / JUnit date string into an ISO-8601 UTC string, or
 * return null if the value can't be parsed.
 *
 * TestNG writes "2026-04-29T16:12:07 IST". `Date.parse` doesn't know "IST",
 * so we strip the tz suffix and treat the time as local (which is good enough
 * for idempotency keying).
 */
function normaliseDate(raw) {
  if (!raw) return null;
  let s = String(raw).trim();
  // Strip a trailing timezone abbreviation like " IST", " UTC", " EST", etc.
  s = s.replace(/\s+[A-Z]{2,5}$/, "");
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * Extract suite-level metadata from a report text so the upload CLI /
 * ingest endpoint can:
 *   - Use the real suite name as the run name (not a generated timestamp)
 *   - Use the actual started-at / finished-at as the run timestamps
 *   - Derive a stable `externalRef` for idempotent uploads
 *
 * Returns:
 *   {
 *     suiteName:   string | null,
 *     startedAt:   ISO-8601 string | null,
 *     completedAt: ISO-8601 string | null,
 *     durationMs:  number | null,
 *     externalRef: string | null,  // stable hash for idempotent upsert
 *   }
 */
export function parseSuiteMeta(text, format) {
  const fmt = (format || detectReportFormat(text) || "").toLowerCase();

  if (fmt === "testng") {
    const suiteMatch = text.match(/<suite\b([^>]*)>/i);
    const attrs = suiteMatch ? parseAttributes(suiteMatch[1]) : {};
    const name = attrs.name || null;
    const startedAt = normaliseDate(attrs["started-at"]);
    const completedAt = normaliseDate(attrs["finished-at"]);
    const durationMs = Number.isFinite(Number(attrs["duration-ms"]))
      ? Number(attrs["duration-ms"])
      : null;
    const externalRef =
      name && startedAt
        ? `testng-${fnv1aHex(`${name}|${startedAt}`)}`
        : null;
    return { suiteName: name, startedAt, completedAt, durationMs, externalRef };
  }

  if (fmt === "junit") {
    // <testsuites name="..." time="..."> or <testsuite name="..." timestamp="...">
    const rootMatch = text.match(/<testsuites?\b([^>]*?)>/i);
    const attrs = rootMatch ? parseAttributes(rootMatch[1]) : {};
    const name = attrs.name || null;
    const startedAt = normaliseDate(attrs.timestamp) || null;
    const durationMs = Number.isFinite(Number(attrs.time))
      ? Math.round(Number(attrs.time) * 1000)
      : null;
    const completedAt =
      startedAt && durationMs
        ? new Date(new Date(startedAt).getTime() + durationMs).toISOString()
        : null;
    const externalRef =
      name && startedAt
        ? `junit-${fnv1aHex(`${name}|${startedAt}`)}`
        : null;
    return { suiteName: name, startedAt, completedAt, durationMs, externalRef };
  }

  if (fmt === "pytest") {
    try {
      const parsed = JSON.parse(text);
      const name = parsed?.environment?.testenv || parsed?.project || null;
      const startedAt = parsed?.created
        ? new Date(parsed.created * 1000).toISOString()
        : null;
      const durationMs = Number.isFinite(parsed?.duration)
        ? Math.round(parsed.duration * 1000)
        : null;
      const completedAt =
        startedAt && durationMs
          ? new Date(new Date(startedAt).getTime() + durationMs).toISOString()
          : null;
      const externalRef =
        startedAt
          ? `pytest-${fnv1aHex(`${name || "pytest"}|${startedAt}`)}`
          : null;
      return { suiteName: name, startedAt, completedAt, durationMs, externalRef };
    } catch {
      return { suiteName: null, startedAt: null, completedAt: null, durationMs: null, externalRef: null };
    }
  }

  return { suiteName: null, startedAt: null, completedAt: null, durationMs: null, externalRef: null };
}

/**
 * Aggregate counts + run timing from a normalized test list.
 * The endpoint uses this to seed report_runs columns.
 */
export function summarizeTests(tests) {
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  let total = 0;
  let summedMs = 0;
  for (const t of tests) {
    total++;
    if (t.status === "Passed") passed++;
    else if (t.status === "Failed") failed++;
    else if (t.status === "Skipped") skipped++;
    if (Number.isFinite(t.durationMs)) summedMs += t.durationMs;
  }
  return {
    total,
    passed,
    failed,
    skipped,
    summedMs,
    status: failed > 0 ? "FAILED" : "COMPLETED",
  };
}

/**
 * Auto-detect the format of a single text payload by structural cues.
 * Returns one of: "testng" | "junit" | "pytest" | null.
 */
export function detectReportFormat(text) {
  if (!text || typeof text !== "string") return null;
  const trimmed = text.trimStart().slice(0, 4096);
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(text);
      if (parsed && (Array.isArray(parsed.tests) || parsed.summary)) return "pytest";
    } catch {}
    return null;
  }
  if (/<testng-results\b/i.test(trimmed) || /<test-method\b/i.test(trimmed)) return "testng";
  if (/<testsuites?\b/i.test(trimmed) || /<testcase\b/i.test(trimmed)) return "junit";
  return null;
}

/**
 * Parse any supported report format. Returns { tests, format, meta }.
 * `meta` is the output of parseSuiteMeta — suite name, timestamps,
 * and a stable `externalRef` for idempotent uploads.
 */
export function parseTestReport(text, hint) {
  const format = (hint || detectReportFormat(text) || "").toLowerCase();
  const meta = parseSuiteMeta(text, format);
  if (format === "testng") return { tests: parseTestNgXml(text), format: "testng", meta };
  if (format === "junit") return { tests: parseJUnitXml(text), format: "junit", meta };
  if (format === "pytest") return { tests: parsePytestJson(text), format: "pytest", meta };
  return { tests: [], format: null, meta };
}
