import { getPool } from "./database.js";
import { logger } from "../logger.js";

/**
 * Database connection diagnostics
 */
export async function getDatabaseDiagnostics() {
  const pool = getPool();
  
  try {
    const diagnostics = {
      pool: {
        totalCount: pool.totalCount,
        idleCount: pool.idleCount,
        waitingCount: pool.waitingCount,
      },
      timestamp: new Date().toISOString(),
    };

    // Test query
    const startTime = Date.now();
    const result = await pool.query("SELECT NOW() as current_time, current_database() as db");
    const queryTime = Date.now() - startTime;

    diagnostics.connection = {
      status: "healthy",
      database: result.rows[0].db,
      serverTime: result.rows[0].current_time,
      queryTimeMs: queryTime,
    };

    return diagnostics;
  } catch (error) {
    logger.error("Database diagnostics failed:", error);
    return {
      pool: {
        totalCount: pool.totalCount || 0,
        idleCount: pool.idleCount || 0,
        waitingCount: pool.waitingCount || 0,
      },
      connection: {
        status: "unhealthy",
        error: error.message,
      },
      timestamp: new Date().toISOString(),
    };
  }
}

/**
 * Middleware to add database health check
 */
export async function checkDatabaseHealth(req, res, next) {
  const pool = getPool();
  
  // Check if pool is exhausted
  if (pool.waitingCount > 5) {
    logger.warn(`Database pool congestion: ${pool.waitingCount} waiting connections`);
  }
  
  // Check if we have available connections
  if (pool.idleCount === 0 && pool.totalCount >= (process.env.DB_POOL_MAX || 8)) {
    logger.error("Database pool exhausted - no idle connections available");
    return res.status(503).json({ 
      error: "Service temporarily unavailable",
      details: "Database connection pool exhausted"
    });
  }
  
  next();
}