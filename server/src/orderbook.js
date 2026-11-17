// The order book: a record of every order the app creates, and a reservation ("allocation") for
// each ordered unit saying where it comes from — Miami stock, a specific inbound shipment line,
// or nowhere yet (needs ordering).
//
// Why: the Shopify draft orders are the record for payment, but nothing tied a client's
// backorder to the shipment that fills it, so the same incoming units could be promised twice
// and a client's order could not be followed to delivery.
//
// Rules:
//  - Ready units (covered by live Miami stock at order time) are source 'stock'. Shopify holds
//    them through the draft order's reserveInventoryUntil.
//  - Backorder units reserve FREE incoming on open shipments, earliest ETA first. Free =
//    a shipment line's units minus what other orders already reserved on it.
//  - What no open shipment can cover is 'unsourced' — it needs ordering.
//  - reconcile() re-checks every reservation whenever shipments change: a cancelled shipment or
//    a short receipt releases reservations (soft before firm, newest order first), and
//    unsourced units pick up newly free incoming (firm first, oldest order first).
//
// Postgres-backed; in-memory fallback when DATABASE_URL is unset, like pending.js.
import crypto from 'node:crypto';
import { pool, q } from './db.js';
import { listShipments } from './inbound.js';

const OPEN_STATUSES = ['ordered', 'in_transit', 'arrived', 'receiving'];
const mem = { orders: new Map(), lines: new Map(), allocs: new Map() };

// All reads-then-writes of allocations run one at a time (single web process), so two orders
// placed in the same instant cannot both reserve the same units.
let chain = Promise.resolve();
function serial(fn) {
  const run = chain.then(fn, fn);
  chain = run.catch(() => {});
  return run;
}

const iso = (d) => (d instanceof Date ? d.toISOString() : d);

// ---- storage ----

async function loadAllocations() {
  if (!pool) {
    return [...mem.allocs.values()]
      .filter((a) => mem.orders.get(a.orderId)?.status === 'open')
      .map((a) => ({ ...a, orderCreatedAt: mem.orders.get(a.orderId).createdAt }));
  }
  const { rows } = await q(
    `SELECT a.*, o.created_at AS order_created_at FROM allocations a JOIN orders o ON o.id = a.order_id
     WHERE o.status = 'open'`
  );
  return rows.map((r) => ({
    id: r.id,
    orderId: r.order_id,
    orderLineId: r.order_line_id,
    variantId: r.variant_id,
    quantity: r.quantity,
    source: r.source,
    shipmentId: r.shipment_id,
    shipmentLineId: r.shipment_line_id,
    firm: r.firm,
    createdAt: iso(r.created_at),
    orderCreatedAt: iso(r.order_created_at),
  }));
}

async function insertAllocation(a) {
  if (!pool) {
    mem.allocs.set(a.id, { ...a });
    return;
  }
  await q(
    `INSERT INTO allocations (id, order_id, order_line_id, variant_id, quantity, source, shipment_id, shipment_line_id, firm)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [a.id, a.orderId, a.orderLineId, a.variantId, a.quantity, a.source, a.shipmentId || null, a.shipmentLineId || null, !!a.firm]
  );
}

async function saveAllocation(a) {
  if (!pool) {
    mem.allocs.set(a.id, { ...a });
    return;
  }
  await q(
    `UPDATE allocations SET quantity=$2, source=$3, shipment_id=$4, shipment_line_id=$5, firm=$6, updated_at=now() WHERE id=$1`,
    [a.id, a.quantity, a.source, a.shipmentId || null, a.shipmentLineId || null, !!a.firm]
  );
}

async function deleteAllocation(id) {
  if (!pool) {
    mem.allocs.delete(id);
    return;
  }
  await q('DELETE FROM allocations WHERE id=$1', [id]);
}

// ---- supply ----

// Units a shipment line can still give to orders. Before receipt that is what the supplier is
// sending; after receipt it is what actually arrived in good condition.
function lineCapacity(line) {
  if (line.receivedAt) return Math.max(0, (line.received ?? 0) - (line.damaged ?? 0));
  return line.expected || 0;
}

// Shipment lines that can be reserved against, best first: earliest ETA, then oldest shipment.
function supplyLines(shipments) {
  const out = [];
  for (const ship of shipments) {
    if (!OPEN_STATUSES.includes(ship.status)) continue;
    for (const line of ship.lines) {
      if (!line.variantId || line.receivedAt) continue;
      out.push({ ship, line });
    }
  }
  return out.sort(
    (a, b) =>
      (a.ship.eta || '9999').localeCompare(b.ship.eta || '9999') || String(a.ship.createdAt).localeCompare(String(b.ship.createdAt))
  );
}

function reservedByLine(allocs) {
  const m = new Map();
  for (const a of allocs) {
    if (a.source !== 'shipment' || !a.shipmentLineId) continue;
    m.set(a.shipmentLineId, (m.get(a.shipmentLineId) || 0) + a.quantity);
  }
  return m;
}

// Split `qty` of a variant across free incoming. Returns the pieces taken plus what is left.
function takeFromIncoming(variantId, qty, supply, reserved) {
  const pieces = [];
  let left = qty;
  for (const { ship, line } of supply) {
    if (left <= 0) break;
    if (line.variantId !== variantId) continue;
    const free = lineCapacity(line) - (reserved.get(line.id) || 0);
    if (free <= 0) continue;
    const take = Math.min(free, left);
    pieces.push({ shipmentId: ship.id, shipmentLineId: line.id, quantity: take });
    reserved.set(line.id, (reserved.get(line.id) || 0) + take);
    left -= take;
  }
  return { pieces, left };
}

// ---- recording an order ----

// entries: [{ variantId, sku, title, unitPrice, readyQty, backorderQty }]
export function recordOrder({ rep, customer, entries, result, pendingId, notes, volumeDiscountPct, subtotal }) {
  return serial(async () => {
    const order = {
      id: crypto.randomUUID(),
      status: 'open',
      customer: customer || null,
      repEmail: rep?.email || null,
      repName: rep?.name || null,
      pendingId: pendingId || null,
      notes: notes ? String(notes).slice(0, 2000) : '',
      volumeDiscountPct: Number(volumeDiscountPct) || 0,
      subtotal: subtotal ?? null,
      readyDraft: result?.ready || null,
      backorderDraft: result?.backorder || null,
      depositDraft: result?.deposit || null,
      balance: null,
      createdAt: new Date().toISOString(),
    };
    const lines = entries.map((e) => ({
      id: crypto.randomUUID(),
      orderId: order.id,
      variantId: e.variantId,
      sku: e.sku || null,
      title: e.title || null,
      quantity: (e.readyQty || 0) + (e.backorderQty || 0),
      unitPrice: e.unitPrice ?? null,
      readyQty: e.readyQty || 0,
      backorderQty: e.backorderQty || 0,
    }));

    const supply = supplyLines(await listShipments());
    const reserved = reservedByLine(await loadAllocations());
    const allocs = [];
    const mk = (line, fields) => allocs.push({ id: crypto.randomUUID(), orderId: order.id, orderLineId: line.id, variantId: line.variantId, firm: false, ...fields });
    for (const line of lines) {
      if (line.readyQty > 0) mk(line, { quantity: line.readyQty, source: 'stock' });
      if (line.backorderQty > 0) {
        const { pieces, left } = takeFromIncoming(line.variantId, line.backorderQty, supply, reserved);
        for (const p of pieces) mk(line, { ...p, source: 'shipment' });
        if (left > 0) mk(line, { quantity: left, source: 'unsourced' });
      }
    }

    if (!pool) {
      mem.orders.set(order.id, order);
      for (const l of lines) mem.lines.set(l.id, l);
    } else {
      await q(
        `INSERT INTO orders (id, status, customer, rep_email, rep_name, pending_id, notes, volume_discount_pct, subtotal, ready_draft, backorder_draft, created_at, deposit_draft)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [order.id, order.status, JSON.stringify(order.customer), order.repEmail, order.repName, order.pendingId, order.notes,
          order.volumeDiscountPct, order.subtotal, JSON.stringify(order.readyDraft), JSON.stringify(order.backorderDraft), order.createdAt, JSON.stringify(order.depositDraft)]
      );
      for (const l of lines) {
        await q(
          `INSERT INTO order_lines (id, order_id, variant_id, sku, title, quantity, unit_price, ready_qty, backorder_qty)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [l.id, l.orderId, l.variantId, l.sku, l.title, l.quantity, l.unitPrice, l.readyQty, l.backorderQty]
        );
      }
    }
    for (const a of allocs) await insertAllocation(a);
    return order.id;
  });
}

// ---- keeping reservations true as shipments change ----

// Returns a list of changes: [{ orderId, orderLineId, variantId, quantity, from, to }].
export function reconcile() {
  return serial(async () => {
    const shipments = await listShipments();
    const lineIndex = new Map(); // shipment line id -> { ship, line }
    for (const ship of shipments) for (const line of ship.lines) lineIndex.set(line.id, { ship, line });
    const allocs = await loadAllocations();
    const changes = [];
    const release = async (a, qty, why) => {
      // Move `qty` of a shipment reservation back to unsourced (splitting the row if partial).
      changes.push({ orderId: a.orderId, orderLineId: a.orderLineId, variantId: a.variantId, quantity: qty, from: a.shipmentId, to: null, why });
      if (qty >= a.quantity) {
        Object.assign(a, { source: 'unsourced', shipmentId: null, shipmentLineId: null });
        await saveAllocation(a);
      } else {
        a.quantity -= qty;
        await saveAllocation(a);
        const rest = { ...a, id: crypto.randomUUID(), quantity: qty, source: 'unsourced', shipmentId: null, shipmentLineId: null };
        allocs.push(rest);
        await insertAllocation(rest);
      }
    };

    // 1. Reservations whose shipment line is gone, cancelled, back to draft, or re-pointed.
    for (const a of allocs.filter((x) => x.source === 'shipment')) {
      const hit = lineIndex.get(a.shipmentLineId);
      const gone = !hit || hit.line.variantId !== a.variantId || ['cancelled', 'draft'].includes(hit.ship.status);
      if (gone) await release(a, a.quantity, !hit ? 'line removed' : `shipment ${hit.ship.status}`);
    }

    // 2. Lines holding more reservations than they can give (quantity cut, or short receipt).
    //    Soft reservations give way before firm ones; the newest order gives way first.
    const byLine = new Map();
    for (const a of allocs.filter((x) => x.source === 'shipment')) {
      if (!byLine.has(a.shipmentLineId)) byLine.set(a.shipmentLineId, []);
      byLine.get(a.shipmentLineId).push(a);
    }
    for (const [lineId, list] of byLine) {
      const cap = lineCapacity(lineIndex.get(lineId).line);
      let over = list.reduce((s, a) => s + a.quantity, 0) - cap;
      if (over <= 0) continue;
      const order = [...list].sort((a, b) => Number(a.firm) - Number(b.firm) || String(b.orderCreatedAt).localeCompare(String(a.orderCreatedAt)));
      for (const a of order) {
        if (over <= 0) break;
        const cut = Math.min(over, a.quantity);
        await release(a, cut, 'not enough units on the shipment');
        over -= cut;
      }
    }

    // 3. Unsourced units pick up free incoming: firm first, then the oldest order.
    const supply = supplyLines(shipments);
    const reserved = reservedByLine(allocs);
    const waiting = allocs
      .filter((x) => x.source === 'unsourced')
      .sort((a, b) => Number(b.firm) - Number(a.firm) || String(a.orderCreatedAt).localeCompare(String(b.orderCreatedAt)));
    for (const a of waiting) {
      const { pieces, left } = takeFromIncoming(a.variantId, a.quantity, supply, reserved);
      if (!pieces.length) continue;
      for (const p of pieces) {
        const row = { ...a, id: crypto.randomUUID(), ...p, source: 'shipment' };
        allocs.push(row);
        await insertAllocation(row);
        changes.push({ orderId: a.orderId, orderLineId: a.orderLineId, variantId: a.variantId, quantity: p.quantity, from: null, to: p.shipmentId });
      }
      if (left > 0) {
        a.quantity = left;
        await saveAllocation(a);
      } else {
        await deleteAllocation(a.id);
        a.quantity = 0;
      }
    }
    return changes;
  });
}

// A paid deposit makes an order's reservations firm: they are the last to give way when a
// shipment comes up short, and the first to pick up newly free incoming.
export function setOrderFirm(orderId, firm) {
  return serial(async () => {
    if (!pool) {
      for (const a of mem.allocs.values()) if (a.orderId === orderId) a.firm = !!firm;
      return;
    }
    await q('UPDATE allocations SET firm=$2, updated_at=now() WHERE order_id=$1', [orderId, !!firm]);
  });
}

// Update the draft/deposit/balance records kept on an order.
export async function updateOrder(id, fields) {
  const cols = { depositDraft: 'deposit_draft', balance: 'balance', backorderDraft: 'backorder_draft' };
  if (!pool) {
    const o = mem.orders.get(id);
    if (o) for (const k of Object.keys(cols)) if (fields[k] !== undefined) o[k] = fields[k];
    return;
  }
  for (const [k, col] of Object.entries(cols)) {
    if (fields[k] !== undefined) await q(`UPDATE orders SET ${col}=$2 WHERE id=$1`, [id, JSON.stringify(fields[k])]);
  }
}

// ---- reads ----

// Reserved units per shipment line id (for the shipments board).
export async function reservedUnitsByShipmentLine() {
  return reservedByLine(await loadAllocations());
}

// Incoming units per variant that no order has reserved yet.
export async function freeIncomingByVariant() {
  const supply = supplyLines(await listShipments());
  const reserved = reservedByLine(await loadAllocations());
  const free = new Map();
  for (const { line } of supply) {
    const f = Math.max(0, lineCapacity(line) - (reserved.get(line.id) || 0));
    free.set(line.variantId, (free.get(line.variantId) || 0) + f);
  }
  return free;
}

function shape(order, lines, allocs, shipIndex) {
  return {
    ...order,
    lines: lines.map((l) => ({
      ...l,
      allocations: allocs
        .filter((a) => a.orderLineId === l.id)
        .map((a) => {
          const ship = a.shipmentId ? shipIndex.get(a.shipmentId) : null;
          return {
            id: a.id,
            quantity: a.quantity,
            source: a.source,
            firm: a.firm,
            shipment: ship ? { id: ship.id, reference: ship.reference, origin: ship.origin, status: ship.status, eta: ship.eta } : null,
          };
        }),
    })),
  };
}

export async function listOrders({ limit = 100 } = {}) {
  const shipIndex = new Map((await listShipments()).map((s) => [s.id, s]));
  if (!pool) {
    const allocs = [...mem.allocs.values()];
    return [...mem.orders.values()]
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
      .slice(0, limit)
      .map((o) => shape(o, [...mem.lines.values()].filter((l) => l.orderId === o.id), allocs, shipIndex));
  }
  const { rows } = await q('SELECT * FROM orders ORDER BY created_at DESC LIMIT $1', [limit]);
  const ids = rows.map((r) => r.id);
  const { rows: lr } = await q('SELECT * FROM order_lines WHERE order_id = ANY($1::text[])', [ids]);
  const { rows: ar } = await q('SELECT * FROM allocations WHERE order_id = ANY($1::text[])', [ids]);
  const allocs = ar.map((r) => ({
    id: r.id, orderId: r.order_id, orderLineId: r.order_line_id, quantity: r.quantity, source: r.source,
    shipmentId: r.shipment_id, shipmentLineId: r.shipment_line_id, firm: r.firm,
  }));
  return rows.map((r) =>
    shape(
      {
        id: r.id, status: r.status, customer: r.customer, repEmail: r.rep_email, repName: r.rep_name, pendingId: r.pending_id,
        notes: r.notes, volumeDiscountPct: Number(r.volume_discount_pct), subtotal: r.subtotal != null ? Number(r.subtotal) : null,
        readyDraft: r.ready_draft, backorderDraft: r.backorder_draft, depositDraft: r.deposit_draft, balance: r.balance,
        createdAt: iso(r.created_at),
      },
      lr.filter((l) => l.order_id === r.id).map((l) => ({
        id: l.id, variantId: l.variant_id, sku: l.sku, title: l.title, quantity: l.quantity,
        unitPrice: l.unit_price != null ? Number(l.unit_price) : null, readyQty: l.ready_qty, backorderQty: l.backorder_qty,
      })),
      allocs,
      shipIndex
    )
  );
}

export async function getOrder(id) {
  return (await listOrders({ limit: 1000 })).find((o) => o.id === id) || null;
}
