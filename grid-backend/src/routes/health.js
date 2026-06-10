import { Router } from "express";
import { getDatabaseDiagnostics } from "../db/diagnostics.js";
import { logger } from "../logger.js";
import { config } from "../config.js";

const router = Router();

// Basic health check
router.get("/health", async (req, res) => {
  res.json({ 
    status: "ok",
    timestamp: new Date().toISOString(),
    service: "grid-backend"
  });
});

// Detailed health check with database status
router.get("/health/detailed", async (req, res) => {
  try {
    const dbDiagnostics = await getDatabaseDiagnostics();
    
    const health = {
      status: dbDiagnostics.connection.status === "healthy" ? "ok" : "degraded",
      timestamp: new Date().toISOString(),
      service: "grid-backend",
      version: process.env.npm_package_version || "unknown",
      environment: process.env.NODE_ENV || "development",
      database: dbDiagnostics,
      config: {
        corsOrigins: config.corsAllowedOrigins,
        sessionDays: config.sessionDays,
        dbPoolMax: process.env.DB_POOL_MAX || 8,
      }
    };

    const statusCode = health.status === "ok" ? 200 : 503;
    res.status(statusCode).json(health);
  } catch (error) {
    logger.error("Health check failed:", error);
    res.status(503).json({
      status: "error",
      timestamp: new Date().toISOString(),
      service: "grid-backend",
      error: error.message
    });
  }
});

// Database pool statistics endpoint
router.get("/health/db-pool", async (req, res) => {
  try {
    const diagnostics = await getDatabaseDiagnostics();
    res.json(diagnostics);
  } catch (error) {
    logger.error("DB pool stats failed:", error);
    res.status(500).json({ error: "Failed to get database pool statistics" });
  }
});

export { router as healthRouter };