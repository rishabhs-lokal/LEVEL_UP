// Generic Postgres client. No app-specific queries live here — this module
// only knows how to connect, query, run transactions, and report health
// against any Postgres-compliant database reachable via DATABASE_URL.
import pg from 'pg';

const { Pool } = pg;

export const dbEnabled = Boolean(process.env.DATABASE_URL);

let pool = null;

function buildPool() {
  return new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
    max: Number(process.env.DB_POOL_MAX || 10),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });
}

export function getPool() {
  if (!dbEnabled) return null;
  if (!pool) pool = buildPool();
  return pool;
}

export async function query(text, params = []) {
  const p = getPool();
  if (!p) throw new Error('DATABASE_URL is not configured');
  return p.query(text, params);
}

export async function withTransaction(fn) {
  const p = getPool();
  if (!p) throw new Error('DATABASE_URL is not configured');
  const client = await p.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function healthCheck() {
  if (!dbEnabled) return { ok: true, configured: false };
  try {
    await query('SELECT 1');
    return { ok: true, configured: true };
  } catch (err) {
    return { ok: false, configured: true, error: err.message };
  }
}

// Called from the server's SIGTERM/SIGINT handler so pods drain cleanly
// during a Kubernetes rolling update instead of dropping connections.
export async function closePool() {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
