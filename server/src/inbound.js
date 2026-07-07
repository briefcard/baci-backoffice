// Inbound shipment tracking (admin-only back office). Postgres-backed with the same in-memory
// dev fallback pattern as pending.js. This is the logistics source of truth: what's on the way
// from each facility, when it lands, and the QA'd intake (counted / damaged / binned) that
// replaces the Google Sheet.
//
// It also FEEDS THE SALES FLOOR: open shipments roll up to per-variant incoming totals and an
// earliest ETA, which the snapshot overlays onto variants — so reps see reliable
// "BackOrder · <date>" info without any Shopify writes. On receive, good units are pushed to
// Shopify stock (+ bin codes to the warehouse.bin_location product metafield) when scopes
// allow; otherwise the write queues (shopify_synced=false) until the scope re-auth lands.
import crypto from 'node:crypto';
import { pool, q } from './db.js';
import { cfg } from './config.js';
import { shopifyGraphQL } from './shopify.js';
import { cache, setInboundOverlay } from './snapshot.js';

const memShipments = new Map(); // id -> shipment (with .lines[]) when no DATABASE_URL

export const SHIPMENT_STATUSES = ['ordered', 'in_transit', 'arrived', 'receiving', 'received', 'cancelled'];
const OPEN_STATUSES = ['ordered', 'in_transit', 'arrived', 'receiving'];

const s = (v, n = 300) => (v == null ? null : String(v).slice(0, n));

function sanitizeLines(lines) {
  const out = [];
  for (const l of Array.isArray(lines) ? lines : []) {
    const sku = s(l?.sku, 64);
    if (!sku) continue;
    out.push({
      id: l.id || crypto.randomUUID(),
      variantId: l.variantId ? String(l.variantId) : null,
      sku,
      title: s(l.title, 200),
      expected: Math.max(0, Math.floor(Number(l.expected) || 0)),
      received: l.received == null ? null : Math.max(0, Math.floor(Number(l.received) || 0)),
      damaged: Math.max(0, Math.floor(Number(l.damaged) || 0)),
      bins: Array.isArray(l.bins)
        ? l.bins
            .map((b) => ({ bin: s(b?.bin, 24), qty: Math.max(0, Math.floor(Number(b?.qty) || 0)) }))
            .filter((b) => b.bin)
        : [],
      shopifySynced: !!l.shopifySynced,
      syncError: l.syncError || null,
      receivedAt: l.receivedAt || null,
      receivedBy: l.receivedBy || null,
    });
  }
  return out;
}

// Try to resolve a SKU to a variant in the live catalog cache (case-insensitive).
export function matchSku(sku) {
  const want = String(sku || '').trim().toLowerCase();
  if (!want) return null;
  for (const p of cache.products) {
    for (const v of p.variants) {
      if ((v.sku || '').trim().toLowerCase() === want) return { product: p, variant: v };
    }
  }
  return null;
}

// ---- CRUD ----

export async function createShipment(by, body = {}) {
  const now = new Date().toISOString();
  const lines = sanitizeLines(body.lines).map((l) => {
    if (!l.variantId) {
      const hit = matchSku(l.sku);
      if (hit) {
        l.variantId = hit.variant.id;
        l.title = l.title || hit.product.title;
      }
    }
    return l;
  });
  const ship = {
    id: crypto.randomUUID(),
    status: SHIPMENT_STATUSES.includes(body.status) ? body.status : 'ordered',
    origin: s(body.origin),
    reference: s(body.reference),
    carrier: s(body.carrier, 100),
    tracking: s(body.tracking, 200),
    eta: body.eta ? s(body.eta, 10) : null,
    notes: s(body.notes, 2000),
    paymentStatus: ['unpaid', 'deposit_paid', 'paid'].includes(body.paymentStatus) ? body.paymentStatus : 'unpaid',
    paidAmount: body.paidAmount != null && body.paidAmount !== '' ? Number(body.paidAmount) : null,
    invoiceTotal: body.invoiceTotal != null && body.invoiceTotal !== '' ? Number(body.invoiceTotal) : null,
    timeline: [{ at: now, status: body.status || 'ordered', note: 'Created', by }],
    createdBy: by,
    createdAt: now,
    updatedAt: now,
    lines,
  };
  if (!pool) {
    memShipments.set(ship.id, ship);
    return ship;
  }
  await q(
    `INSERT INTO inbound_shipments (id, status, origin, reference, carrier, tracking, eta, notes, timeline, created_by, created_at, updated_at, payment_status, paid_amount, invoice_total)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11,$12,$13,$14)`,
    [ship.id, ship.status, ship.origin, ship.reference, ship.carrier, ship.tracking, ship.eta, ship.notes, JSON.stringify(ship.timeline), by, now, ship.paymentStatus, ship.paidAmount, ship.invoiceTotal]
  );
  for (const l of lines) await insertLine(ship.id, l);
  return ship;
}

async function insertLine(shipmentId, l) {
  await q(
    `INSERT INTO inbound_lines (id, shipment_id, variant_id, sku, title, expected, received, damaged, bins, shopify_synced, sync_error, received_at, received_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [l.id, shipmentId, l.variantId, l.sku, l.title, l.expected, l.received, l.damaged, JSON.stringify(l.bins), l.shopifySynced, l.syncError, l.receivedAt, l.receivedBy]
  );
}

function rowToShipment(r, lines) {
  return {
    id: r.id,
    status: r.status,
    origin: r.origin,
    reference: r.reference,
    carrier: r.carrier,
    tracking: r.tracking,
    eta: r.eta instanceof Date ? r.eta.toISOString().slice(0, 10) : r.eta,
    notes: r.notes,
    paymentStatus: r.payment_status || 'unpaid',
    paidAmount: r.paid_amount != null ? Number(r.paid_amount) : null,
    invoiceTotal: r.invoice_total != null ? Number(r.invoice_total) : null,
    timeline: r.timeline || [],
    createdBy: r.created_by,
    createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : r.created_at,
    updatedAt: r.updated_at instanceof Date ? r.updated_at.toISOString() : r.updated_at,
    lines: (lines || []).map((l) => ({
      id: l.id,
      variantId: l.variant_id,
      sku: l.sku,
      title: l.title,
      expected: l.expected,
      received: l.received,
      damaged: l.damaged,
      bins: l.bins || [],
      shopifySynced: l.shopify_synced,
      syncError: l.sync_error,
      receivedAt: l.received_at instanceof Date ? l.received_at.toISOString() : l.received_at,
      receivedBy: l.received_by,
    })),
  };
}

export async function listShipments() {
  if (!pool) {
    return [...memShipments.values()].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }
  const { rows } = await q('SELECT * FROM inbound_shipments ORDER BY created_at DESC LIMIT 300');
  const { rows: lineRows } = await q(
    'SELECT * FROM inbound_lines WHERE shipment_id = ANY($1::text[])',
    [rows.map((r) => r.id)]
  );
  const byShip = new Map();
  for (const l of lineRows) {
    if (!byShip.has(l.shipment_id)) byShip.set(l.shipment_id, []);
    byShip.get(l.shipment_id).push(l);
  }
  return rows.map((r) => rowToShipment(r, byShip.get(r.id)));
}

export async function getShipment(id) {
  if (!pool) return memShipments.get(id) || null;
  const { rows } = await q('SELECT * FROM inbound_shipments WHERE id = $1', [id]);
  if (!rows[0]) return null;
  const { rows: lines } = await q('SELECT * FROM inbound_lines WHERE shipment_id = $1', [id]);
  return rowToShipment(rows[0], lines);
}

// Update header fields / status (+timeline entry) / replace lines.
export async function updateShipment(id, by, body = {}) {
  const ship = await getShipment(id);
  if (!ship) return null;
  const now = new Date().toISOString();
  const next = { ...ship };
  for (const k of ['origin', 'reference', 'carrier', 'tracking', 'notes']) {
    if (body[k] !== undefined) next[k] = s(body[k], k === 'notes' ? 2000 : 300);
  }
  if (body.eta !== undefined) next.eta = body.eta ? s(body.eta, 10) : null;
  if (body.paymentStatus !== undefined && ['unpaid', 'deposit_paid', 'paid'].includes(body.paymentStatus)) {
    if (body.paymentStatus !== ship.paymentStatus) {
      next.timeline = [
        ...(next.timeline || ship.timeline),
        { at: now, status: ship.status, note: `Payment: ${body.paymentStatus.replace('_', ' ')}`, by },
      ];
    }
    next.paymentStatus = body.paymentStatus;
  }
  if (body.paidAmount !== undefined)
    next.paidAmount = body.paidAmount === '' || body.paidAmount == null ? null : Number(body.paidAmount);
  if (body.invoiceTotal !== undefined)
    next.invoiceTotal = body.invoiceTotal === '' || body.invoiceTotal == null ? null : Number(body.invoiceTotal);
  if (body.status && SHIPMENT_STATUSES.includes(body.status) && body.status !== ship.status) {
    next.status = body.status;
    next.timeline = [
      ...(next.timeline || ship.timeline),
      { at: now, status: body.status, note: s(body.statusNote, 500) || null, by },
    ];
  } else if (body.statusNote) {
    next.timeline = [
      ...(next.timeline || ship.timeline),
      { at: now, status: ship.status, note: s(body.statusNote, 500), by },
    ];
  }
  if (body.lines !== undefined) {
    next.lines = sanitizeLines(body.lines).map((l) => {
      if (!l.variantId) {
        const hit = matchSku(l.sku);
        if (hit) {
          l.variantId = hit.variant.id;
          l.title = l.title || hit.product.title;
        }
      }
      // keep receive state from the existing line with the same id
      const prev = ship.lines.find((x) => x.id === l.id);
      if (prev?.receivedAt) {
        l.received = prev.received;
        l.damaged = prev.damaged;
        l.bins = prev.bins;
        l.shopifySynced = prev.shopifySynced;
        l.syncError = prev.syncError;
        l.receivedAt = prev.receivedAt;
        l.receivedBy = prev.receivedBy;
      }
      return l;
    });
  }
  next.updatedAt = now;

  if (!pool) {
    memShipments.set(id, next);
    return next;
  }
  await q(
    `UPDATE inbound_shipments SET status=$2, origin=$3, reference=$4, carrier=$5, tracking=$6, eta=$7, notes=$8, timeline=$9, updated_at=$10, payment_status=$11, paid_amount=$12, invoice_total=$13 WHERE id=$1`,
    [id, next.status, next.origin, next.reference, next.carrier, next.tracking, next.eta, next.notes, JSON.stringify(next.timeline), now, next.paymentStatus || 'unpaid', next.paidAmount ?? null, next.invoiceTotal ?? null]
  );
  if (body.lines !== undefined) {
    await q('DELETE FROM inbound_lines WHERE shipment_id = $1', [id]);
    for (const l of next.lines) await insertLine(id, l);
  }
  return next;
}

// ---- QA receive: counted / damaged / binned, then push good units to Shopify ----

const VARIANT_INV_ITEM = `query($id: ID!) {
  productVariant(id: $id) { id product { id } inventoryItem { id } }
}`;

const ADJUST = `mutation($input: InventoryAdjustQuantitiesInput!) {
  inventoryAdjustQuantities(input: $input) {
    inventoryAdjustmentGroup { reason }
    userErrors { field message }
  }
}`;

const SET_BINS = `mutation($metafields: [MetafieldsSetInput!]!) {
  metafieldsSet(metafields: $metafields) {
    metafields { id }
    userErrors { field message }
  }
}`;

// Push one received line into Shopify: +accepted units at the sellable location, and merge the
// bin codes into the product's warehouse.bin_location metafield. Returns { ok, error }.
async function pushLineToShopify(line) {
  if (!line.variantId) return { ok: false, error: 'SKU not matched to a Shopify variant' };
  const accepted = Math.max(0, (line.received ?? 0) - (line.damaged ?? 0));
  try {
    const v = await shopifyGraphQL(VARIANT_INV_ITEM, { id: line.variantId });
    const invItem = v.productVariant?.inventoryItem?.id;
    const productId = v.productVariant?.product?.id;
    if (!invItem) return { ok: false, error: 'variant has no inventory item' };

    if (accepted > 0) {
      const res = await shopifyGraphQL(ADJUST, {
        input: {
          reason: 'received',
          name: 'available',
          changes: [{ inventoryItemId: invItem, locationId: cfg.sellableLocationIds[0], delta: accepted }],
        },
      });
      const errs = res.inventoryAdjustQuantities?.userErrors;
      if (errs?.length) return { ok: false, error: errs.map((e) => e.message).join('; ') };
    }

    if (productId && line.bins?.length) {
      const codes = [...new Set(line.bins.map((b) => b.bin))];
      await shopifyGraphQL(SET_BINS, {
        metafields: [
          {
            ownerId: productId,
            namespace: 'warehouse',
            key: 'bin_location',
            type: 'list.single_line_text_field',
            value: JSON.stringify(codes),
          },
        ],
      }).catch(() => {}); // bins are best-effort; stock adjustment is the critical write
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err?.message || err).slice(0, 300) };
  }
}

// Receive a set of lines: body.lines = [{ id, received, damaged, bins }]. Marks the shipment
// receiving/received and syncs each line to Shopify (or records the error for later retry).
export async function receiveShipment(id, by, body = {}) {
  const ship = await getShipment(id);
  if (!ship) return null;
  const now = new Date().toISOString();
  const updates = new Map((body.lines || []).map((l) => [l.id, l]));

  for (const line of ship.lines) {
    const u = updates.get(line.id);
    if (!u) continue;
    line.received = Math.max(0, Math.floor(Number(u.received) || 0));
    line.damaged = Math.max(0, Math.min(line.received, Math.floor(Number(u.damaged) || 0)));
    line.bins = Array.isArray(u.bins)
      ? u.bins.map((b) => ({ bin: s(b?.bin, 24), qty: Math.max(0, Math.floor(Number(b?.qty) || 0)) })).filter((b) => b.bin)
      : line.bins;
    line.receivedAt = now;
    line.receivedBy = by;
    const push = await pushLineToShopify(line);
    line.shopifySynced = push.ok;
    line.syncError = push.ok ? null : push.error;
  }

  const allReceived = ship.lines.every((l) => l.receivedAt);
  ship.status = allReceived ? 'received' : 'receiving';
  ship.timeline = [
    ...ship.timeline,
    { at: now, status: ship.status, note: `Received ${updates.size} line(s)`, by },
  ];
  ship.updatedAt = now;

  if (!pool) {
    memShipments.set(id, ship);
    return ship;
  }
  await q(`UPDATE inbound_shipments SET status=$2, timeline=$3, updated_at=$4 WHERE id=$1`, [
    id,
    ship.status,
    JSON.stringify(ship.timeline),
    now,
  ]);
  for (const l of ship.lines) {
    if (!updates.has(l.id)) continue;
    await q(
      `UPDATE inbound_lines SET received=$2, damaged=$3, bins=$4, shopify_synced=$5, sync_error=$6, received_at=$7, received_by=$8 WHERE id=$1`,
      [l.id, l.received, l.damaged, JSON.stringify(l.bins), l.shopifySynced, l.syncError, l.receivedAt, l.receivedBy]
    );
  }
  return ship;
}

// ---- Sales-floor rollup: per-variant incoming + earliest ETA from OPEN shipments ----
// The snapshot overlays this so reps see reliable BackOrder info with zero Shopify writes.

let rollupCache = { incoming: new Map(), eta: new Map(), at: 0 };

export async function refreshRollup() {
  const incoming = new Map();
  const eta = new Map();
  const ships = await listShipments().catch(() => []);
  for (const ship of ships) {
    if (!OPEN_STATUSES.includes(ship.status)) continue;
    for (const l of ship.lines) {
      if (!l.variantId || l.receivedAt) continue;
      incoming.set(l.variantId, (incoming.get(l.variantId) || 0) + l.expected);
      if (ship.eta) {
        const cur = eta.get(l.variantId);
        if (!cur || ship.eta < cur) eta.set(l.variantId, ship.eta);
      }
    }
  }
  rollupCache = { incoming, eta, at: Date.now() };
  setInboundOverlay(rollupCache); // feed the sales-floor snapshot immediately
  return rollupCache;
}

export function getRollup() {
  return rollupCache;
}
