import pg from "pg";
import { config } from "../config.js";

function buildSslOption(url) {
  if (!url) return undefined;
  if (/sslmode=require/i.test(url) || /sslmode=verify/i.test(url))
    return { rejectUnauthorized: false };
  if (/sslmode=disable/i.test(url)) return false;
  return undefined;
}

const pool = new pg.Pool({
  connectionString: config.dbUrl,
  ssl: buildSslOption(config.dbUrl),
  max: Number(process.env.DB_POOL_MAX || 10),
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 15000,
});

export function getPool() {
  return pool;
}

export async function query(text, params) {
  return pool.query(text, params);
}

export async function withClient(fn) {
  const client = await pool.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

export async function transaction(fn) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
