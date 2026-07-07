import React, { useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';

// Back-office inbound shipment tracker (ADMIN ONLY — reps never see this tab).
// Lanes: Ordered → In transit → Arrived → Receiving → Received. Each shipment carries origin,
// references, ETA, a status timeline, and SKU lines. "Receive" runs the QA intake that replaces
// the Google Sheet: counted / damaged / bin locations per line; good units push to Shopify.
const LANES = [
  ['ordered', 'Ordered'],
  ['in_transit', 'In transit'],
  ['arrived', 'Arrived'],
  ['receiving', 'Receiving'],
  ['received', 'Received'],
];

const fmtDate = (d) => {
  if (!d) return '—';
  try {
    return new Date(d + (d.length === 10 ? 'T00:00:00' : '')).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
    });
  } catch {
    return d;
  }
};

const daysLate = (eta) => {
  if (!eta) return 0;
  return Math.floor((Date.now() - new Date(eta + 'T00:00:00').getTime()) / 86400000);
};

export function InboundView({ snapshot }) {
  const [ships, setShips] = useState(null);
  const [editing, setEditing] = useState(null); // shipment object | 'new' | {prefill}
  const [receiving, setReceiving] = useState(null); // shipment object
  const [parsing, setParsing] = useState(false);
  const [err, setErr] = useState('');

  // Import a supplier ORD / packing-list document → parsed lines open in the editor for review.
  const importFile = async (file) => {
    if (!file) return;
    setParsing(true);
    setErr('');
    try {
      const { parsed } = await api.inboundParse(file);
      // WHEN / WHO / WHERE pulled from the document itself → prefilled into the shipment record.
      const noteLines = [
        `Imported from ${parsed.filename} — ${parsed.matchedCount} matched, ${parsed.unmatchedCount} unmatched`,
        parsed.docDate && `Document date: ${parsed.docDate}`,
        parsed.customerPo && `Customer PO: ${parsed.customerPo}`,
        parsed.fob && `FOB: ${parsed.fob}`,
        parsed.madeIn?.length && `Goods made in: ${parsed.madeIn.join(', ')}`,
        parsed.linked?.length && `Linked doc(s): ${parsed.linked.join(', ')}`,
        parsed.supplierNote && `Supplier note: ${parsed.supplierNote}`,
      ].filter(Boolean);
      setEditing({
        prefill: {
          origin: parsed.origin || '',
          reference: parsed.reference || '',
          // A packing list means goods are packed & moving; a pro-forma is still at "ordered".
          status: parsed.docType === 'packing_list' ? 'in_transit' : 'ordered',
          invoiceTotal: parsed.invoiceTotal ?? '',
          notes: noteLines.join('\n'),
          lines: parsed.lines.map((l) => ({
            id: crypto.randomUUID(),
            sku: l.sku,
            variantId: l.variantId,
            title: l.title,
            expected: l.expected,
          })),
        },
      });
    } catch (e) {
      setErr(e?.message || 'Could not parse the file');
    } finally {
      setParsing(false);
    }
  };

  const load = async () => {
    try {
      const r = await api.inboundList();
      setShips(r.shipments || []);
      setErr('');
    } catch (e) {
      setErr(/403/.test(String(e?.message)) ? 'Admin access required.' : 'Could not load shipments.');
      setShips([]);
    }
  };
  useEffect(() => {
    load();
  }, []);

  const skuIndex = useMemo(() => {
    const m = new Map();
    for (const p of snapshot?.products || [])
      for (const v of p.variants) if (v.sku) m.set(v.sku.toLowerCase(), { product: p, variant: v });
    return m;
  }, [snapshot]);

  if (ships == null) return <div className="center muted">Loading shipments…</div>;

  const open = ships.filter((x) => x.status !== 'received' && x.status !== 'cancelled');
  const totalUnits = (ship) => ship.lines.reduce((n, l) => n + (l.expected || 0), 0);

  return (
    <div className="inbound">
      <div className="checkout-head">
        <div>
          <strong>Inbound shipments</strong>{' '}
          <span className="muted small">
            {open.length} open · {open.reduce((n, x) => n + totalUnits(x), 0)} units on the way
          </span>
        </div>
        <span className="inb-head-actions">
          <label className="secondary small-btn inb-import">
            {parsing ? 'Parsing…' : '📄 Import ORD/PKLIST'}
            <input
              type="file"
              accept=".pdf,.xlsx,.xls"
              hidden
              disabled={parsing}
              onChange={(e) => {
                importFile(e.target.files?.[0]);
                e.target.value = '';
              }}
            />
          </label>
          <button className="primary small" onClick={() => setEditing('new')}>
            + New shipment
          </button>
        </span>
      </div>
      {err && <div className="err">{err}</div>}

      <KanbanBoard
        ships={ships}
        onMove={async (ship, status) => {
          const label = LANES.find(([k]) => k === status)?.[1] || status;
          if (!window.confirm(`Confirm: move ${ship.reference || ship.origin || 'shipment'} to "${label}"?`)) return;
          try {
            await api.inboundUpdate(ship.id, { status, statusNote: 'Moved on board' });
          } catch (e) {
            setErr(e?.message || 'Move failed');
          }
          load();
        }}
        onOpen={setEditing}
        onReceive={setReceiving}
      />

      {ships.length === 0 && (
        <div className="center muted">No shipments yet — add the ones currently on the water/air.</div>
      )}

      {editing && (
        <ShipmentEditor
          shipment={editing === 'new' || editing.prefill ? null : editing}
          prefill={editing.prefill || null}
          skuIndex={skuIndex}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            load();
          }}
        />
      )}
      {receiving && (
        <ReceiveModal
          knownBins={[...new Set(ships.flatMap((x) => x.lines.flatMap((l) => (l.bins || []).map((b) => b.bin))))].sort()}
          shipment={receiving}
          onClose={() => setReceiving(null)}
          onDone={() => {
            setReceiving(null);
            load();
          }}
        />
      )}
    </div>
  );
}

const money0 = (n) =>
  n == null ? null : new Intl.NumberFormat('en-US', { style: 'currency', currency: 'EUR' }).format(n);

function PayBadge({ ship }) {
  const m = {
    paid: ['pay-paid', 'PAID'],
    deposit_paid: ['pay-deposit', ship.paidAmount != null ? `DEP ${money0(ship.paidAmount)}` : 'DEPOSIT PAID'],
    unpaid: ['pay-unpaid', 'UNPAID'],
  }[ship.paymentStatus || 'unpaid'];
  return <span className={`badge ${m[0]}`}>{m[1]}</span>;
}

// Kanban board: columns per status, cards draggable between them (desktop) with ◀ ▶ buttons as
// the touch-friendly equivalent. Every move asks for confirmation — moving to "In transit" etc.
// is a deliberate act that stamps the timeline. Receiving/Received are guarded: stock only moves
// through the QA Receive flow, so drops into those columns open it instead of skipping QA.
function KanbanBoard({ ships, onMove, onOpen, onReceive }) {
  const cols = LANES.filter(([k]) => k !== 'cancelled');
  const byCol = (k) => ships.filter((x) => x.status === k);

  const requestMove = (ship, target) => {
    if (target === ship.status) return;
    if (target === 'received' || target === 'receiving') return onReceive(ship); // QA gate
    onMove(ship, target);
  };

  return (
    <div className="kanban">
      {cols.map(([key, label]) => (
        <div
          key={key}
          className="kcol"
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            const id = e.dataTransfer.getData('text/ship');
            const ship = ships.find((x) => x.id === id);
            if (ship) requestMove(ship, key);
          }}
        >
          <div className="kcol-head">
            {label} <span className="muted small">{byCol(key).length}</span>
          </div>
          {byCol(key).map((ship) => {
            const late = key !== 'received' ? daysLate(ship.eta) : 0;
            const idx = cols.findIndex(([k]) => k === key);
            return (
              <div
                key={ship.id}
                className="kcard"
                draggable
                onDragStart={(e) => e.dataTransfer.setData('text/ship', ship.id)}
              >
                <div className="kcard-top" onClick={() => onOpen(ship)}>
                  <strong>{ship.reference || ship.origin || 'Shipment'}</strong>
                  <PayBadge ship={ship} />
                </div>
                <div className="muted small" onClick={() => onOpen(ship)}>
                  {ship.origin && ship.reference ? `${ship.origin} · ` : ''}
                  ETA {fmtDate(ship.eta)}
                  {late > 0 ? ` · ${late}d late` : ''} · {ship.lines.reduce((n, l) => n + (l.expected || 0), 0)}u
                  {ship.invoiceTotal != null ? ` · ${money0(ship.invoiceTotal)}` : ''}
                  {ship.lines.some((l) => l.syncError) ? ' · ⚠' : ''}
                </div>
                <div className="kmove">
                  <button disabled={idx === 0} onClick={() => requestMove(ship, cols[idx - 1]?.[0])}>◀</button>
                  {(key === 'in_transit' || key === 'arrived' || key === 'receiving') && (
                    <button className="krcv" onClick={() => onReceive(ship)}>Receive</button>
                  )}
                  <button disabled={idx === cols.length - 1} onClick={() => requestMove(ship, cols[idx + 1]?.[0])}>▶</button>
                </div>
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

function ShipmentEditor({ shipment, prefill, skuIndex, onClose, onSaved }) {
  const init = shipment || prefill;
  const [origin, setOrigin] = useState(init?.origin || '');
  const [reference, setReference] = useState(init?.reference || '');
  const [carrier, setCarrier] = useState(init?.carrier || '');
  const [tracking, setTracking] = useState(init?.tracking || '');
  const [eta, setEta] = useState(init?.eta || '');
  const [status, setStatus] = useState(init?.status || 'ordered');
  const [statusNote, setStatusNote] = useState('');
  const [notes, setNotes] = useState(init?.notes || '');
  const [paymentStatus, setPaymentStatus] = useState(init?.paymentStatus || 'unpaid');
  const [paidAmount, setPaidAmount] = useState(init?.paidAmount ?? '');
  const [invoiceTotal, setInvoiceTotal] = useState(init?.invoiceTotal ?? '');
  const [lines, setLines] = useState(init?.lines || []);
  const [skuInput, setSkuInput] = useState('');
  const [qtyInput, setQtyInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const addLine = () => {
    const sku = skuInput.trim();
    if (!sku) return;
    const hit = skuIndex.get(sku.toLowerCase());
    setLines((ls) => [
      ...ls,
      {
        id: crypto.randomUUID(),
        sku: hit?.variant.sku || sku,
        variantId: hit?.variant.id || null,
        title: hit?.product.title || null,
        expected: Math.max(1, Math.floor(Number(qtyInput) || 1)),
      },
    ]);
    setSkuInput('');
    setQtyInput('');
  };

  const save = async () => {
    setBusy(true);
    setErr('');
    try {
      const body = { origin, reference, carrier, tracking, eta, notes, status, statusNote, lines, paymentStatus, paidAmount, invoiceTotal };
      if (shipment) await api.inboundUpdate(shipment.id, body);
      else await api.inboundCreate(body);
      onSaved();
    } catch (e) {
      setErr(e?.message || 'Could not save');
      setBusy(false);
    }
  };

  return (
    <div className="cart-overlay" onClick={onClose}>
      <div className="cart" onClick={(e) => e.stopPropagation()}>
        <div className="cart-head">
          <strong>{shipment ? `Shipment ${shipment.reference || ''}` : 'New shipment'}</strong>
          <button className="x" onClick={onClose}>✕</button>
        </div>
        <div className="cart-body">
          <div className="cfields">
            <input placeholder="Origin (e.g. Baci Milano HQ — Italy)" value={origin} onChange={(e) => setOrigin(e.target.value)} />
            <input placeholder="Reference (PO / invoice / container #)" value={reference} onChange={(e) => setReference(e.target.value)} />
            <div className="cust-addr-row inbound-row2">
              <input placeholder="Carrier" value={carrier} onChange={(e) => setCarrier(e.target.value)} />
              <input placeholder="Tracking #" value={tracking} onChange={(e) => setTracking(e.target.value)} />
            </div>
            <label className="inbound-field">
              <span>ETA</span>
              <input type="date" value={eta || ''} onChange={(e) => setEta(e.target.value)} />
            </label>
            <label className="inbound-field">
              <span>Status</span>
              <select value={status} onChange={(e) => setStatus(e.target.value)}>
                {LANES.map(([k, l]) => (
                  <option key={k} value={k}>{l}</option>
                ))}
                <option value="cancelled">Cancelled</option>
              </select>
            </label>
            <input placeholder="Status note (e.g. cleared customs 7/2)" value={statusNote} onChange={(e) => setStatusNote(e.target.value)} />
            <label className="inbound-field">
              <span>Payment</span>
              <select value={paymentStatus} onChange={(e) => setPaymentStatus(e.target.value)}>
                <option value="unpaid">Unpaid</option>
                <option value="deposit_paid">Deposit / partial paid</option>
                <option value="paid">Paid in full</option>
              </select>
            </label>
            <div className="cust-addr-row inbound-row2">
              <input type="number" step="0.01" placeholder="Amount paid (€)" value={paidAmount} onChange={(e) => setPaidAmount(e.target.value)} />
              <input type="number" step="0.01" placeholder="Invoice total (€)" value={invoiceTotal} onChange={(e) => setInvoiceTotal(e.target.value)} />
            </div>
            <textarea placeholder="Notes" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
          </div>

          <div className="lane-head">Items</div>
          {lines.map((l, i) => (
            <div className="inb-line" key={l.id || i}>
              <div className="inb-line-main">
                <span className="fsku">{l.sku}</span>
                <span className={l.variantId ? 'small' : 'small err-inline'}>
                  {l.title || (l.variantId ? '' : 'not in catalog')}
                </span>
              </div>
              <input
                className="fqty"
                type="number"
                min="0"
                value={l.expected}
                onChange={(e) =>
                  setLines((ls) => ls.map((x, j) => (j === i ? { ...x, expected: Number(e.target.value) || 0 } : x)))
                }
              />
              <button className="link" onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}>✕</button>
            </div>
          ))}
          <div className="inb-add">
            <input placeholder="SKU" value={skuInput} onChange={(e) => setSkuInput(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && addLine()} />
            <input className="fqty" type="number" placeholder="Qty" value={qtyInput} onChange={(e) => setQtyInput(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && addLine()} />
            <button className="secondary small-btn" onClick={addLine}>Add</button>
          </div>

          {shipment?.timeline?.length > 0 && (
            <>
              <div className="lane-head">Timeline</div>
              {[...shipment.timeline].reverse().map((t, i) => (
                <div className="muted small tl-row" key={i}>
                  {fmtDate(t.at?.slice(0, 10))} — {t.status}{t.note ? ` · ${t.note}` : ''} {t.by ? `(${t.by})` : ''}
                </div>
              ))}
            </>
          )}

          {err && <div className="err">{err}</div>}
          <button className="primary" disabled={busy} onClick={save}>
            {busy ? 'Saving…' : 'Save shipment'}
          </button>
        </div>
      </div>
    </div>
  );
}

// The QA intake (replaces the Google Sheet): per line — counted, damaged, and bin locations
// with qty per bin (multi-bin, like Location1..4 on the sheet). Good units (counted − damaged)
// go up in Shopify at Miami; bin codes go to the product's warehouse.bin_location metafield.
// knownBins = every location ID used so far, offered as type-ahead suggestions. Any NEW code
// typed here is accepted as-is (normalized to uppercase server-side) and automatically joins
// the suggestion list for future receives — no separate "manage locations" step needed.
function ReceiveModal({ shipment, onClose, onDone, knownBins = [] }) {
  const [rows, setRows] = useState(
    shipment.lines
      .filter((l) => !l.receivedAt)
      .map((l) => ({
        id: l.id,
        sku: l.sku,
        title: l.title,
        expected: l.expected,
        received: l.expected,
        damaged: 0,
        bins: [{ bin: '', qty: l.expected }],
      }))
  );
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const setRow = (i, patch) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const setBin = (i, bi, patch) =>
    setRows((rs) =>
      rs.map((r, j) =>
        j === i ? { ...r, bins: r.bins.map((b, k) => (k === bi ? { ...b, ...patch } : b)) } : r
      )
    );

  const submit = async () => {
    setBusy(true);
    setErr('');
    try {
      const body = {
        lines: rows.map((r) => ({
          id: r.id,
          received: r.received,
          damaged: r.damaged,
          bins: r.bins.filter((b) => b.bin && b.qty > 0),
        })),
      };
      await api.inboundReceive(shipment.id, body);
      onDone();
    } catch (e) {
      setErr(e?.message || 'Receive failed');
      setBusy(false);
    }
  };

  return (
    <div className="cart-overlay" onClick={onClose}>
      <div className="cart" onClick={(e) => e.stopPropagation()}>
        <div className="cart-head">
          <strong>Receive · {shipment.origin || shipment.reference || 'shipment'}</strong>
          <button className="x" onClick={onClose}>✕</button>
        </div>
        <div className="cart-body">
          <datalist id="bin-options">
            {knownBins.map((b) => (
              <option key={b} value={b} />
            ))}
          </datalist>
          {rows.length === 0 && <div className="muted center">All lines already received.</div>}
          {rows.map((r, i) => {
            const good = Math.max(0, r.received - r.damaged);
            return (
              <div className="rcv-line" key={r.id}>
                <div className="rcv-head">
                  <span className="fsku">{r.sku}</span>
                  <span className="small muted">{r.title || ''} · expected {r.expected}</span>
                </div>
                <div className="rcv-nums">
                  <label>
                    Counted
                    <input className="fqty" type="number" min="0" value={r.received} onChange={(e) => setRow(i, { received: Number(e.target.value) || 0 })} />
                  </label>
                  <label>
                    Damaged
                    <input className="fqty" type="number" min="0" value={r.damaged} onChange={(e) => setRow(i, { damaged: Number(e.target.value) || 0 })} />
                  </label>
                  <span className="rcv-good">→ {good} to shelf</span>
                </div>
                <div className="rcv-bins">
                  {r.bins.map((b, bi) => (
                    <span className="rcv-bin" key={bi}>
                      <input
                        list="bin-options"
                        placeholder="Location (1D4)"
                        value={b.bin}
                        onChange={(e) => setBin(i, bi, { bin: e.target.value })}
                      />
                      <input className="fqty" type="number" min="0" value={b.qty} onChange={(e) => setBin(i, bi, { qty: Number(e.target.value) || 0 })} />
                    </span>
                  ))}
                  <button className="link" onClick={() => setRow(i, { bins: [...r.bins, { bin: '', qty: 0 }] })}>
                    + bin
                  </button>
                </div>
              </div>
            );
          })}

          {err && <div className="err">{err}</div>}
          {rows.length > 0 && (
            <button className="primary" disabled={busy} onClick={submit}>
              {busy ? 'Receiving…' : 'Confirm intake → update stock'}
            </button>
          )}
          <div className="muted small">
            Good units (counted − damaged) are added to Miami stock in Shopify; bin codes update
            the product's warehouse location field. If Shopify rejects the write (scope pending),
            it's recorded and flagged for retry — nothing is lost.
          </div>
        </div>
      </div>
    </div>
  );
}
