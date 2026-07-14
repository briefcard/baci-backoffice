// Customs/freight document registry for inbound logistics — the WhatsApp agent's context store.
// Files themselves live in GOOGLE DRIVE (the agent owns Drive I/O: it receives PDFs over
// WhatsApp, uploads them under `Baci Inbound/<year>/<ref>/<doctype>_<filename>`); this system
// stores ONLY metadata + links (drive_file_id, drive_url).
//
// Status ladder: required → received → approved → filed. "required" rows are VIRTUAL — the
// per-shipment checklist merges cfg.requiredDocs with the registered rows, so nothing has to be
// seeded when a shipment is created. Company-scoped docs (scope='company', e.g. the customs
// broker Power of Attorney) have no shipment and may carry an expiry date.
//
// Postgres-backed with the same in-memory dev fallback pattern as inbound.js / pending.js.
import crypto from 'node:crypto';
import { pool, q } from './db.js';
import { cfg } from './config.js';

export const DOC_STATUSES = ['required', 'received', 'approved', 'filed'];
export const DOC_SCOPES = ['shipment', 'company'];

// Canonical slugs for the common customs/freight documents. Anything unrecognized is kept as a
// slugified free-form type so new document kinds never bounce.
const DOC_TYPE_ALIASES = {
  commercial_invoice: 'commercial_invoice',
  'commercial invoice': 'commercial_invoice',
  ci: 'commercial_invoice',
  invoice: 'commercial_invoice',
  'pro forma': 'commercial_invoice',
  packing_list: 'packing_list',
  'packing list': 'packing_list',
  pl: 'packing_list',
  pklist: 'packing_list',
  bill_of_lading: 'bill_of_lading',
  'bill of lading': 'bill_of_lading',
  bl: 'bill_of_lading',
  bol: 'bill_of_lading',
  'b/l': 'bill_of_lading',
  hbl: 'bill_of_lading',
  mbl: 'bill_of_lading',
  7501: '7501',
  'cbp 7501': '7501',
  'cbp form 7501': '7501',
  'form 7501': '7501',
  'entry summary': '7501',
  poa: 'poa',
  'power of attorney': 'poa',
  arrival_notice: 'arrival_notice',
  'arrival notice': 'arrival_notice',
  isf: 'isf',
  '10+2': 'isf',
  'isf 10+2': 'isf',
  delivery_order: 'delivery_order',
  'delivery order': 'delivery_order',
  do: 'delivery_order',
  freight_invoice: 'freight_invoice',
  'freight invoice': 'freight_invoice',
};

const DOC_TYPE_LABELS = {
  commercial_invoice: 'Commercial Invoice',
  packing_list: 'Packing List',
  bill_of_lading: 'Bill of Lading',
  7501: 'CBP Form 7501',
  poa: 'Power of Attorney',
  arrival_notice: 'Arrival Notice',
  isf: 'ISF (10+2)',
  delivery_order: 'Delivery Order',
  freight_invoice: 'Freight Invoice',
};

export function normalizeDocType(t) {
  const raw = String(t || '').trim().toLowerCase();
  if (!raw) return null;
  if (DOC_TYPE_ALIASES[raw]) return DOC_TYPE_ALIASES[raw];
  return raw.replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60) || null;
}

export function docTypeLabel(type) {
  return DOC_TYPE_LABELS[type] || String(type || '').replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

const memDocs = new Map(); // id -> doc, when no DATABASE_URL

const s = (v, n = 300) => (v == null ? null : String(v).slice(0, n));

function rowToDoc(r) {
  return {
    id: r.id,
    shipmentId: r.shipment_id,
    scope: r.scope,
    docType: r.doc_type,
    label: docTypeLabel(r.doc_type),
    status: r.status,
    driveFileId: r.drive_file_id,
    driveUrl: r.drive_url,
    filename: r.filename,
    notes: r.notes,
    expiresAt: r.expires_at instanceof Date ? r.expires_at.toISOString().slice(0, 10) : r.expires_at,
    createdBy: r.created_by,
    approvedBy: r.approved_by,
    approvedAt: r.approved_at instanceof Date ? r.approved_at.toISOString() : r.approved_at,
    createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : r.created_at,
    updatedAt: r.updated_at instanceof Date ? r.updated_at.toISOString() : r.updated_at,
  };
}

export async function createDocument(by, body = {}) {
  const scope = DOC_SCOPES.includes(body.scope) ? body.scope : body.shipmentId ? 'shipment' : 'company';
  if (scope === 'shipment' && !body.shipmentId) throw new Error('shipmentId required for shipment-scoped documents');
  const docType = normalizeDocType(body.docType);
  if (!docType) throw new Error('docType required');
  const status = DOC_STATUSES.includes(body.status) ? body.status : 'received';
  const now = new Date().toISOString();
  const doc = {
    id: crypto.randomUUID(),
    shipmentId: scope === 'shipment' ? String(body.shipmentId) : null,
    scope,
    docType,
    label: docTypeLabel(docType),
    status,
    driveFileId: s(body.driveFileId, 200),
    driveUrl: s(body.driveUrl, 1000),
    filename: s(body.filename, 300),
    notes: s(body.notes, 2000),
    expiresAt: body.expiresAt ? s(body.expiresAt, 10) : null,
    createdBy: by,
    approvedBy: status === 'approved' || status === 'filed' ? by : null,
    approvedAt: status === 'approved' || status === 'filed' ? now : null,
    createdAt: now,
    updatedAt: now,
  };
  if (!pool) {
    memDocs.set(doc.id, doc);
    return doc;
  }
  await q(
    `INSERT INTO inbound_documents (id, shipment_id, scope, doc_type, status, drive_file_id, drive_url, filename, notes, expires_at, created_by, approved_by, approved_at, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$14)`,
    [doc.id, doc.shipmentId, doc.scope, doc.docType, doc.status, doc.driveFileId, doc.driveUrl, doc.filename, doc.notes, doc.expiresAt, by, doc.approvedBy, doc.approvedAt, now]
  );
  return doc;
}

export async function getDocument(id) {
  if (!pool) return memDocs.get(id) || null;
  const { rows } = await q('SELECT * FROM inbound_documents WHERE id = $1', [id]);
  return rows[0] ? rowToDoc(rows[0]) : null;
}

// Update status / drive link / notes. Moving into approved (or straight to filed) stamps
// approved_by/at — that's the audit trail for "approve" replies over WhatsApp.
export async function updateDocument(id, by, body = {}) {
  const doc = await getDocument(id);
  if (!doc) return null;
  const now = new Date().toISOString();
  const next = { ...doc };
  if (body.status !== undefined) {
    if (!DOC_STATUSES.includes(body.status)) throw new Error(`status must be one of: ${DOC_STATUSES.join(', ')}`);
    next.status = body.status;
    if ((body.status === 'approved' || body.status === 'filed') && !doc.approvedAt) {
      next.approvedBy = by;
      next.approvedAt = now;
    }
    if (body.status === 'required' || body.status === 'received') {
      next.approvedBy = null;
      next.approvedAt = null;
    }
  }
  for (const [k, n] of [['driveFileId', 200], ['driveUrl', 1000], ['filename', 300], ['notes', 2000]]) {
    if (body[k] !== undefined) next[k] = s(body[k], n);
  }
  if (body.expiresAt !== undefined) next.expiresAt = body.expiresAt ? s(body.expiresAt, 10) : null;
  next.updatedAt = now;
  if (!pool) {
    memDocs.set(id, next);
    return next;
  }
  await q(
    `UPDATE inbound_documents SET status=$2, drive_file_id=$3, drive_url=$4, filename=$5, notes=$6, expires_at=$7, approved_by=$8, approved_at=$9, updated_at=$10 WHERE id=$1`,
    [id, next.status, next.driveFileId, next.driveUrl, next.filename, next.notes, next.expiresAt, next.approvedBy, next.approvedAt, now]
  );
  return next;
}

export async function listShipmentDocuments(shipmentId) {
  if (!pool) {
    return [...memDocs.values()].filter((d) => d.shipmentId === String(shipmentId));
  }
  const { rows } = await q('SELECT * FROM inbound_documents WHERE shipment_id = $1 ORDER BY created_at', [shipmentId]);
  return rows.map(rowToDoc);
}

export async function listDocumentsForShipments(ids) {
  const byShip = new Map();
  if (!ids.length) return byShip;
  const push = (d) => {
    if (!byShip.has(d.shipmentId)) byShip.set(d.shipmentId, []);
    byShip.get(d.shipmentId).push(d);
  };
  if (!pool) {
    const want = new Set(ids.map(String));
    for (const d of memDocs.values()) if (d.shipmentId && want.has(d.shipmentId)) push(d);
    return byShip;
  }
  const { rows } = await q('SELECT * FROM inbound_documents WHERE shipment_id = ANY($1::text[]) ORDER BY created_at', [ids]);
  for (const r of rows) push(rowToDoc(r));
  return byShip;
}

export async function listCompanyDocuments() {
  if (!pool) return [...memDocs.values()].filter((d) => d.scope === 'company');
  const { rows } = await q(`SELECT * FROM inbound_documents WHERE scope = 'company' ORDER BY created_at`, []);
  return rows.map(rowToDoc);
}

// The per-shipment checklist: every doc type in cfg.requiredDocs appears (virtually 'required'
// until a real row exists), plus any extra registered docs. `complete` = all required types are
// at received-or-better.
export function checklistFor(docs = []) {
  const byType = new Map();
  for (const d of docs) {
    const cur = byType.get(d.docType);
    // best row per type wins (later in ladder = better)
    if (!cur || DOC_STATUSES.indexOf(d.status) > DOC_STATUSES.indexOf(cur.status)) byType.set(d.docType, d);
  }
  const items = [];
  for (const type of cfg.requiredDocs) {
    const d = byType.get(type);
    items.push({
      docType: type,
      label: docTypeLabel(type),
      required: true,
      status: d ? d.status : 'required',
      docId: d?.id || null,
      driveUrl: d?.driveUrl || null,
    });
    byType.delete(type);
  }
  for (const [type, d] of byType) {
    items.push({ docType: type, label: docTypeLabel(type), required: false, status: d.status, docId: d.id, driveUrl: d.driveUrl });
  }
  const missing = items.filter((i) => i.required && i.status === 'required').map((i) => i.docType);
  return { items, missing, complete: missing.length === 0 };
}
