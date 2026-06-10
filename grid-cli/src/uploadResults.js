/**
 * `tesbox upload-results <path>` implementation.
 *
 * Walks <path> for a recognizable test report (TestNG, JUnit, pytest JSON),
 * collects nearby screenshots, and POSTs everything to the grid-backend
 * `tesbo-reports/ingest/test-report` endpoint as multipart/form-data.
 *
 * Authentication uses the same `tesbo_*` project key that the grid URL uses,
 * so users only need ONE secret end-to-end. The CLI resolves the key to a
 * project id via `/api/tesbo-reports/project-by-key` before posting.
 */

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

// `tesbo_*` keys are app-level project keys served by the App API
// (grid-backend), not the runner API.
const DEFAULT_APP_API_URL = "http://localhost:7100";

const REPORT_FILE_PATTERNS = [
  // (relative path, format hint)
  { name: "testng-results.xml", format: "testng" },
  // Maven Surefire stores per-suite XMLs prefixed with TEST-.
  { dir: "surefire-reports", suffix: ".xml", format: "junit" },
  { dir: "test-results", suffix: ".xml", format: "junit" },
  { name: "junit.xml", format: "junit" },
  { name: "report.json", format: "pytest" },
];

const SCREENSHOT_DIRS = [
  "failed_test_screenshot",
  "screenshots",
  "test-output/screenshots",
  "src/test/resources/failed_test_screenshot",
  "target/screenshots",
  "build/reports/screenshots",
  "cypress/screenshots",
  "playwright-report",
];

const SCREENSHOT_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);
const VIDEO_EXTS = new Set([".webm", ".mp4"]);
const TRACE_EXTS = new Set([".zip"]);

// Directories that NEVER contain test reports or artifacts. Skipping these
// dramatically speeds up the walk and — more importantly — prevents the file
// cap from being exhausted before we reach the real report (e.g. Maven's
// target/test-classes/ alone routinely holds 5000+ .class files).
const SKIP_DIRS = new Set([
  // VCS / IDE
  ".git", ".hg", ".svn", ".idea", ".vscode",
  // JS / Node
  "node_modules", ".next", ".nuxt", ".cache", ".turbo", ".parcel-cache", ".vercel",
  // Python
  ".venv", "venv", "__pycache__", ".pytest_cache", ".tox", ".mypy_cache", ".ruff_cache", "site-packages",
  // Build tools
  ".gradle", ".mvn", ".ccache", ".terraform",
  // Maven build artifacts (NOT surefire-reports/failsafe-reports — those live under target/ too)
  "classes", "test-classes", "generated-sources", "generated-test-sources",
  "maven-status", "maven-archiver", "dependency", "dependency-maven-plugin-markers",
  // Generic build outputs
  "bin", "out", "dist", "coverage", "tmp", "temp",
]);

// Well-known locations to probe BEFORE walking the tree. Hitting one of these
// resolves the upload in O(1) — no recursive scan of customer source trees.
const FAST_REPORT_PATHS = [
  // Maven Surefire / Failsafe
  { type: "file",  path: "target/surefire-reports/testng-results.xml", format: "testng" },
  { type: "file",  path: "target/failsafe-reports/testng-results.xml", format: "testng" },
  { type: "dir",   path: "target/surefire-reports", suffix: ".xml", format: "junit" },
  { type: "dir",   path: "target/failsafe-reports", suffix: ".xml", format: "junit" },
  // Standalone TestNG (default test-output/)
  { type: "file",  path: "test-output/testng-results.xml", format: "testng" },
  // Gradle
  { type: "dir",   path: "build/test-results/test", suffix: ".xml", format: "junit" },
  { type: "dir",   path: "build/test-results", suffix: ".xml", format: "junit" },
  // Generic root-level reports
  { type: "file",  path: "testng-results.xml", format: "testng" },
  { type: "file",  path: "junit.xml", format: "junit" },
  { type: "file",  path: "test-results.xml", format: "junit" },
  { type: "file",  path: "report.json", format: "pytest" },
];

function log(s) {
  process.stdout.write(`${s}\n`);
}
function logErr(s) {
  process.stderr.write(`${s}\n`);
}

async function pathExists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function statKind(p) {
  try {
    const s = await fs.stat(p);
    return s.isDirectory() ? "dir" : s.isFile() ? "file" : "other";
  } catch {
    return null;
  }
}

async function walk(root, maxFiles = 50000) {
  const out = [];
  const stack = [root];
  while (stack.length > 0 && out.length < maxFiles) {
    const dir = stack.pop();
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        // Skip directories that can't hold reports/artifacts. These are
        // build-output / dependency / cache / VCS directories that are
        // either huge (and would exhaust the file budget) or guaranteed
        // not to contain TestNG / JUnit / pytest reports.
        if (SKIP_DIRS.has(e.name) || e.name.startsWith("generated-")) {
          continue;
        }
        stack.push(full);
      } else if (e.isFile()) {
        out.push(full);
      }
    }
  }
  return out;
}

/**
 * Recursively collect files matching one of the given extensions, capped at
 * `maxFiles`. Used by the artifact fast-path against known small directories
 * (failed_test_screenshot/, screenshots/, etc.) so we don't have to walk the
 * full project tree just to find screenshots.
 */
async function collectFilesByExt(rootAbs, extSet, maxFiles = 1000) {
  const out = [];
  const stack = [rootAbs];
  while (stack.length > 0 && out.length < maxFiles) {
    const dir = stack.pop();
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        stack.push(full);
      } else if (e.isFile()) {
        const ext = path.extname(e.name).toLowerCase();
        if (extSet.has(ext)) out.push(full);
      }
    }
  }
  return out;
}

/**
 * Probe a small, fixed set of well-known framework report locations relative
 * to <root>. Returns the freshest match (after optional sinceMs filter), or
 * null if nothing matches. Doing this BEFORE the recursive walk means the
 * 99% case (Maven Surefire, Gradle, default TestNG/pytest layouts) resolves
 * in milliseconds without ever scanning the source tree — which is what
 * stops the "report exists but the CLI couldn't find it" failure mode in
 * large projects (e.g. Maven projects with 5000+ .class files in
 * target/test-classes/).
 */
async function fastFindReport(rootAbs, { sinceMs = 0 } = {}) {
  const candidates = [];

  for (const entry of FAST_REPORT_PATHS) {
    const target = path.join(rootAbs, entry.path);

    if (entry.type === "file") {
      const s = await fs.stat(target).catch(() => null);
      if (s && s.isFile()) {
        const isTestng = path.basename(target).toLowerCase() === "testng-results.xml";
        candidates.push({
          filePath: target,
          mtimeMs: s.mtimeMs,
          format: entry.format,
          // Prefer specific testng-results.xml > generic junit > pytest.
          priority: isTestng ? 0 : entry.format === "junit" ? 1 : 2,
        });
      }
      continue;
    }

    if (entry.type === "dir") {
      let entries;
      try {
        entries = await fs.readdir(target, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        if (!e.isFile()) continue;
        if (entry.suffix && !e.name.toLowerCase().endsWith(entry.suffix)) continue;
        const full = path.join(target, e.name);
        const s = await fs.stat(full).catch(() => null);
        if (!s) continue;
        const isTestng = e.name.toLowerCase() === "testng-results.xml";
        candidates.push({
          filePath: full,
          mtimeMs: s.mtimeMs,
          // testng-results.xml inside surefire-reports/ is the aggregate;
          // prefer it over per-class TEST-*.xml files which only describe
          // a single suite.
          format: isTestng ? "testng" : entry.format,
          priority: isTestng ? 0 : 1,
        });
      }
    }
  }

  if (candidates.length === 0) return null;

  // Prefer fresh files (produced by the current build); if none qualify,
  // fall back to all candidates so standalone `upload-results` (no build
  // start time) still works.
  const fresh = sinceMs > 0 ? candidates.filter((c) => c.mtimeMs >= sinceMs) : candidates;
  const pool = fresh.length > 0 ? fresh : candidates;
  pool.sort(
    (a, b) => (a.priority ?? 9) - (b.priority ?? 9) || b.mtimeMs - a.mtimeMs
  );
  const best = pool[0];
  return { filePath: best.filePath, format: best.format };
}

/**
 * Given a starting <path> (file or dir), find the single best report file
 * to upload. Preference order: explicit file > testng > junit > pytest.
 *
 * When `sinceMs` is provided (build start epoch), any report file older than
 * that is treated as stale (left over from a prior run). Within each pattern,
 * we always prefer the freshest file, so Maven's
 * target/surefire-reports/testng-results.xml wins over the stale
 * test-output/testng-results.xml automatically.
 */
async function findReportFile(startPath, { sinceMs = 0 } = {}) {
  const kind = await statKind(startPath);
  if (!kind) {
    throw new Error(`Path not found: ${startPath}`);
  }
  if (kind === "file") {
    return { filePath: startPath, format: hintFormatFromName(startPath) };
  }

  // 0. Fast path — probe well-known framework locations directly. This
  //    avoids walking large source trees (and hitting the file cap) for
  //    the 99% case of standard Maven/Gradle/TestNG/pytest layouts.
  const fast = await fastFindReport(startPath, { sinceMs });
  if (fast) return fast;

  const allFiles = await walk(startPath);

  // Attach mtime to every file once so comparisons below are cheap.
  const withMtime = await Promise.all(
    allFiles.map(async (f) => {
      try {
        const s = await fs.stat(f);
        return { f, mtimeMs: s.mtimeMs };
      } catch {
        return { f, mtimeMs: 0 };
      }
    })
  );

  // Returns candidates for a given pattern sorted newest-first, optionally
  // filtered to only files produced during this build (mtime >= sinceMs).
  // If sinceMs filtering leaves nothing, fall back to all candidates — this
  // ensures standalone `upload-results` (no build start time) still works.
  function pickFreshest(candidates) {
    if (candidates.length === 0) return null;
    const fresh = sinceMs > 0 ? candidates.filter((c) => c.mtimeMs >= sinceMs) : candidates;
    const pool = fresh.length > 0 ? fresh : candidates;
    pool.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return pool[0];
  }

  // 1. Look for an exact match on a known report filename.
  //    Collect ALL matches (there may be copies in test-output/ AND
  //    target/surefire-reports/) then pick the freshest one.
  for (const pattern of REPORT_FILE_PATTERNS) {
    if (!pattern.name) continue;
    const candidates = withMtime.filter(
      (c) => path.basename(c.f).toLowerCase() === pattern.name.toLowerCase()
    );
    const best = pickFreshest(candidates);
    if (best) return { filePath: best.f, format: pattern.format };
  }

  // 2. Look for files inside known subdirectories with the right suffix.
  //    Pick the freshest qualifying file (Maven surefire aggregates are
  //    usually both the largest and newest).
  for (const pattern of REPORT_FILE_PATTERNS) {
    if (!pattern.dir || !pattern.suffix) continue;
    const candidates = withMtime.filter(
      (c) =>
        c.f.toLowerCase().includes(`/${pattern.dir.toLowerCase()}/`) &&
        c.f.toLowerCase().endsWith(pattern.suffix.toLowerCase())
    );
    const best = pickFreshest(candidates);
    if (best) return { filePath: best.f, format: pattern.format };
  }

  return null;
}

function hintFormatFromName(filePath) {
  const lower = filePath.toLowerCase();
  if (lower.endsWith("testng-results.xml") || lower.endsWith("testng.xml")) return "testng";
  if (lower.endsWith(".json")) return "pytest";
  if (lower.endsWith(".xml")) return "junit";
  return null;
}

async function findArtifactFiles(startPath, extSet, { sinceMs = 0, maxFiles = 50 } = {}) {
  const kind = await statKind(startPath);
  if (kind !== "dir") return [];

  // Fast path — probe the well-known SCREENSHOT_DIRS directly relative to
  // <startPath>. This handles the standard layouts (Maven failed-screenshot
  // dirs, Cypress, Playwright, etc.) without walking the full source tree.
  const fastCandidates = [];
  for (const rel of SCREENSHOT_DIRS) {
    const dirAbs = path.join(startPath, rel);
    const sub = await collectFilesByExt(dirAbs, extSet);
    fastCandidates.push(...sub);
  }
  // De-duplicate.
  const seen = new Set();
  let candidates = fastCandidates.filter((f) => {
    if (seen.has(f)) return false;
    seen.add(f);
    return true;
  });

  // Fallback: if the fast path found nothing, fall back to a full walk so we
  // still catch unusual project layouts.
  if (candidates.length === 0) {
    const allFiles = await walk(startPath);
    for (const f of allFiles) {
      const ext = path.extname(f).toLowerCase();
      if (!extSet.has(ext)) continue;
      const lower = f.toLowerCase();
      const inArtifactDir = SCREENSHOT_DIRS.some((dir) =>
        lower.includes(`/${dir.toLowerCase()}/`)
      );
      if (inArtifactDir || lower.includes("screenshot") || lower.includes("video")) {
        candidates.push(f);
      }
    }
  }

  // Reject artifacts that are older than `sinceMs` (i.e. were not produced by
  // this build). This is what stops us from re-uploading the entire history
  // of failed_test_screenshot/ on every run.
  const stats = await Promise.all(
    candidates.map(async (f) => {
      try {
        const s = await fs.stat(f);
        return { f, mtimeMs: s.mtimeMs, size: s.size };
      } catch {
        return null;
      }
    })
  );
  const fresh = stats
    .filter(Boolean)
    .filter((s) => sinceMs === 0 || s.mtimeMs >= sinceMs)
    // Newest first, then truncate.
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, maxFiles);

  return fresh.map((s) => s.f);
}

async function resolveProjectId({ apiKey, apiUrl }) {
  const url = `${apiUrl.replace(/\/+$/, "")}/api/tesbo-reports/project-by-key`;
  let res;
  try {
    res = await fetch(url, {
      method: "GET",
      headers: { "x-project-access-key": apiKey },
    });
  } catch (err) {
    throw new Error(`Could not reach ${url}: ${err?.message || err}`);
  }
  if (!res.ok) {
    let body = "";
    try {
      body = await res.text();
    } catch {}
    throw new Error(
      `Project lookup failed (${res.status}). ${body ? body.slice(0, 200) : ""}`.trim()
    );
  }
  const json = await res.json();
  if (!json?.projectId) throw new Error("Project lookup returned no projectId");
  return json.projectId;
}

async function postMultipart({ url, apiKey, formData }) {
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "x-project-access-key": apiKey },
      body: formData,
    });
  } catch (err) {
    throw new Error(`Upload request failed: ${err?.message || err}`);
  }
  let body = null;
  try {
    body = await res.json();
  } catch {
    try {
      body = { raw: await res.text() };
    } catch {}
  }
  if (!res.ok) {
    const detail = body?.error || body?.raw || `HTTP ${res.status}`;
    throw new Error(`Upload rejected: ${detail}`);
  }
  return body;
}

export async function uploadResults(options) {
  const {
    pathArg = ".",
    apiKey,
    apiUrl = DEFAULT_APP_API_URL,
    runName,
    sourceType,
    runId,
    buildId,
    startedAt,
    completedAt,
    format: formatHint,
    includeScreenshots = true,
    quiet = false,
    artifactsSinceMs = 0,
    maxArtifactsPerKind = 50,
  } = options;

  if (!apiKey) {
    logErr("API key required. Use --api-key or set TESBOX_API_KEY env variable.");
    return 1;
  }

  const startedMs = Date.now();
  const absPath = path.resolve(pathArg);
  if (!quiet) log(`\n  Scanning  \x1b[2m${absPath}\x1b[0m`);

  let report;
  try {
    report = await findReportFile(absPath, { sinceMs: artifactsSinceMs });
  } catch (err) {
    logErr(`  ${err.message}`);
    return 1;
  }
  if (!report) {
    logErr(
      `  No test report found under ${absPath}.
  Probed (fast path): target/surefire-reports/{testng-results.xml,*.xml},
                      target/failsafe-reports/*.xml, build/test-results/**/*.xml,
                      test-output/testng-results.xml, junit.xml, report.json
  Then walked the tree (skipping node_modules, target/test-classes, target/classes,
  build/classes, .gradle, .mvn, .git, .venv, etc.) — found nothing matching
  testng-results.xml, surefire-reports/*.xml, junit.xml, or report.json.

  Hints:
    • Run your tests first; surefire writes target/surefire-reports/testng-results.xml
      only after Maven completes the test phase (even on FAILURE).
    • If your tests succeeded but you don't see a report, your build may be
      configured with -DskipTests or a custom report location — pass it
      explicitly: tesbox upload-results <path> --api-key ...`
    );
    return 1;
  }

  const reportBuf = await fs.readFile(report.filePath);
  const reportName = path.basename(report.filePath);
  const format = formatHint || report.format || hintFormatFromName(report.filePath);

  if (!quiet) {
    log(
      `  \x1b[32m✓\x1b[0m Report  \x1b[2m${reportName}\x1b[0m  (${format || "auto"}, ${humanSize(
        reportBuf.length
      )})`
    );
  }

  const reportDir = (await statKind(absPath)) === "dir" ? absPath : path.dirname(absPath);
  const artifactOpts = { sinceMs: artifactsSinceMs, maxFiles: maxArtifactsPerKind };
  const screenshots = includeScreenshots ? await findArtifactFiles(reportDir, SCREENSHOT_EXTS, artifactOpts) : [];
  const videos = includeScreenshots ? await findArtifactFiles(reportDir, VIDEO_EXTS, artifactOpts) : [];
  const traces = includeScreenshots ? await findArtifactFiles(reportDir, TRACE_EXTS, artifactOpts) : [];

  if (!quiet && (screenshots.length || videos.length || traces.length)) {
    const filtered = artifactsSinceMs > 0 ? " (this build only)" : "";
    log(
      `  \x1b[32m✓\x1b[0m Artifacts  \x1b[2m${screenshots.length} screenshot${screenshots.length === 1 ? "" : "s"}, ${videos.length} video${videos.length === 1 ? "" : "s"}, ${traces.length} trace${traces.length === 1 ? "" : "s"}${filtered}\x1b[0m`
    );
  }

  if (!quiet) log(`  Resolving project  \x1b[2m${apiUrl}\x1b[0m`);
  let projectId;
  try {
    projectId = await resolveProjectId({ apiKey, apiUrl });
  } catch (err) {
    logErr(`  ${err.message}`);
    return 1;
  }
  if (!quiet) log(`  \x1b[32m✓\x1b[0m Project  \x1b[2m${projectId}\x1b[0m`);

  const fd = new FormData();
  fd.append("report", new Blob([reportBuf]), reportName);
  if (format) fd.append("format", format);
  if (runName) fd.append("runName", runName);
  if (sourceType) fd.append("sourceType", sourceType);
  if (runId) fd.append("runId", runId);
  if (buildId) fd.append("buildId", buildId);
  if (startedAt) fd.append("startedAt", startedAt);
  if (completedAt) fd.append("completedAt", completedAt);
  for (const f of screenshots) {
    const buf = await fs.readFile(f);
    fd.append("screenshots", new Blob([buf]), path.basename(f));
  }
  for (const f of videos) {
    const buf = await fs.readFile(f);
    fd.append("videos", new Blob([buf]), path.basename(f));
  }
  for (const f of traces) {
    const buf = await fs.readFile(f);
    fd.append("traces", new Blob([buf]), path.basename(f));
  }

  const ingestUrl = `${apiUrl.replace(/\/+$/, "")}/api/projects/${projectId}/tesbo-reports/ingest/test-report`;
  if (!quiet) log(`  Uploading  \x1b[2m${ingestUrl}\x1b[0m`);

  let result;
  try {
    result = await postMultipart({ url: ingestUrl, apiKey, formData: fd });
  } catch (err) {
    logErr(`  \x1b[31m✗\x1b[0m ${err.message}`);
    return 1;
  }

  const elapsed = ((Date.now() - startedMs) / 1000).toFixed(1);
  const counts = result?.counts || {};
  log(
    `\n  \x1b[32m✓ Uploaded\x1b[0m  ${counts.total ?? "?"} test${
      counts.total === 1 ? "" : "s"
    }  ·  \x1b[32m${counts.passed ?? 0} passed\x1b[0m  \x1b[31m${counts.failed ?? 0} failed\x1b[0m  \x1b[33m${counts.skipped ?? 0} skipped\x1b[0m  ·  \x1b[2m${elapsed}s\x1b[0m`
  );
  if (result?.runUrl) {
    log(`\n  View report  \x1b[36m${result.runUrl}\x1b[0m\n`);
  }
  if (result?.artifactsUploaded > 0 && !result?.artifactStorageConfigured) {
    log(
      `  \x1b[33m!\x1b[0m Artifacts were sent but storage is not configured server-side; screenshots will not appear in the dashboard.\n`
    );
  }

  return (counts.failed ?? 0) > 0 ? 1 : 0;
}

function humanSize(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
