import express from "express";
import { config } from "./config.js";
import { logInfo, logError } from "./logger.js";
import { ensureQueue } from "./services/queueService.js";
import { startIngestionWorker } from "./services/tesboIngestionService.js";
import { startScheduler } from "./scheduler.js";
import runsRouter from "./routes/runs.js";
import queueRouter from "./routes/queue.js";
import callbacksRouter from "./routes/callbacks.js";
import apikeysRouter from "./routes/apikeys.js";
import metricsRouter from "./routes/metrics.js";
import projectsRouter from "./routes/projects.js";
import seleniumSessionsRouter from "./routes/seleniumSessions.js";

process.on("uncaughtException", (err) => {
  logError("uncaught_exception", { error: err?.message || String(err), stack: err?.stack });
});
process.on("unhandledRejection", (reason) => {
  logError("unhandled_rejection", { error: reason instanceof Error ? reason.message : String(reason) });
});

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "64mb" }));

app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "tesbox-executions-api" });
});

app.use("/api/runs", runsRouter);
app.use("/api/queue", queueRouter);
app.use("/api/internal/execution", callbacksRouter);
app.use("/api/apikeys", apikeysRouter);
app.use("/api/projects", projectsRouter);
app.use("/api/internal/selenium-sessions", seleniumSessionsRouter);
app.use("/metrics", metricsRouter);

app.use((err, _req, res, _next) => {
  logError("unhandled_error", { error: err instanceof Error ? err.message : String(err) });
  res.status(500).json({ error: "Internal server error" });
});

app.listen(config.port, () => {
  ensureQueue();
  startIngestionWorker();
  startScheduler();
  logInfo("execution_api_started", { port: config.port });
});
