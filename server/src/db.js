// Postgres pool (reps, magic links, order audit, webhook dedup, OAuth token).
// Optional in M1 when AUTH_DISABLED=true; required for OAuth install + magic-link auth + M2.
import fs from 'node:fs';
import pg from 'pg';
import { cfg } from './config.js';

const isLocal = cfg.databaseUrl.includes('localhost') || cfg.databaseUrl.includes('127.0.0.1');

export const pool = cfg.databaseUrl
  ? new pg.Pool({
      connectionString: cfg.databaseUrl,
      ssl: isLocal ? false : { rejectUnauthorized: false },
    })
  : null;

export async function q(text, params) {
  if (!pool) throw new Error('DATABASE_URL is not set');
  return pool.query(text, params);
}

// Idempotent schema apply (schema.sql uses CREATE TABLE IF NOT EXISTS) — safe to run every boot.
export async function runMigrations() {
  if (!pool) return false;
  const sql = fs.readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');
  await pool.query(sql);
  return true;
}
