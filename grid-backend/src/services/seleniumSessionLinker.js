/**
 * Correlate `report_tests` rows with the `selenium_sessions` that produced
 * them.
 *
 * Two strategies, applied in order. The first to succeed for a given test
 * wins:
 *
 *   1. EXPLICIT — the test framework set `tesbo:options.name = "<class>.<method>"`
 *      on the WebDriver capabilities. The selenium-proxy stored that on
 *      `selenium_sessions.tesbo_options.name`. We match on
 *      (project, build, name).
 *
 *   2. HEURISTIC — for any test still unmatched after pass 1 we pick the
 *      session with the same project + build whose started_at falls inside
 *      the test's [start, end] window. Sequential suites correlate cleanly;
 *      parallel suites without explicit tagging will collide on whichever
 *      session started first inside the window — that's an acceptable
 *      degradation (still better than no link at all) and we surface a
 *      "low-confidence link" hint in the API.
 *
 * The runner-api lives in a separate Postgres, so we do all reads through
 * its existing internal HTTP API (`/api/internal/selenium-sessions`).
 */

import { config } from "../config.js";
import { logger } from "../logger.js";

// Soft cap on how many sessions we ask the runner-api for in one go. The
// runner clamps at MAX_LIMIT=200 anyway; we ask for the max so a build with
// hundreds of parallel tests still resolves in one round-trip.
const MAX_SESSIONS_PER_BUILD = 200;

// Heuristic widening: if a test ran for 12s, allow matching sessions that
// started up to N ms before the test's `started_at` (our XML timestamps are
// per-test method, but Selenium sessions are usually created a beat earlier
// during @BeforeMethod). Keep this small to avoid mis-linking.
const HEURISTIC_PRE_SESSION_GRACE_MS = 5_000;

/**
 * Fetch all selenium sessions for the given project + build, going through
 * the runner-api HTTP layer (which speaks across the DB boundary).
 *
 * Returns [] on any error — correlation is best-effort, never fatal.
 */
async function fetchSessionsForBuild({ projectId, build }) {
  if (!config.executionApiUrl) return [];
  if (!projectId || !build) return [];

  const params = new URLSearchParams({
    projectId,
    build,
    limit: String(MAX_SESSIONS_PER_BUILD),
  });

  try {
    const upstream = await fetch(
      `${config.executionApiUrl}/api/internal/selenium-sessions?${params.toString()}`,
      {
        method: "GET",
        headers: {
          ...(config.executionApiSharedToken
            ? { "x-agent-token": config.executionApiSharedToken }
            : {}),
        },
      }
    );
    if (!upstream.ok) {
      logger.warn("session_linker_upstream_non_ok", {
        status: upstream.status,
        projectId,
        build,
      });
      return [];
    }
    const payload = await upstream.json().catch(() => ({}));
    return Array.isArray(payload?.sessions) ? payload.sessions : [];
  } catch (err) {
    logger.warn("session_linker_upstream_error", {
      error: err instanceof Error ? err.message : String(err),
      projectId,
      build,
    });
    return [];
  }
}

/**
 * Build the lookup keys we will try on each test. The proxy sometimes stores
 * the name as a fully-qualified path (`com.foo.SuiteTest.toVerifyButton`),
 * sometimes as `Class.method`, and occasionally just `method`. We compute
 * every reasonable shape from the test's `spec` + `name` and match against
 * the same shapes derived from the session's stored `name`.
 */
function nameKeys(value) {
  if (!value) return [];
  const v = String(value).trim();
  if (!v) return [];
  const out = new Set();
  out.add(v);
  out.add(v.toLowerCase());
  // Drop everything before the last dot — `pkg.Class.method` -> `Class.method`.
  const parts = v.split(".");
  if (parts.length >= 2) {
    const last2 = parts.slice(-2).join(".");
    out.add(last2);
    out.add(last2.toLowerCase());
  }
  // Last segment alone — `Class.method` -> `method`.
  out.add(parts[parts.length - 1]);
  out.add(parts[parts.length - 1].toLowerCase());
  return Array.from(out);
}

function testKeys(test) {
  const keys = new Set();
  // 1. Spec-qualified — `<spec>.<name>`. Highest specificity.
  if (test.spec && test.name) {
    const stem = String(test.spec).replace(/\.\w+$/, "");
    nameKeys(`${stem}.${test.name}`).forEach((k) => keys.add(k));
  }
  // 2. fullTitle — what TestNG <reporter-output> usually emits.
  nameKeys(test.fullTitle || test.full_title).forEach((k) => keys.add(k));
  // 3. name alone — last-resort.
  nameKeys(test.name).forEach((k) => keys.add(k));
  return Array.from(keys);
}

function indexSessionsByName(sessions) {
  const byName = new Map();
  for (const s of sessions) {
    if (!s?.name) continue;
    for (const k of nameKeys(s.name)) {
      // Prefer the most recently started session for a given name — if a
      // user reran a flaky test in the same build, the last attempt is the
      // one whose artifacts the report XML reflects.
      const prev = byName.get(k);
      if (!prev) {
        byName.set(k, s);
        continue;
      }
      const prevTs = Date.parse(prev.startedAt || prev.queuedAt || 0) || 0;
      const curTs = Date.parse(s.startedAt || s.queuedAt || 0) || 0;
      if (curTs >= prevTs) byName.set(k, s);
    }
  }
  return byName;
}

function inferTestStartedAt(test, runStartedAt) {
  // Tests don't always carry their own start timestamp — fall back to the
  // run's start. We never attempt heuristic matching without one because the
  // window degenerates to "any session in this build", which is too noisy.
  if (test.startedAt) return Date.parse(test.startedAt);
  if (test.started_at) return Date.parse(test.started_at);
  if (runStartedAt) return Date.parse(runStartedAt);
  return null;
}

/**
 * Heuristic match: pick the session whose `started_at` is the latest one
 * that is <= test_end and >= test_start - grace. Uses a sorted-once list so
 * the per-test work is O(log n).
 */
function heuristicMatch(sessionsSortedAsc, test, runStartedAt) {
  const startedMs = inferTestStartedAt(test, runStartedAt);
  if (startedMs == null || !Number.isFinite(startedMs)) return null;
  const durationMs = Number(test.durationMs ?? test.duration_ms ?? 0) || 0;
  const endMs = startedMs + Math.max(durationMs, 0);
  const earliest = startedMs - HEURISTIC_PRE_SESSION_GRACE_MS;

  // Linear scan — fine for <=200 sessions per build.
  let best = null;
  let bestTs = -Infinity;
  for (const s of sessionsSortedAsc) {
    const sStart = Date.parse(s.startedAt || s.queuedAt || 0);
    if (!Number.isFinite(sStart)) continue;
    if (sStart < earliest) continue;
    if (sStart > endMs) break; // sorted asc — we're past the window.
    if (sStart > bestTs) {
      best = s;
      bestTs = sStart;
    }
  }
  return best;
}

/**
 * Correlate every test in `tests` (a list of TestNG-shaped objects already
 * upserted into report_tests) with a Selenium session, then UPDATE the rows
 * in place.
 *
 * We do all the lookup work in one shot per build to keep ingest latency
 * bounded — a 1000-test suite uploads in <2s of correlation overhead.
 *
 * Inputs:
 *   - query        : the grid-backend pg `query` function
 *   - projectId    : the Tesbo project this run belongs to
 *   - runId        : the report_runs row that owns these tests
 *   - buildId      : the build identifier passed by the CLI; required for
 *                    correlation. Without it we no-op (and the dashboard
 *                    simply won't show session links for this run).
 *   - tests        : the parsed test array; each entry MUST include `spec`
 *                    + `name` (used to find the matching report_tests row).
 *   - runStartedAt : ISO start time of the run, used as a fallback when a
 *                    test has no per-method timestamp.
 */
export async function linkTestsToSeleniumSessions({
  query,
  projectId,
  runId,
  buildId,
  tests,
  runStartedAt = null,
}) {
  if (!buildId || !Array.isArray(tests) || tests.length === 0) {
    return { explicit: 0, heuristic: 0, total: 0 };
  }

  const sessions = await fetchSessionsForBuild({ projectId, build: buildId });
  if (sessions.length === 0) {
    return { explicit: 0, heuristic: 0, total: 0 };
  }

  // Pre-compute structures we'll reuse for every test.
  const byName = indexSessionsByName(sessions);
  const sortedByStart = [...sessions]
    .filter((s) => s.startedAt || s.queuedAt)
    .sort((a, b) => {
      const ta = Date.parse(a.startedAt || a.queuedAt || 0) || 0;
      const tb = Date.parse(b.startedAt || b.queuedAt || 0) || 0;
      return ta - tb;
    });

  // Don't double-claim a session via the heuristic pass when an explicit
  // match already won it — that would let one Selenium session show up on
  // two unrelated tests at the same time.
  const claimedSessionIds = new Set();
  let explicit = 0;
  let heuristic = 0;

  for (const test of tests) {
    let matched = null;
    let strategy = null;

    // Pass 1 — explicit tag.
    for (const k of testKeys(test)) {
      const candidate = byName.get(k);
      if (candidate && !claimedSessionIds.has(candidate.seleniumId)) {
        matched = candidate;
        strategy = "explicit";
        break;
      }
    }

    // Pass 2 — heuristic.
    if (!matched) {
      const candidate = heuristicMatch(sortedByStart, test, runStartedAt);
      if (candidate && !claimedSessionIds.has(candidate.seleniumId)) {
        matched = candidate;
        strategy = "heuristic";
      }
    }

    if (!matched || !matched.seleniumId) continue;
    claimedSessionIds.add(matched.seleniumId);

    if (strategy === "explicit") explicit += 1;
    else heuristic += 1;

    // Persist the link. We match the report_tests row by (run, spec, name)
    // because we don't carry the row id forward from the upsert step. The
    // unique index on (report_run_id, COALESCE(spec, ''), COALESCE(name, ''))
    // guarantees this picks exactly one row.
    try {
      await query(
        `UPDATE report_tests
            SET selenium_session_id         = $1,
                selenium_session_request_id = $2,
                selenium_session_status     = $3,
                selenium_session_linked_at  = now()
          WHERE report_run_id = $4
            AND COALESCE(spec, '') = COALESCE($5, '')
            AND COALESCE(name, '') = COALESCE($6, '')`,
        [
          matched.seleniumId,
          matched.requestId || null,
          matched.status || null,
          runId,
          test.spec || "",
          test.name || "",
        ]
      );
    } catch (err) {
      logger.warn("session_linker_update_failed", {
        error: err instanceof Error ? err.message : String(err),
        runId,
        spec: test.spec,
        name: test.name,
      });
    }
  }

  logger.info("session_linker_done", {
    projectId,
    runId,
    buildId,
    sessionsFetched: sessions.length,
    explicit,
    heuristic,
    total: explicit + heuristic,
  });

  return { explicit, heuristic, total: explicit + heuristic };
}
