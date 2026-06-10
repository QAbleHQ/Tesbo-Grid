import cronParser from "cron-parser";
import { withClient, query } from "../../db/database.js";
import { config } from "../../config.js";
import { logger } from "../../logger.js";
import { dispatchScheduleRun } from "./scheduleDispatcher.js";

export function startGithubCronScheduler() {
  if (!config.github.appId) {
    logger.info("GitHub cron scheduler disabled (no GH_APP_ID configured)");
    return () => {};
  }
  const tickMs = config.github.cronTickMs > 0 ? config.github.cronTickMs : 30_000;
  logger.info(`GitHub cron scheduler enabled (tick=${Math.round(tickMs / 1000)}s)`);
  const handle = setInterval(() => {
    tickOnce().catch((err) => logger.error("GitHub cron tick failed:", err));
  }, tickMs);
  handle.unref?.();
  return () => clearInterval(handle);
}

export async function tickOnce() {
  await withClient(async (client) => {
    await client.query("BEGIN");
    try {
      const due = await client.query(
        // Only id + cron_expression are needed here: id to advance/dispatch,
        // cron_expression to compute the next fire. dispatchDueSchedule re-loads
        // the full schedule + integration when it actually dispatches.
        `SELECT s.id, s.cron_expression
         FROM github_run_schedules s
         WHERE s.trigger_type = 'cron'
           AND s.enabled = TRUE
           AND s.next_fire_at IS NOT NULL
           AND s.next_fire_at <= now()
         ORDER BY s.next_fire_at
         LIMIT 25
         FOR UPDATE SKIP LOCKED`
      );
      for (const sched of due.rows) {
        const next = computeNextFire(sched.cron_expression);
        await client.query(
          `UPDATE github_run_schedules
           SET last_fired_at = now(), next_fire_at = $1, updated_at = now()
           WHERE id = $2`,
          [next, sched.id]
        );
      }
      await client.query("COMMIT");

      for (const sched of due.rows) {
        dispatchDueSchedule(sched.id).catch((err) =>
          logger.error(`GitHub cron schedule ${sched.id} dispatch failed: ${err.message}`)
        );
      }
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    }
  });
}

// Dispatch one due schedule. Tesbo Grid owns the trigger: we workflow_dispatch
// the schedule's workflow and record the GitHub Actions run URL, identically to
// a manual "Run now" — so automated runs show the build/logs link in history.
async function dispatchDueSchedule(scheduleId) {
  const sres = await query(`SELECT * FROM github_run_schedules WHERE id = $1`, [scheduleId]);
  const schedule = sres.rows[0];
  if (!schedule) return;
  const ires = await query(`SELECT * FROM github_integrations WHERE id = $1`, [schedule.integration_id]);
  const integration = ires.rows[0];
  if (!integration) {
    logger.warn(`GitHub cron: schedule ${scheduleId} has no integration; skipping`);
    return;
  }

  const result = await dispatchScheduleRun({ integration, schedule, triggerSource: "automated" });
  if (result.ok) {
    logger.info(`GitHub cron: dispatched schedule ${scheduleId}`, {
      runUrl: result.githubActionsRunUrl,
      runLogId: result.runLogId,
    });
  } else {
    logger.warn(`GitHub cron: schedule ${scheduleId} not dispatched (${result.code}): ${result.error}`);
  }
}

export function computeNextFire(cronExpression, from = new Date()) {
  try {
    const it = cronParser.parseExpression(cronExpression, { currentDate: from, tz: "UTC" });
    return it.next().toDate();
  } catch (err) {
    logger.warn(`Invalid cron expression "${cronExpression}": ${err.message}`);
    return null;
  }
}
