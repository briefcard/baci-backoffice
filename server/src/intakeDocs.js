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
import { readDocument } from './reader.js';
import { createShipment, getShipment, listShipments, updateShipment } from './inbound.js';
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
  applied: r.applied || null,
  sourceId: r.source_id || null, historical: r.historical === true,
  docDate: r.doc_date instanceof Date ? r.doc_date.toISOString().slice(0, 10) : r.doc_date || null,
});

async function saveDoc(d, isNew) {
  if (!pool) {
    mem.docs.set(d.id, d);
    return;
  }
  if (isNew) {
    await q(
      `INSERT INTO intake_documents (id, hash, filename, source, doc_type, status, shipment_id, refs, extracted, drive_url, sender, subject, received_at, created_by, created_at, source_id, historical, doc_date)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
      [d.id, d.hash, d.filename, d.source, d.docType, d.status, d.shipmentId, JSON.stringify(d.refs), JSON.stringify(d.extracted), d.driveUrl, d.sender, d.subject, d.receivedAt, d.createdBy, d.createdAt, d.sourceId || null, d.historical === true, d.docDate || null]
    );
  } else {
    await q('UPDATE intake_documents SET status=$2, shipment_id=$3, refs=$4, doc_type=$5, reviewed_by=$6, reviewed_at=$7, drive_url=$8, applied=$9 WHERE id=$1', [
      d.id, d.status, d.shipmentId, JSON.stringify(d.refs), d.docType, d.reviewedBy, d.reviewedAt, d.driveUrl, d.applied ? JSON.stringify(d.applied) : null,
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
const HIDDEN = ['skipped', 'duplicate'];
export async function listIntake({ limit = 600 } = {}) {
  let docs;
  // 'skipped' (not import paperwork) and 'duplicate' rows exist only so the history import
  // does not fetch the same file twice; they are not shown.
  if (!pool) docs = [...mem.docs.values()].filter((d) => !HIDDEN.includes(d.status)).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)).slice(0, limit);
  else docs = (await q("SELECT * FROM intake_documents WHERE status NOT IN ('skipped','duplicate') ORDER BY created_at DESC LIMIT $1", [limit])).rows.map(docRow);
  const ships = new Map((await listShipments()).map((s) => [s.id, s]));
  const brief = (s) => s && { id: s.id, reference: s.reference, origin: s.origin, status: s.status, eta: s.eta, historical: s.historical === true };
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

// Take in one document. Give EITHER the file (`buffer`: read here, by the app's own parser for
// a Baci order / invoice / packing list and by Claude for anything else) OR what a reader
// already extracted (`refs`, `docType`, `extracted`). The same file twice returns the first
// record.
//
// History import options (`opts`):
//   historical  the document is from the past: it may be filed on, or create, a past shipment
//   sourceId    where it was fetched from, so the import never fetches it twice
//   hold        store it unfiled; fileHistorical() files the whole batch in a sensible order
//   read        a reading already made by readDocument(), to avoid reading twice
//   status      'skipped' | 'duplicate': a marker row only (see listIntake)
export async function ingestDocument({ filename, buffer, hash, refs, docType, extracted, source, driveUrl, sender, subject, receivedAt }, by, opts = {}) {
  const h = hash || (buffer ? crypto.createHash('sha256').update(buffer).digest('hex') : null);
  // Two copies of one file arriving at the same moment (the email and the Drive copy) must not
  // both be taken in as new: the second waits for the first.
  while (h && inFlight.has(h)) await inFlight.get(h);
  let release;
  if (h) inFlight.set(h, new Promise((r) => (release = r)));
  try {
    return await ingestOne({ filename, buffer, h, refs, docType, extracted, source, driveUrl, sender, subject, receivedAt }, by, opts);
  } finally {
    if (h) {
      inFlight.delete(h);
      release();
    }
  }
}
const inFlight = new Map();

async function ingestOne({ filename, buffer, h, refs, docType, extracted, source, driveUrl, sender, subject, receivedAt }, by, opts) {
  const dupe = await findByHash(h);
  if (dupe && !opts.sourceId) return { document: dupe, duplicate: true };
  // A second copy can still add something: the Drive folder it sits in names its shipment, and
  // a Drive link is a better place to open it from than none.
  if (dupe && (refs?.length || (driveUrl && !dupe.driveUrl))) {
    for (const r of refs || []) {
      const key = refKey(r?.value);
      if (!key || dupe.refs.some((x) => refKey(x.value) === key)) continue;
      dupe.refs.push({ kind: kindOf(r.kind), value: String(r.value).trim().slice(0, 120) });
      if (dupe.shipmentId) await addRef(dupe.shipmentId, { ...r, docId: dupe.id }, by);
    }
    if (driveUrl && !dupe.driveUrl) dupe.driveUrl = str(driveUrl, 1000);
    await saveDoc(dupe, false);
  }

  let read = typeof opts.read === 'function' ? (dupe ? null : await opts.read()) : opts.read || null;
  if (read?.how === 'skipped' && opts.historical && !opts.status) opts = { ...opts, status: 'skipped' };
  if (read?.defer) return { deferred: true };
  if (!dupe && !read && !opts.status && buffer) {
    read = await readDocument(filename, buffer, { sender, subject }).catch((err) => ({ how: 'skipped', reason: String(err?.message || err) }));
  }
  const parsed = read?.extracted || read?.parsed || null;
  const allRefs = [];
  const push = (r) => {
    const key = refKey(r?.value);
    if (key && !allRefs.some((x) => x.kind === kindOf(r.kind) && refKey(x.value) === key)) allRefs.push({ kind: kindOf(r.kind), value: String(r.value).trim().slice(0, 120) });
  };
  for (const r of parsed?.refs || []) push(r);
  for (const r of refs || []) push(typeof r === 'string' ? { kind: 'other', value: r } : r);

  // Claude judged it not to be import paperwork: keep the record, out of the way.
  const irrelevant = parsed?.readBy === 'ai' && parsed.relevant === false;
  const marker = dupe ? 'duplicate' : opts.status || (irrelevant ? (opts.historical ? 'skipped' : 'ignored') : null);
  const candidates = marker || opts.hold ? [] : await matchRefs(allRefs);
  const verdict = marker ? { status: marker, shipmentId: null } : opts.hold ? { status: 'unmatched', shipmentId: null } : decide(candidates);
  const doc = {
    id: crypto.randomUUID(),
    hash: h,
    filename: str(filename) || 'document',
    source: ['email', 'whatsapp', 'upload', 'drive'].includes(source) ? source : 'upload',
    docType: (parsed?.docType && parsed.docType !== 'unknown' ? parsed.docType : normalizeDocType(docType)) || 'unknown',
    status: verdict.status,
    shipmentId: verdict.shipmentId,
    refs: marker ? [] : allRefs,
    extracted: dupe ? { duplicateOf: dupe.id } : parsed || extracted || (read?.reason ? { notRead: read.reason } : null),
    driveUrl: str(driveUrl, 1000),
    sender: str(sender),
    subject: str(subject, 500),
    receivedAt: receivedAt || null,
    createdBy: by || null,
    createdAt: new Date().toISOString(),
    reviewedBy: null,
    reviewedAt: null,
    applied: null,
    sourceId: str(opts.sourceId, 400),
    historical: opts.historical === true,
    docDate: parsed?.docDate || extracted?.docDate || null,
  };
  await saveDoc(doc, true);
  if (doc.shipmentId) await attach(doc, doc.shipmentId, by);
  return { document: doc, duplicate: !!dupe, candidates, usage: read?.usage || null, how: read?.how || null };
}

// Which of these source ids have already been taken in?
export async function knownSourceIds(ids) {
  if (!ids.length) return new Set();
  if (!pool) return new Set([...mem.docs.values()].map((d) => d.sourceId).filter((x) => ids.includes(x)));
  const { rows } = await q('SELECT source_id FROM intake_documents WHERE source_id = ANY($1::text[])', [ids]);
  return new Set(rows.map((r) => r.source_id));
}

// What a document says a NEW shipment should hold.
function shipmentFromDoc(doc) {
  const x = doc.extracted || {};
  return {
    reference: x.reference || doc.refs[0]?.value || doc.filename,
    origin: x.origin || null,
    invoiceTotal: doc.docType === 'packing_list' ? null : x.invoiceTotal ?? null,
    incoterm: x.incoterm || null,
    paymentTerms: x.paymentTerms || null,
    eta: x.eta || null,
    carrier: x.carrier || null,
    tracking: x.tracking || x.container || null,
    lines: (x.lines || []).map((l) => ({
      sku: l.sku, title: l.title, expected: l.expected, variantId: l.variantId,
      unitCost: l.unitPrice, currency: l.currency, madeIn: l.madeIn, hsCode: l.hsCode,
      cartons: l.cartons, netKg: l.netKg, grossKg: l.grossKg, cbm: l.cbm,
    })),
    notes: `Created from ${doc.filename}`,
  };
}

// ---- filing a history import ----
//
// Held documents are filed in the order the paperwork was issued (orders, then invoices and
// packing lists, then freight and customs papers), so each later document finds the shipment
// its earlier ones created. A document that matches a shipment joins it. A supplier document
// that matches nothing and is dated before `pastBefore` becomes a PAST shipment; a newer one
// is left in the inbox, because it may be a shipment still on its way and only a person can
// say. Figures are applied automatically to past shipments only: they hold no stock and no
// promises, so nothing can be disturbed.
const FILE_ORDER = ['order', 'invoice', 'commercial_invoice', 'packing_list'];
const CREATES = new Set(FILE_ORDER);

export async function fileHistorical({ pastBefore }, by, onProgress = () => {}) {
  const pending = async () => {
    const all = !pool
      ? [...mem.docs.values()]
      : (await q("SELECT * FROM intake_documents WHERE historical = true AND status IN ('unmatched','needs_review')")).rows.map(docRow);
    const rank = (d) => (FILE_ORDER.indexOf(d.docType) + 1 || FILE_ORDER.length + 1);
    return all
      .filter((d) => d.historical && ['unmatched', 'needs_review'].includes(d.status))
      .sort((a, b) => rank(a) - rank(b) || String(a.docDate || a.receivedAt || '').localeCompare(String(b.docDate || b.receivedAt || '')));
  };
  const out = { filed: 0, created: 0, applied: 0, left: 0 };
  // Two passes: a freight invoice can only find its shipment after the bill of lading that
  // carries the same container number has been filed.
  for (let pass = 0; pass < 2; pass++) {
    const docs = await pending();
    let moved = 0;
    for (const doc of docs) {
      const verdict = decide(await matchRefs(doc.refs));
      let target = verdict.shipmentId ? await getShipment(verdict.shipmentId) : null;
      let created = false;
      const date = doc.docDate || (doc.receivedAt ? String(doc.receivedAt).slice(0, 10) : null);
      if (!target && verdict.status === 'unmatched' && pass === 0 && CREATES.has(doc.docType) && doc.refs.length && date && date < pastBefore) {
        target = await createShipment(by, { ...shipmentFromDoc(doc), historical: true });
        created = true;
        out.created++;
      }
      if (!target) {
        if (verdict.status !== doc.status) {
          doc.status = verdict.status;
          await saveDoc(doc, false);
        }
        continue;
      }
      Object.assign(doc, { status: 'matched', shipmentId: target.id });
      if (created) doc.applied = { at: new Date().toISOString(), by, summary: { created: true } };
      await saveDoc(doc, false);
      await attach(doc, target.id, by);
      out.filed++;
      moved++;
      if (target.historical && !created) {
        const res = await applyDocument(doc.id, { addMissing: true }, by).catch(() => null);
        if (res && (res.summary.lineUpdates || res.summary.added || res.summary.header.length)) out.applied++;
      }
      onProgress(out);
    }
    if (!moved) break;
  }
  out.left = (await pending()).length;
  return out;
}

// A person settles an unclear document: onto an existing shipment, or a new one made from it.
export async function assignDocument(id, { shipmentId, create, historical }, by) {
  const doc = await getIntakeDoc(id);
  if (!doc) return null;
  let target = shipmentId ? await getShipment(shipmentId) : null;
  if (!target && create) {
    target = await createShipment(by, {
      ...shipmentFromDoc(doc),
      // Same convention as the import button: a packing list means the goods have shipped.
      status: doc.docType === 'packing_list' ? 'in_transit' : 'ordered',
      historical: historical === true,
    });
    doc.applied = { at: new Date().toISOString(), by, summary: { created: true } };
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

// ---- applying a filed document to its shipment ----
//
// A filed document's figures do nothing until a person applies them. applyPreview says exactly
// what would change; applyDocument makes those changes and nothing else.
//   - line details by SKU: unit price, currency, made-in, tariff code (orders and invoices);
//     cartons, weights, volume (packing lists)
//   - header: invoice total, incoterm, payment terms; arrival date, carrier and tracking when a
//     reader supplied them (forwarder notices)
//   - optional: add lines the shipment does not have yet; set quantities to the document's
// Received lines keep their quantities. Quantities and added lines are opt-in because they move
// what is promised to client orders.

const LINE_FIELDS = [['unitCost', 'unitPrice', 'unit price'], ['currency', 'currency', null], ['madeIn', 'madeIn', 'made-in'], ['hsCode', 'hsCode', 'tariff code'], ['cartons', 'cartons', 'cartons'], ['netKg', 'netKg', null], ['grossKg', 'grossKg', 'weight'], ['cbm', 'cbm', 'volume']];
const isDate = (v) => typeof v === 'string' && /^20\d{2}-\d{2}-\d{2}$/.test(v);

function planApply(doc, ship) {
  const x = doc.extracted || {};
  const docLines = Array.isArray(x.lines) ? x.lines : [];
  const bySku = new Map(ship.lines.map((l) => [String(l.sku).toUpperCase(), l]));
  const lineChanges = []; // { line, set: {field: value} }
  const fields = new Set();
  const missing = [];
  const qtyDiffs = [];
  for (const d of docLines) {
    const line = bySku.get(String(d.sku).toUpperCase());
    if (!line) {
      missing.push(d);
      continue;
    }
    const set = {};
    for (const [field, from, label] of LINE_FIELDS) {
      if (d[from] != null && d[from] !== line[field]) {
        set[field] = d[from];
        if (label) fields.add(label);
      }
    }
    if (Object.keys(set).length) lineChanges.push({ line, set });
    if (!line.receivedAt && d.expected != null && d.expected !== line.expected) qtyDiffs.push({ sku: line.sku, shipment: line.expected, document: d.expected });
  }
  const docSkus = new Set(docLines.map((d) => String(d.sku).toUpperCase()));
  const notOnDocument = docLines.length ? ship.lines.filter((l) => !docSkus.has(String(l.sku).toUpperCase())).map((l) => l.sku) : [];

  const header = [];
  const head = (field, label, to) => {
    if (to != null && to !== '' && to !== ship[field]) header.push({ field, label, from: ship[field] ?? null, to });
  };
  // Money and terms come from the supplier's own invoice or order, not from a packing list.
  if (['invoice', 'commercial_invoice', 'order'].includes(doc.docType)) {
    head('invoiceTotal', 'Invoice total', x.invoiceTotal);
    head('incoterm', 'Delivery terms', x.incoterm);
    head('paymentTerms', 'Payment terms', x.paymentTerms);
  }
  if (isDate(x.eta)) head('eta', 'Arrival date', x.eta);
  head('carrier', 'Carrier', x.carrier);
  head('tracking', 'Tracking / container', x.tracking || x.container);
  return { lineChanges, fields: [...fields], missing, qtyDiffs, notOnDocument, header };
}

// What applying this document would change on its shipment.
export async function applyPreview(id) {
  const doc = await getIntakeDoc(id);
  if (!doc) return null;
  if (doc.status !== 'matched' || !doc.shipmentId) throw new Error('File the document on a shipment first');
  const ship = await getShipment(doc.shipmentId);
  if (!ship) throw new Error('The shipment no longer exists');
  const plan = planApply(doc, ship);
  return {
    documentId: doc.id,
    shipment: { id: ship.id, reference: ship.reference, origin: ship.origin },
    lineUpdates: plan.lineChanges.length,
    fields: plan.fields,
    missing: plan.missing.map((d) => ({ sku: d.sku, expected: d.expected })),
    qtyDiffs: plan.qtyDiffs,
    notOnDocument: plan.notOnDocument,
    header: plan.header,
    nothing: !plan.lineChanges.length && !plan.missing.length && !plan.qtyDiffs.length && !plan.header.length,
    applied: doc.applied,
  };
}

// Apply it. Returns { document, before, shipment } so the caller can re-check reservations and
// note an arrival-date change on the orders that depend on this shipment.
export async function applyDocument(id, { addMissing = false, setQuantities = false } = {}, by) {
  const doc = await getIntakeDoc(id);
  if (!doc) return null;
  if (doc.status !== 'matched' || !doc.shipmentId) throw new Error('File the document on a shipment first');
  const before = await getShipment(doc.shipmentId);
  if (!before) throw new Error('The shipment no longer exists');
  const plan = planApply(doc, before);

  const lines = before.lines.map((l) => ({ ...l }));
  for (const { line, set } of plan.lineChanges) Object.assign(lines.find((l) => l.id === line.id), set);
  if (setQuantities) for (const dq of plan.qtyDiffs) lines.find((l) => l.sku === dq.sku).expected = dq.document;
  if (addMissing) {
    for (const d of plan.missing) {
      const add = { sku: d.sku, title: d.title, expected: d.expected, variantId: d.variantId || null };
      for (const [field, from] of LINE_FIELDS) if (d[from] != null) add[field] = d[from];
      lines.push(add);
    }
  }
  const body = { lines, statusNote: `Applied ${doc.filename}` };
  for (const h of plan.header) body[h.field] = h.to;
  const shipment = await updateShipment(before.id, by, body);

  const summary = {
    lineUpdates: plan.lineChanges.length,
    fields: plan.fields,
    added: addMissing ? plan.missing.length : 0,
    quantitiesSet: setQuantities ? plan.qtyDiffs.length : 0,
    header: plan.header.map((h) => h.label),
  };
  doc.applied = { at: new Date().toISOString(), by, summary };
  await saveDoc(doc, false);
  return { document: doc, before, shipment, summary };
}
