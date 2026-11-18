// Document intake: the app's record of every supplier / freight / customs document, and the
// index of reference numbers that ties them to a shipment.
//
// The problem this solves: one shipment is known by a different number to every party. Italy's
// order is 111/2026, the packing list for it is 640/2026, the supplier invoice is 667/2026, the
// forwarder quotes its own file number, customs issues an entry number, and the freight and
// broker invoices carry theirs. Until now the only thing joining them was "the files sit in the
// same Drive folder". Here every shipment holds ALL its numbers, each labelled by kind, and any
// one of them finds the shipment.
//
//  - shipment_refs     the reference index. A shipment has many refs; the same Italy order can
//                      sit on several shipments (an order split across shipments) and a
//                      shipment can carry several orders.
//  - intake_documents  every document that came in, what was read from it, and the shipment it
//                      matched. A clear match files itself; an unclear one waits for a person.
//
// Nothing here writes money or stock: a document's figures are kept with it (`extracted`) for a
// person to review. Postgres-backed with the in-memory fallback used elsewhere.
import crypto from 'node:crypto';
import { pool, q } from './db.js';
import { parseIntakeFile } from './intake.js';
import { createShipment, getShipment, listShipments } from './inbound.js';
import { createDocument, normalizeDocType } from './documents.js';

// kind -> [label, weight]. Weight = how specifically that kind of number names ONE shipment.
// A packing-list or invoice number names one; an Italy order number may span several.
export const REF_KINDS = {
  packing_list: ['Packing list', 5],
  supplier_invoice: ['Supplier invoice', 5],
  bill_of_lading: ['Bill of lading', 5],
  customs_entry: ['Customs entry', 5],
  freight_invoice: ['Freight invoice', 5],
  broker_invoice: ['Broker invoice', 5],
  forwarder_file: ['Forwarder file', 4],
  booking: ['Booking', 4],
  container: ['Container', 3],
  internal: ['Internal', 3],
  italy_order: ['Italy order', 2],
  customer_po: ['Customer PO', 2],
  other: ['Other', 1],
};
const kindOf = (k) => (REF_KINDS[k] ? k : 'other');

// One spelling per number, so "111/2026", "111-2026", "ORD_111_2026" and "Order 111 / 2026" are
// the same reference. Number/year pairs become "N/YYYY"; anything else is letters and digits.
export function refKey(value) {
  const up = String(value || '').toUpperCase();
  const ny = up.match(/(?:^|[^0-9])(\d{1,5})\s*[/\-_. ]\s*(20\d{2})(?:[^0-9]|$)/);
  if (ny) return `${Number(ny[1])}/${ny[2]}`;
  const yn = up.match(/(?:^|[^0-9])(20\d{2})\s*[/\-_.]\s*(\d{1,5})(?:[^0-9]|$)/);
  if (yn) return `${Number(yn[2])}/${yn[1]}`;
  return up.replace(/[^A-Z0-9]/g, '');
}

const mem = { refs: new Map(), docs: new Map() };
const iso = (d) => (d instanceof Date ? d.toISOString() : d);
const str = (v, n = 300) => (v == null || v === '' ? null : String(v).slice(0, n));

// ---- reference index ----

const refRow = (r) => ({
  id: r.id, shipmentId: r.shipment_id, kind: r.kind, label: REF_KINDS[r.kind]?.[0] || 'Other', value: r.value, key: r.key,
  docId: r.doc_id, createdBy: r.created_by, createdAt: iso(r.created_at),
});

export async function listRefs(shipmentIds) {
  if (!pool) {
    return [...mem.refs.values()].filter((r) => !shipmentIds || shipmentIds.includes(r.shipmentId));
  }
  const { rows } = shipmentIds
    ? await q('SELECT * FROM shipment_refs WHERE shipment_id = ANY($1::text[]) ORDER BY created_at', [shipmentIds])
    : await q('SELECT * FROM shipment_refs ORDER BY created_at');
  return rows.map(refRow);
}

// Add a reference to a shipment. Adding the same kind+number twice is a no-op.
export async function addRef(shipmentId, { kind, value, docId = null }, by) {
  const key = refKey(value);
  if (!key) throw new Error('reference value required');
  const k = kindOf(kind);
  const existing = (await listRefs([shipmentId])).find((r) => r.kind === k && r.key === key);
  if (existing) return existing;
  const ref = {
    id: crypto.randomUUID(), shipmentId, kind: k, label: REF_KINDS[k][0], value: String(value).trim().slice(0, 120), key,
    docId, createdBy: by || null, createdAt: new Date().toISOString(),
  };
  if (!pool) mem.refs.set(ref.id, ref);
  else {
    await q('INSERT INTO shipment_refs (id, shipment_id, kind, value, key, doc_id, created_by, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', [
      ref.id, shipmentId, ref.kind, ref.value, ref.key, docId, ref.createdBy, ref.createdAt,
    ]);
  }
  return ref;
}

export async function removeRef(refId) {
  if (!pool) return mem.refs.delete(refId);
  const { rowCount } = await q('DELETE FROM shipment_refs WHERE id=$1', [refId]);
  return rowCount > 0;
}

// Which shipments do these references point at? Each live shipment is scored by its most
// specific matching reference (see REF_KINDS). A shipment's own `reference` field counts as an
// unlabelled number, so shipments created before the index existed are still found.
// Returns candidates best first: [{ shipment, score, matchedOn: [{ kind, value }] }].
export async function matchRefs(refs) {
  const wanted = (refs || []).map((r) => ({ kind: kindOf(r.kind), value: r.value, key: refKey(r.value) })).filter((r) => r.key);
  if (!wanted.length) return [];
  const shipments = (await listShipments()).filter((s) => s.status !== 'cancelled');
  const index = await listRefs(shipments.map((s) => s.id));
  const out = [];
  for (const ship of shipments) {
    const own = index.filter((r) => r.shipmentId === ship.id);
    const headerKey = ship.reference ? refKey(ship.reference) : null;
    const matchedOn = [];
    let score = 0;
    for (const w of wanted) {
      const hit = own.find((r) => r.key === w.key && (r.kind === w.kind || r.kind === 'other' || w.kind === 'other'));
      if (hit) {
        matchedOn.push({ kind: hit.kind, value: hit.value });
        score = Math.max(score, REF_KINDS[hit.kind][1]);
      } else if (headerKey && headerKey === w.key) {
        matchedOn.push({ kind: w.kind, value: ship.reference });
        score = Math.max(score, REF_KINDS[w.kind][1]);
      }
    }
    if (matchedOn.length) out.push({ shipment: ship, score, matchedOn });
  }
  return out.sort((a, b) => b.score - a.score || b.matchedOn.length - a.matchedOn.length);
}

// A match is clear when exactly one shipment has the top score.
function decide(candidates) {
  if (!candidates.length) return { status: 'unmatched', shipmentId: null };
  const best = candidates.filter((c) => c.score === candidates[0].score);
  return best.length === 1 ? { status: 'matched', shipmentId: best[0].shipment.id } : { status: 'needs_review', shipmentId: null };
}

// ---- documents ----

const docRow = (r) => ({
  id: r.id, hash: r.hash, filename: r.filename, source: r.source, docType: r.doc_type, status: r.status, shipmentId: r.shipment_id,
  refs: r.refs || [], extracted: r.extracted || null, driveUrl: r.drive_url, sender: r.sender, subject: r.subject,
  receivedAt: iso(r.received_at), createdBy: r.created_by, createdAt: iso(r.created_at), reviewedBy: r.reviewed_by, reviewedAt: iso(r.reviewed_at),
});

async function saveDoc(d, isNew) {
  if (!pool) {
    mem.docs.set(d.id, d);
    return;
  }
  if (isNew) {
    await q(
      `INSERT INTO intake_documents (id, hash, filename, source, doc_type, status, shipment_id, refs, extracted, drive_url, sender, subject, received_at, created_by, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [d.id, d.hash, d.filename, d.source, d.docType, d.status, d.shipmentId, JSON.stringify(d.refs), JSON.stringify(d.extracted), d.driveUrl, d.sender, d.subject, d.receivedAt, d.createdBy, d.createdAt]
    );
  } else {
    await q('UPDATE intake_documents SET status=$2, shipment_id=$3, refs=$4, doc_type=$5, reviewed_by=$6, reviewed_at=$7, drive_url=$8 WHERE id=$1', [
      d.id, d.status, d.shipmentId, JSON.stringify(d.refs), d.docType, d.reviewedBy, d.reviewedAt, d.driveUrl,
    ]);
  }
}

export async function getIntakeDoc(id) {
  if (!pool) return mem.docs.get(id) || null;
  const { rows } = await q('SELECT * FROM intake_documents WHERE id=$1', [id]);
  return rows[0] ? docRow(rows[0]) : null;
}

async function findByHash(hash) {
  if (!hash) return null;
  if (!pool) return [...mem.docs.values()].find((d) => d.hash === hash) || null;
  const { rows } = await q('SELECT * FROM intake_documents WHERE hash=$1 LIMIT 1', [hash]);
  return rows[0] ? docRow(rows[0]) : null;
}

// Newest first, each with the shipments its references point at (for the review picker).
export async function listIntake({ limit = 200 } = {}) {
  let docs;
  if (!pool) docs = [...mem.docs.values()].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)).slice(0, limit);
  else docs = (await q('SELECT * FROM intake_documents ORDER BY created_at DESC LIMIT $1', [limit])).rows.map(docRow);
  const ships = new Map((await listShipments()).map((s) => [s.id, s]));
  const brief = (s) => s && { id: s.id, reference: s.reference, origin: s.origin, status: s.status, eta: s.eta };
  const out = [];
  for (const d of docs) {
    const candidates = d.status === 'needs_review' || d.status === 'unmatched' ? (await matchRefs(d.refs)).slice(0, 6).map((c) => ({ ...brief(c.shipment), matchedOn: c.matchedOn })) : [];
    out.push({ ...d, shipment: brief(ships.get(d.shipmentId)) || null, candidates });
  }
  return out;
}

// Tie a document to its shipment: its numbers join the shipment's index, and (when the file is
// in Drive) it is registered on the shipment's customs-document checklist.
async function attach(doc, shipmentId, by) {
  for (const r of doc.refs) await addRef(shipmentId, { ...r, docId: doc.id }, by);
  const checklistType = { invoice: 'commercial_invoice', packing_list: 'packing_list' }[doc.docType] || (normalizeDocType(doc.docType) !== 'order' ? normalizeDocType(doc.docType) : null);
  if (doc.driveUrl && checklistType && checklistType !== 'unknown') {
    await createDocument(by, { shipmentId, docType: checklistType, status: 'received', driveUrl: doc.driveUrl, filename: doc.filename }).catch(() => {});
  }
}

// Take in one document. Give EITHER the file (`buffer`: a Baci order / invoice / packing list is
// read here) OR what a reader already extracted (`refs`, `docType`, `extracted`), for document
// types this app does not parse itself. The same file twice returns the first record.
export async function ingestDocument({ filename, buffer, hash, refs, docType, extracted, source, driveUrl, sender, subject, receivedAt }, by) {
  const h = hash || (buffer ? crypto.createHash('sha256').update(buffer).digest('hex') : null);
  const dupe = await findByHash(h);
  if (dupe) return { document: dupe, duplicate: true };

  let parsed = null;
  if (buffer && /\.(pdf|xlsx|xls)$/i.test(filename || '')) {
    parsed = await parseIntakeFile(filename, buffer).catch(() => null);
  }
  const allRefs = [];
  const push = (r) => {
    const key = refKey(r?.value);
    if (key && !allRefs.some((x) => x.kind === kindOf(r.kind) && refKey(x.value) === key)) allRefs.push({ kind: kindOf(r.kind), value: String(r.value).trim().slice(0, 120) });
  };
  for (const r of parsed?.refs || []) push(r);
  for (const r of refs || []) push(typeof r === 'string' ? { kind: 'other', value: r } : r);

  const candidates = await matchRefs(allRefs);
  const verdict = decide(candidates);
  const doc = {
    id: crypto.randomUUID(),
    hash: h,
    filename: str(filename) || 'document',
    source: ['email', 'whatsapp', 'upload', 'drive'].includes(source) ? source : 'upload',
    docType: (parsed?.docType && parsed.docType !== 'unknown' ? parsed.docType : normalizeDocType(docType)) || 'unknown',
    status: verdict.status,
    shipmentId: verdict.shipmentId,
    refs: allRefs,
    extracted: parsed || extracted || null,
    driveUrl: str(driveUrl, 1000),
    sender: str(sender),
    subject: str(subject, 500),
    receivedAt: receivedAt || null,
    createdBy: by || null,
    createdAt: new Date().toISOString(),
    reviewedBy: null,
    reviewedAt: null,
  };
  await saveDoc(doc, true);
  if (doc.shipmentId) await attach(doc, doc.shipmentId, by);
  return { document: doc, duplicate: false, candidates };
}

// A person settles an unclear document: onto an existing shipment, or a new one made from it.
export async function assignDocument(id, { shipmentId, create }, by) {
  const doc = await getIntakeDoc(id);
  if (!doc) return null;
  let target = shipmentId ? await getShipment(shipmentId) : null;
  if (!target && create) {
    const x = doc.extracted || {};
    target = await createShipment(by, {
      reference: x.reference || doc.refs[0]?.value || doc.filename,
      origin: x.origin || null,
      // Same convention as the import button: a packing list means the goods have shipped.
      status: doc.docType === 'packing_list' ? 'in_transit' : 'ordered',
      invoiceTotal: x.invoiceTotal ?? null,
      lines: (x.lines || []).map((l) => ({ sku: l.sku, title: l.title, expected: l.expected, variantId: l.variantId })),
      notes: `Created from ${doc.filename}`,
    });
  }
  if (!target) throw new Error('Pick a shipment, or choose to create one');
  Object.assign(doc, { status: 'matched', shipmentId: target.id, reviewedBy: by, reviewedAt: new Date().toISOString() });
  await saveDoc(doc, false);
  await attach(doc, target.id, by);
  return { document: doc, shipment: target, created: !shipmentId };
}

export async function ignoreDocument(id, by) {
  const doc = await getIntakeDoc(id);
  if (!doc) return null;
  Object.assign(doc, { status: 'ignored', reviewedBy: by, reviewedAt: new Date().toISOString() });
  await saveDoc(doc, false);
  return doc;
}
