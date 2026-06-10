import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { query } from "./database.js";
import { logger } from "../logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(__dirname, "migrations");

async function ensureMigrationsTable() {
  await query(`
    CREATE TABLE IF NOT EXISTS _app_api_migrations (
      id   SERIAL PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}

async function getAppliedMigrations() {
  const result = await query(
    "SELECT name FROM _app_api_migrations ORDER BY id"
  );
  return new Set(result.rows.map((r) => r.name));
}

async function run() {
  await ensureMigrationsTable();
  const applied = await getAppliedMigrations();
  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  let count = 0;
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), "utf8");
    logger.info(`Applying migration: ${file}`);
    
    // Split SQL into statements and execute each separately so transaction-
    // incompatible commands (e.g. CREATE INDEX CONCURRENTLY) can run. Strip
    // -- line comments and /* */ block comments BEFORE splitting on `;` so a
    // semicolon inside a comment doesn't shear a statement in half.
    const stripped = sql
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/--[^\n]*/g, '');
    const statements = stripped
      .split(';')
      .map(s => s.trim())
      .filter(s => s.length > 0);
    
    for (const statement of statements) {
      if (statement.trim()) {
        await query(statement);
      }
    }
    
    await query("INSERT INTO _app_api_migrations (name) VALUES ($1)", [file]);
    count++;
  }
  logger.info(
    count > 0
      ? `Applied ${count} migration(s).`
      : "No new migrations to apply."
  );
}

// A transient inability to reach the DB at boot (connection-pool/slot
// exhaustion, DB restarting, brief network blip) must NOT instantly exit(1).
// On a small shared cluster, exiting turns the container into a crash-loop
// whose own churn keeps the DB saturated, so it can never recover. Instead we
// back off and retry — by the time we give up, idle_session_timeout on the
// cluster has reaped abandoned connections and a slot is free.
function isTransientDbError(err) {
  const code = err?.code;
  if (
    code === "53300" || // too_many_connections
    code === "57P03" || // cannot_connect_now (DB starting up)
    code === "ECONNREFUSED" ||
    code === "ETIMEDOUT" ||
    code === "ECONNRESET"
  ) {
    return true;
  }
  return /too many clients|connection slots|timeout|ECONNRESET|terminating connection|the database system is/i.test(
    err?.message || ""
  );
}

async function runWithRetry() {
  const maxAttempts = 10;
  let delayMs = 2000;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await run();
      return;
    } catch (err) {
      const transient = isTransientDbError(err);
      if (!transient || attempt === maxAttempts) {
        logger.error(
          `Migration failed (attempt ${attempt}/${maxAttempts}, ${
            transient ? "out of retries" : "non-transient"
          }):`,
          err
        );
        process.exit(1);
      }
      logger.error(
        `Migration attempt ${attempt}/${maxAttempts} hit a transient DB error (${
          err?.code || err?.message
        }); retrying in ${delayMs}ms`
      );
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      delayMs = Math.min(delayMs * 2, 30000);
    }
  }
}

runWithRetry().then(() => process.exit(0));
