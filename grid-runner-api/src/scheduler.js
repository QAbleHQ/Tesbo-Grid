import { config } from "./config.js";
import { recoverStuckRunningJobs, dispatchAllProjectsWithPendingJobs } from "./services/dispatchService.js";
import { logInfo, logError } from "./logger.js";

let intervalRef = null;

export function startScheduler() {
  if (intervalRef) return;

  const intervalMs = Math.max(1000, Number(config.schedulerTickMs || 5000));
  intervalRef = setInterval(async () => {
    try {
      await recoverStuckRunningJobs(config.staleJobMinutes);
      await dispatchAllProjectsWithPendingJobs();
    } catch (err) {
      logError("scheduler_tick_failed", { error: err.message });
    }
  }, intervalMs);

  if (typeof intervalRef.unref === "function") intervalRef.unref();
  logInfo("scheduler_started", { intervalMs });
}
