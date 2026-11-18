import React, { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api.js';

// Documents inbox: every supplier / freight / customs document the app has taken in, what was
// read from it, and the shipment it belongs to. A document whose reference numbers point at one
// shipment files itself; one that points at none, or at several, waits here for a person.
const money = (n, currency) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: currency || 'EUR' }).format(Number(n) || 0);
const TYPE = { order: 'Order', invoice: 'Supplier invoice', packing_list: 'Packing list', bill_of_lading: 'Bill of lading', 7501: 'Customs entry', arrival_notice: 'Arrival notice', freight_invoice: 'Freight invoice', unknown: 'Document' };
const shipName = (s) => s.reference || s.origin || 'Shipment';

// One line of what was read, so staff can see the document was understood before trusting it.
function readSummary(d) {
  const x = d.extracted;
  if (!x || !x.lines) return null;
  const bits = [];
  if (x.totals?.units) bits.push(`${x.lines.length} lines · ${x.totals.units} units`);
  if (x.invoiceTotal != null) bits.push(money(x.invoiceTotal, x.lines.find((l) => l.currency)?.currency));
  if (x.totals?.cbm) bits.push(`${x.totals.cbm} m³`);
  if (x.totals?.cartons) bits.push(`${x.totals.cartons} cartons`);
  if (x.totals?.grossKg) bits.push(`${x.totals.grossKg} kg gross`);
  if (x.madeIn?.length) bits.push(`made in ${x.madeIn.map((c) => c[0] + c.slice(1).toLowerCase()).join(', ')}`);
  if (x.incoterm) bits.push(x.incoterm);
  return bits.join(' · ');
}

export function DocumentsInbox({ ships, onChanged }) {
  const [docs, setDocs] = useState(null);
  const [kinds, setKinds] = useState({});
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState('');
  const [pick, setPick] = useState({}); // doc id -> chosen shipment id
  const fileRef = useRef(null);
  const [applying, setApplying] = useState(null); // { id, preview }
  const openApply = async (d) => {
    setErr('');
    try {
      setApplying({ id: d.id, preview: (await api.intakeApplyPreview(d.id)).preview });
    } catch (e) {
      setErr(e?.message || 'Could not work out the changes');
    }
  };

  const load = useCallback(async () => {
    try {
      const r = await api.intake();
      setDocs(r.documents || []);
      setKinds(r.refKinds || {});
      setErr('');
    } catch (e) {
      setErr(e?.message || 'Could not load documents');
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  const upload = async (files) => {
    setErr('');
    let dupes = 0;
    for (const f of files) {
      setBusy(`Reading ${f.name}…`);
      try {
        const r = await api.intakeUpload(f);
        if (r.duplicate) dupes += 1;
      } catch (e) {
        setErr(`${f.name}: ${e?.message || 'could not be read'}`);
      }
    }
    setBusy('');
    if (dupes) setErr(`${dupes} file${dupes === 1 ? ' was' : 's were'} already in the inbox and not added again.`);
    await load();
    onChanged?.();
  };
  const act = async (fn) => {
    setErr('');
    try {
      await fn();
      await load();
      onChanged?.();
    } catch (e) {
      setErr(e?.message || 'Could not update');
    }
  };

  if (docs == null && !err) return <div className="center muted">Loading documents…</div>;
  const waiting = (docs || []).filter((d) => d.status === 'needs_review' || d.status === 'unmatched');
  const filed = (docs || []).filter((d) => d.status === 'matched');
  const open = (ships || []).filter((s) => s.status !== 'cancelled');

  const row = (d) => {
    const x = d.extracted;
    const chosen = pick[d.id] ?? d.candidates?.[0]?.id ?? '';
    return (
      <div className="doc-row" key={d.id}>
        <div className="doc-main">
          <div className="doc-name">
            {d.driveUrl ? <a className="link" href={d.driveUrl} target="_blank" rel="noreferrer">{d.filename}</a> : d.filename}
            <span className="badge card">{TYPE[d.docType] || d.docType}</span>
            {d.source !== 'upload' && <span className="muted small"> · via {d.source}</span>}
          </div>
          <div className="doc-refs">
            {d.refs.length === 0 && <span className="muted small">No reference number found on this document</span>}
            {d.refs.map((r) => (
              <span className="ord-src" key={`${r.kind}${r.value}`}>
                {kinds[r.kind] || r.kind} {r.value}
              </span>
            ))}
          </div>
          {readSummary(d) && <div className="small">{readSummary(d)}</div>}
          {x?.checks?.totalMatches === false && (
            <div className="err-inline small">The lines add up to {money(x.checks.linesTotal)} but the document states {money(x.invoiceTotal)}. Check it before using these figures.</div>
          )}
          {x?.checks?.badLines?.length > 0 && <div className="err-inline small">Quantity × price does not match the line total on: {x.checks.badLines.join(', ')}</div>}
          {x?.unmatchedCount > 0 && <div className="muted small">{x.unmatchedCount} of {x.lines.length} item codes are not in the catalog</div>}
          {applying?.id === d.id && <ApplyPanel preview={applying.preview} onCancel={() => setApplying(null)} onApply={(opts) => act(async () => { await api.intakeApply(d.id, opts); setApplying(null); })} />}
        </div>

        {d.status === 'matched' ? (
          <div className="doc-side">
            <span className="badge ready">Filed</span>
            <span className="small">{d.shipment ? shipName(d.shipment) : ''}</span>
            {d.applied ? (
              <span className="muted small">{d.applied.summary?.created ? 'Shipment created from it' : 'Applied to the shipment'}</span>
            ) : (
              d.extracted && applying?.id !== d.id && (
                <button className="secondary small-btn" onClick={() => openApply(d)}>Apply to shipment</button>
              )
            )}
          </div>
        ) : (
          <div className="doc-side">
            <span className="small">
              {d.status === 'needs_review' ? 'Matches more than one shipment' : d.refs.length ? 'No shipment has these numbers yet' : 'Needs a shipment'}
            </span>
            <select value={chosen} onChange={(e) => setPick((p) => ({ ...p, [d.id]: e.target.value }))}>
              <option value="">Choose a shipment…</option>
              {d.candidates?.length > 0 && (
                <optgroup label="Suggested">
                  {d.candidates.map((c) => (
                    <option key={c.id} value={c.id}>
                      {shipName(c)} — matches {c.matchedOn.map((m) => m.value).join(', ')}
                    </option>
                  ))}
                </optgroup>
              )}
              <optgroup label="All shipments">
                {open.filter((s) => !d.candidates?.some((c) => c.id === s.id)).map((s) => (
                  <option key={s.id} value={s.id}>{shipName(s)}</option>
                ))}
              </optgroup>
            </select>
            <div className="doc-btns">
              <button className="primary small" disabled={!chosen} onClick={() => act(() => api.intakeAssign(d.id, { shipmentId: chosen }))}>File on it</button>
              <button className="secondary small-btn" onClick={() => act(() => api.intakeAssign(d.id, { create: true }))}>New shipment</button>
              <button className="link" onClick={() => act(() => api.intakeIgnore(d.id))}>Not a shipment document</button>
            </div>
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="docs-inbox">
      <div className="docs-head">
        <div className="muted small">
          Add supplier orders, invoices and packing lists (PDF or Excel). The app reads them and files each on its shipment by its reference numbers.
        </div>
        <input ref={fileRef} type="file" multiple accept=".pdf,.xlsx,.xls" hidden onChange={(e) => { upload([...e.target.files]); e.target.value = ''; }} />
        <button className="secondary small-btn" disabled={!!busy} onClick={() => fileRef.current?.click()}>{busy || '+ Add documents'}</button>
      </div>
      {err && <div className="err-inline small">{err}</div>}

      {waiting.length > 0 && <div className="lane-head">Needs a decision · {waiting.length}</div>}
      {waiting.map(row)}
      <div className="lane-head">Filed · {filed.length}</div>
      {filed.length === 0 && <div className="muted small">Nothing filed yet.</div>}
      {filed.map(row)}
    </div>
  );
}

// What applying a document would change, shown before anything changes.
function ApplyPanel({ preview: p, onCancel, onApply }) {
  const [addMissing, setAddMissing] = useState(p.missing.length > 0 && p.lineUpdates === 0);
  const [setQuantities, setSetQuantities] = useState(false);
  const fmt = (v) => (v == null || v === '' ? 'empty' : String(v));
  if (p.nothing) {
    return (
      <div className="ord-confirm">
        <div className="small">This document adds nothing new to shipment {p.shipment.reference || ''}.</div>
        <div className="ord-confirm-btns"><button className="link" onClick={onCancel}>Close</button></div>
      </div>
    );
  }
  return (
    <div className="ord-confirm">
      <div className="small"><strong>Applying this to shipment {p.shipment.reference || p.shipment.origin || ''} will:</strong></div>
      <ul className="apply-list small">
        {p.lineUpdates > 0 && <li>Fill in {p.fields.join(', ')} on {p.lineUpdates} line{p.lineUpdates === 1 ? '' : 's'}</li>}
        {p.header.map((h) => (
          <li key={h.field}>{h.label}: {fmt(h.from)} → <strong>{fmt(h.to)}</strong></li>
        ))}
      </ul>
      {p.missing.length > 0 && (
        <label className="apply-opt small">
          <input type="checkbox" checked={addMissing} onChange={(e) => setAddMissing(e.target.checked)} />
          Add {p.missing.length} item{p.missing.length === 1 ? '' : 's'} that the shipment does not list yet ({p.missing.slice(0, 4).map((m) => m.sku).join(', ')}{p.missing.length > 4 ? '…' : ''})
        </label>
      )}
      {p.qtyDiffs.length > 0 && (
        <label className="apply-opt small">
          <input type="checkbox" checked={setQuantities} onChange={(e) => setSetQuantities(e.target.checked)} />
          Change {p.qtyDiffs.length} quantit{p.qtyDiffs.length === 1 ? 'y' : 'ies'} to the document's ({p.qtyDiffs.slice(0, 3).map((q) => `${q.sku} ${q.shipment} → ${q.document}`).join(', ')}{p.qtyDiffs.length > 3 ? '…' : ''}). Units reserved for client orders are re-checked.
        </label>
      )}
      {p.notOnDocument.length > 0 && <div className="muted small">{p.notOnDocument.length === 1 ? '1 shipment item is not on this document and stays as it is.' : `${p.notOnDocument.length} shipment items are not on this document and stay as they are.`}</div>}
      <div className="ord-confirm-btns">
        <button className="primary small" onClick={() => onApply({ addMissing, setQuantities })}>Apply</button>
        <button className="link" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

// A shipment's reference numbers, in the shipment editor: every number it is known by.
export function ShipmentRefs({ shipment }) {
  const [refs, setRefs] = useState(shipment.refs || []);
  const [kind, setKind] = useState('forwarder_file');
  const [value, setValue] = useState('');
  const [err, setErr] = useState('');
  const KINDS = [['italy_order', 'Italy order'], ['packing_list', 'Packing list'], ['supplier_invoice', 'Supplier invoice'], ['forwarder_file', 'Forwarder file'], ['booking', 'Booking'], ['bill_of_lading', 'Bill of lading'], ['container', 'Container'], ['customs_entry', 'Customs entry'], ['freight_invoice', 'Freight invoice'], ['broker_invoice', 'Broker invoice'], ['internal', 'Internal']];

  const add = async () => {
    if (!value.trim()) return;
    try {
      const r = await api.refAdd(shipment.id, { kind, value });
      setRefs((xs) => (xs.some((x) => x.id === r.ref.id) ? xs : [...xs, r.ref]));
      setValue('');
      setErr('');
    } catch (e) {
      setErr(e?.message || 'Could not add');
    }
  };
  const remove = async (ref) => {
    try {
      await api.refRemove(shipment.id, ref.id);
      setRefs((xs) => xs.filter((x) => x.id !== ref.id));
    } catch (e) {
      setErr(e?.message || 'Could not remove');
    }
  };

  return (
    <div className="ship-refs">
      <div className="lane-head">Reference numbers</div>
      <div className="muted small">Every number this shipment is known by. A document carrying any of them is filed here.</div>
      <div className="doc-refs">
        {refs.length === 0 && <span className="muted small">None yet.</span>}
        {refs.map((r) => (
          <span className="ord-src" key={r.id}>
            {r.label} {r.value}
            <button type="button" className="ref-x" title="Remove" onClick={() => remove(r)}>✕</button>
          </span>
        ))}
      </div>
      <div className="inb-add">
        <select value={kind} onChange={(e) => setKind(e.target.value)}>
          {KINDS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
        <input placeholder="Number" value={value} onChange={(e) => setValue(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && add()} />
        <button type="button" className="secondary small-btn" onClick={add}>Add</button>
      </div>
      {err && <div className="err-inline small">{err}</div>}
    </div>
  );
}
