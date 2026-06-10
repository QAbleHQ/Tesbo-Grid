import { query } from "../db/database.js";
import { logger } from "../logger.js";

/**
 * Watchdog that auto-closes report_runs rows stuck in IN_PROGRESS.
 *
 * Why this exists:
 *   The CLI (tesbox) is responsible for finalizing a run by POSTing the
 *   final report. When the test process crashes, the runner is killed,
 *   the network drops, or CI is cancelled, that finalize call never
 *   arrives — the row is left as IN_PROGRESS and the dashboard shows
 *   "Running" forever.
 *
 * Behaviour:
 *   Every `intervalMs`, find rows where status='IN_PROGRESS' and the row
 *   hasn't been touched (updated_at) for at least `idleThresholdMs`. We
 *   key off updated_at so that any partial test ingest resets the clock
 *   — a slow but still-progressing run is NOT considered stale.
 *
 *   Stale rows are flipped to TIMED_OUT, completed_at=now(). Wall-clock
 *   duration is recomputed from started_at..completed_at.
 *
 * Defaults:
 *   - Idle threshold: 3 hours (no test result update)
 *   - Sweep interval: every 10 minutes
 *
 * Both configurable via env (RUN_IDLE_TIMEOUT_MS, RUN_SWEEP_INTERVAL_MS).
 */
export function startStaleRunSweeper({ idleThresholdMs, intervalMs } = {}) {
  const idleMs = idleThresholdMs ?? 3 * 60 * 60 * 1000; // 3h
  const tickMs = intervalMs ?? 10 * 60 * 1000;          // 10min

  // Run once shortly after boot so the first sweep doesn't wait a full
  // interval. Stagger the initial run so multiple replicas don't all
  // fire at the exact same instant if this is ever scaled out.
  const initialDelay = Math.min(60_000, tickMs);
  const startupTimer = setTimeout(() => {
    void sweepOnce(idleMs).catch((err) =>
      logger.error("Stale run sweep (initial) failed:", err)
    );
  }, initialDelay);

  const handle = setInterval(() => {
    void sweepOnce(idleMs).catch((err) =>
      logger.error("Stale run sweep failed:", err)
    );
  }, tickMs);

  // Don't keep the event loop alive solely for this timer.
  if (typeof handle.unref === "function") handle.unref();
  if (typeof startupTimer.unref === "function") startupTimer.unref();

  logger.info(
    `Stale run sweeper enabled (idle=${Math.round(idleMs / 60000)}min, ` +
    `interval=${Math.round(tickMs / 60000)}min)`
  );

  return () => {
    clearTimeout(startupTimer);
    clearInterval(handle);
  };
}

/**
 * Single pass — exported for tests / manual triggering.
 *
 * Returns the rows that were closed so callers can log / alert on them.
 */
export async function sweepOnce(idleMs) {
  // Recompute duration_ms from wall-clock when possible — summed per-test
  // duration is wrong for parallel runs and would be misleading to display.
  const result = await query(
    `UPDATE report_runs
        SET status = 'TIMED_OUT',
            completed_at = now(),
            duration_ms = COALESCE(
              GREATEST(
                0,
                FLOOR(
                  EXTRACT(EPOCH FROM (now() - started_at)) * 1000
                )::INTEGER
              ),
              duration_ms
            ),
            updated_at = now()
      WHERE status = 'IN_PROGRESS'
        AND updated_at < now() - ($1::bigint || ' milliseconds')::interval
      RETURNING id, project_id, run_name, started_at, updated_at`,
    [String(idleMs)]
  );

  if (result.rows.length > 0) {
    logger.warn(
      `Stale run sweeper closed ${result.rows.length} run(s) idle > ${Math.round(
        idleMs / 60000
      )}min:`,
      result.rows.map((r) => ({
        runId: r.id,
        projectId: r.project_id,
        runName: r.run_name,
        idleMs: Date.now() - new Date(r.updated_at).getTime(),
      }))
    );
  }

  return result.rows;
}
