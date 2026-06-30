// Applies schema.sql to the configured DATABASE_URL.
import fs from 'node:fs';
import { pool } from './db.js';

if (!pool) {
  console.error('Set DATABASE_URL before running migrate.');
  process.exit(1);
}

const sql = fs.readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');
await pool.query(sql);
console.log('Migration applied.');
process.exit(0);
