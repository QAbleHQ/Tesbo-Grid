import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getPool } from "./database.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function migrate() {
  const pool = getPool();
  const migrationsDir = path.join(__dirname, "migrations");
  const files = fs.readdirSync(migrationsDir).filter(f => f.endsWith(".sql")).sort();

  await pool.query(`
    CREATE TABLE IF NOT EXISTS _migrations (
      name TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  const { rows: applied } = await pool.query("SELECT name FROM _migrations");
  const appliedSet = new Set(applied.map(r => r.name));

  for (const file of files) {
    if (appliedSet.has(file)) continue;
    const sql = fs.readFileSync(path.join(migrationsDir, file), "utf8");
    console.log(`Applying migration: ${file}`);
    
    // Split SQL into statements and execute each separately
    // This allows transaction-incompatible commands like CREATE INDEX CONCURRENTLY
    const statements = sql
      .split(';')
      .map(s => s.trim())
      .filter(s => s.length > 0 && !s.startsWith('--'));
    
    for (const statement of statements) {
      if (statement.trim()) {
        await pool.query(statement);
      }
    }
    
    await pool.query("INSERT INTO _migrations (name) VALUES ($1)", [file]);
  }

  console.log("Migrations complete.");
  await pool.end();
}

migrate().catch(err => {
  console.error("Migration failed:", err);
  process.exit(1);
});
