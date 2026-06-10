import http from "node:http";
import express from "express";
import cors from "cors";
import { config } from "./config.js";
import { logger } from "./logger.js";
import { query } from "./db/database.js";
import { sessionMiddleware } from "./middleware/session.js";
import authRoutes from "./routes/auth.js";
import onboardingRoutes from "./routes/onboarding.js";
import workspaceRoutes from "./routes/workspace.js";
import projectRoutes from "./routes/projects.js";
import apikeyRoutes from "./routes/apikeys.js";
import reportsRoutes from "./routes/reports.js";
import alertRoutes from "./routes/alerts.js";
import githubRoutes, { githubWebhookRouter } from "./routes/github.js";
import projectEnvironmentRoutes from "./routes/projectEnvironments.js";
import {
  accessKeyProjectRoutes,
  keyResolutionRoutes,
  projectInternalRoutes,
} from "./routes/access-keys.js";
import { registerVncUpgrade } from "./routes/seleniumLiveVnc.js";
import { startStaleRunSweeper } from "./jobs/staleRunSweeper.js";
import { startGithubCronScheduler } from "./services/github/cronScheduler.js";

const app = express();

app.disable("x-powered-by");
app.set("trust proxy", 1);

app.use(
  cors({
    origin: config.corsAllowedOrigins,
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "x-project-access-key"],
  })
);

// GitHub webhook signatures are HMAC over the raw body, so this route MUST be
// mounted before the global express.json() middleware below.
app.use("/api/github/webhooks", githubWebhookRouter);

app.use(
  "/api/projects/:projectId/tesbo-reports/ingest",
  express.json({ limit: "50mb" }),
);
app.use(express.json({ limit: "2mb" }));
app.use(sessionMiddleware);

// Liveness: process is up. Intentionally does NOT touch the DB so a transient
// DB blip can't trigger container restarts via the docker healthcheck.
app.get("/health", (_req, res) => res.json({ status: "ok" }));

// Readiness: verifies the DB is actually reachable from the connection pool.
// This is what surfaces connection-pool exhaustion / DB saturation — the
// condition that otherwise silently degrades every authenticated request to a
// 401. Point monitoring/alerting at this endpoint, not /health.
app.get("/health/db", async (_req, res) => {
  try {
    await query("SELECT 1");
    res.json({ status: "ok", db: "ok" });
  } catch (err) {
    logger.error("readiness check failed (db unreachable):", err);
    res.status(503).json({ status: "error", db: "unreachable" });
  }
});

app.use("/api/auth", authRoutes);
app.use("/api/onboarding", onboardingRoutes);
app.use("/api/workspace", workspaceRoutes);
app.use("/api/projects", projectRoutes);
app.use("/api/projects", apikeyRoutes);
app.use("/api/projects", reportsRoutes);
app.use("/api/projects", alertRoutes);
app.use("/api/github", githubRoutes);
app.use("/api/projects", projectEnvironmentRoutes);
app.use("/api/projects", accessKeyProjectRoutes);
app.use("/api/tesbo-reports", keyResolutionRoutes);
app.use("/api/internal", projectInternalRoutes);

app.use((_req, res) => res.status(404).json({ error: "Not found" }));

app.use((err, _req, res, _next) => {
  logger.error("Unhandled error:", err);
  res.status(500).json({ error: "Internal server error" });
});

// We need an explicit http.Server so we can attach an `upgrade` listener for
// the live-VNC WebSocket relay (Express alone doesn't expose one).
const server = http.createServer(app);
registerVncUpgrade(server);
server.listen(config.port, () => {
  logger.info(`TesboGrid App API running on port ${config.port}`);
  logger.info(`Database: ${config.dbUrl.replace(/\/\/.*@/, "//***@")}`);
  logger.info(`CORS origins: ${config.corsAllowedOrigins.join(", ")}`);

  if (config.runIdleTimeoutMs > 0) {
    startStaleRunSweeper({
      idleThresholdMs: config.runIdleTimeoutMs,
      intervalMs: config.runSweepIntervalMs,
    });
  } else {
    logger.info("Stale run sweeper disabled (RUN_IDLE_TIMEOUT_MS=0)");
  }

  startGithubCronScheduler();
});
