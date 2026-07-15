// Personalized order-form links: a rep shares a unique URL with a customer, who lands on a
// lookbook of the collections curated for them and orders at wholesale pricing with their info
// prefilled. The link carries the curation + attribution; submissions land in the pending pool
// credited to the rep who created the link. Postgres-backed with the usual in-memory dev fallback.
import crypto from 'node:crypto';
import { pool, q } from './db.js';

const mem = new Map(); // token -> link (dev fallback)

const s = (v, n = 200) => (v == null ? '' : String(v).slice(0, n));

export async function createLink(by, body = {}) {
  const c = body.customer || {};
  const link = {
    token: crypto.randomBytes(6).toString('base64url'), // ~8 chars, URL-safe
    customer: {
      id: c.id ? String(c.id) : null,
      company: s(c.company || c.name),
      contact: s(c.contact),
      email: s(c.email, 254),
      phone: s(c.phone, 40),
    },
    collections: Array.isArray(body.collections) ? body.collections.map((h) => s(h, 80)).filter(Boolean) : [],
    note: s(body.note, 500),
    createdBy: by || null,
    createdAt: new Date().toISOString(),
    active: true,
    hits: 0,
  };
  if (!pool) {
    mem.set(link.token, link);
    return link;
  }
  await q(
    `INSERT INTO form_links (token, customer, collections, note, created_by, created_at, active, hits)
     VALUES ($1,$2,$3,$4,$5,$6,true,0)`,
    [link.token, link.customer, JSON.stringify(link.collections), link.note, link.createdBy, link.createdAt]
  );
  return link;
}

export async function resolveLink(token) {
  const t = String(token || '');
  if (!t || t.length > 32) return null;
  if (!pool) {
    const link = mem.get(t);
    if (link?.active) {
      link.hits++;
      link.lastUsedAt = new Date().toISOString();
      return link;
    }
    return null;
  }
  const { rows } = await q('SELECT * FROM form_links WHERE token = $1 AND active', [t]);
  if (!rows[0]) return null;
  q('UPDATE form_links SET hits = hits + 1, last_used_at = now() WHERE token = $1', [t]).catch(() => {});
  const r = rows[0];
  return {
    token: r.token,
    customer: r.customer || {},
    collections: r.collections || [],
    note: r.note || '',
    createdBy: r.created_by,
    active: r.active,
  };
}
