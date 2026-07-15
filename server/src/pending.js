// Pending order-form submissions: what a customer filled out on a kiosk tablet / QR link,
// waiting in a shared pool for ANY rep to review, adjust, and confirm into Shopify draft
// order(s). Postgres-backed in production; falls back to in-memory when DATABASE_URL is unset
// (local dev / AUTH_DISABLED) so the whole flow is testable without a database.
import crypto from 'node:crypto';
import { pool, q } from './db.js';

const mem = new Map(); // id -> row (dev fallback)

// Keep only what we expect from the client; quantities are re-priced/split server-side later.
function sanitizeLines(lines) {
  const out = [];
  for (const l of Array.isArray(lines) ? lines : []) {
    const qty = Math.floor(Number(l?.quantity) || 0);
    if (!l?.variantId || qty <= 0) continue;
    out.push({
      variantId: String(l.variantId),
      quantity: Math.min(qty, 100000),
      sku: l.sku != null ? String(l.sku).slice(0, 64) : null,
      title: l.title != null ? String(l.title).slice(0, 200) : null,
    });
  }
  return out;
}

function sanitizeCustomer(c = {}) {
  const s = (v, n = 200) => (v == null ? '' : String(v).slice(0, n));
  return {
    company: s(c.company),
    contact: s(c.contact),
    email: s(c.email, 254),
    phone: s(c.phone, 40),
  };
}

export function createPendingRow({ source, repEmail, repName, customer, lines, notes }) {
  const row = {
    id: crypto.randomUUID(),
    status: 'pending',
    source: ['qr', 'link', 'kiosk'].includes(source) ? source : 'kiosk',
    repEmail: repEmail || null,
    repName: repName || null,
    customer: sanitizeCustomer(customer),
    lines: sanitizeLines(lines),
    notes: notes != null ? String(notes).slice(0, 2000) : '',
    createdAt: new Date().toISOString(),
    handledBy: null,
    handledAt: null,
    result: null,
  };
  if (row.lines.length === 0) throw new Error('No items on the form');
  return row;
}

export async function savePending(row) {
  if (!pool) {
    mem.set(row.id, row);
    return row;
  }
  await q(
    `INSERT INTO pending_orders (id, status, source, rep_email, rep_name, customer, lines, notes, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [row.id, row.status, row.source, row.repEmail, row.repName, row.customer, JSON.stringify(row.lines), row.notes, row.createdAt]
  );
  return row;
}

function fromDb(r) {
  return {
    id: r.id,
    status: r.status,
    source: r.source,
    repEmail: r.rep_email,
    repName: r.rep_name,
    customer: r.customer || {},
    lines: r.lines || [],
    notes: r.notes || '',
    createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : r.created_at,
    handledBy: r.handled_by,
    handledAt: r.handled_at instanceof Date ? r.handled_at?.toISOString() : r.handled_at,
    result: r.result,
  };
}

// The shared pool: everything pending (newest first) + the most recently handled few for context.
export async function listPending() {
  if (!pool) {
    const all = [...mem.values()].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    return [...all.filter((r) => r.status === 'pending'), ...all.filter((r) => r.status !== 'pending').slice(0, 10)];
  }
  const { rows } = await q(
    `(SELECT * FROM pending_orders WHERE status = 'pending' ORDER BY created_at DESC LIMIT 200)
     UNION ALL
     (SELECT * FROM pending_orders WHERE status <> 'pending' ORDER BY handled_at DESC NULLS LAST LIMIT 10)`
  );
  return rows.map(fromDb);
}

export async function getPending(id) {
  if (!pool) return mem.get(id) || null;
  const { rows } = await q('SELECT * FROM pending_orders WHERE id = $1', [id]);
  return rows[0] ? fromDb(rows[0]) : null;
}

export async function markHandled(id, { status, by, result = null }) {
  const at = new Date().toISOString();
  if (!pool) {
    const row = mem.get(id);
    if (row) Object.assign(row, { status, handledBy: by, handledAt: at, result });
    return row || null;
  }
  const { rows } = await q(
    `UPDATE pending_orders SET status=$2, handled_by=$3, handled_at=$4, result=$5 WHERE id=$1 RETURNING *`,
    [id, status, by, at, result ? JSON.stringify(result) : null]
  );
  return rows[0] ? fromDb(rows[0]) : null;
}
