import { query as baseQuery } from "./database.js";
import { logger } from "../logger.js";

/**
 * Execute a query with timeout and retry logic
 * @param {string} text - SQL query text
 * @param {Array} params - Query parameters
 * @param {Object} options - Query options
 * @param {number} options.timeout - Query timeout in ms (default: 30000)
 * @param {number} options.retries - Number of retries (default: 2)
 * @param {string} options.queryName - Name for logging purposes
 */
export async function queryWithRetry(text, params, options = {}) {
  const {
    timeout = 30000,
    retries = 2,
    queryName = "unnamed"
  } = options;

  let lastError;
  
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      // Add statement timeout to the query
      const timeoutQuery = `
        SET LOCAL statement_timeout = ${timeout};
        ${text}
      `;
      
      const startTime = Date.now();
      const result = await Promise.race([
        baseQuery(text, params),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error(`Query timeout after ${timeout}ms`)), timeout)
        )
      ]);
      
      const duration = Date.now() - startTime;
      
      // Log slow queries
      if (duration > 5000) {
        logger.warn(`Slow query detected [${queryName}]: ${duration}ms`, {
          queryName,
          duration,
          attempt
        });
      }
      
      return result;
      
    } catch (error) {
      lastError = error;
      
      logger.error(`Query failed [${queryName}] attempt ${attempt + 1}/${retries + 1}:`, {
        error: error.message,
        queryName,
        attempt,
        isTimeout: error.message.includes("timeout"),
        isConnectionError: error.message.includes("connection")
      });
      
      // Don't retry on certain errors
      if (error.code === '23505' || // unique violation
          error.code === '23503' || // foreign key violation
          error.code === '22P02') { // invalid text representation
        throw error;
      }
      
      // Wait before retry (exponential backoff)
      if (attempt < retries) {
        const waitTime = Math.min(1000 * Math.pow(2, attempt), 5000);
        await new Promise(resolve => setTimeout(resolve, waitTime));
      }
    }
  }
  
  // All retries failed
  throw lastError;
}

/**
 * Helper to add query monitoring
 */
export function monitorQuery(queryName) {
  return {
    queryName,
    timeout: 30000,
    retries: 1
  };
}