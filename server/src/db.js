// Postgres pool (reps, magic links, order audit, webhook dedup).
// Optional in M1 when AUTH_DISABLED=true; required for magic-link auth + M2 order capture.
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
