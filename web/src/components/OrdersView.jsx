import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';

// Orders, for internal staff. The list answers "which orders need me": a Needs-attention block
// (units that lost their shipment, arrival dates that slipped) and one row per order. Opening an
// order shows everything about it on one page — what was ordered and where each unit is coming
// from, the money as Shopify has it (deposit, balance, paid or not, delivered or not), the
// shipments it depends on with their customs documents, and what has happened to it.
//
// Payment always happens in Shopify. "Prepare balance invoice" shows the figures here first;
// only on confirmation is the deposit credited on the Shopify backorder draft.
const money = (n, currency = 'USD') =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(Number(n) || 0);

const fmtDate = (iso) => {
  if (!iso) return '';
  const d = new Date(iso.length === 10 ? `${iso}T12:00:00` : iso);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
};
const fmtWhen = (iso) =>
  iso ? new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';

const SHIP_STATUS = { draft: 'RFQ draft', ordered: 'Ordered', in_transit: 'In transit', arrived: 'Arrived', receiving: 'Receiving', received: 'Received', cancelled: 'Cancelled' };
const words = (s) => String(s || '').toLowerCase().replace(/_/g, ' ');
const daysLate = (eta) => (eta ? Math.max(0, Math.floor((Date.now() - new Date(`${eta}T23:59:59`).getTime()) / 86400000)) : 0);

function sourceLabel(a) {
  if (a.source === 'stock') return `${a.quantity} from Miami stock`;
  if (a.source === 'shipment' && a.shipment) {
    const s = a.shipment;
    const name = s.reference || s.origin || 'shipment';
    const eta = s.status === 'received' ? '' : s.eta ? ` · ETA ${fmtDate(s.eta)}` : ' · no ETA';
    return `${a.quantity} on ${name} · ${SHIP_STATUS[s.status] || s.status}${eta}`;
  }
  return `${a.quantity} not yet ordered from the supplier`;
}

// One line saying what a recorded change was.
function eventText(e) {
  const d = e.detail || {};
  const ref = d.reference || 'a shipment';
  switch (e.kind) {
    case 'created':
      return `Order placed${d.by ? ` by ${d.by}` : ''}`;
    case 'deposit_paid':
      return `Deposit ${d.draft || ''} paid${d.order ? ` (Shopify order ${d.order})` : ''}${d.verified === false ? ' — payment not verified' : ''}`;
    case 'balance_prepared':
      return `Balance invoice prepared on ${d.draft || 'the backorder'}`;
    case 'units_released':
      return `${d.units} unit${d.units === 1 ? '' : 's'} no longer covered by ${ref}${d.why ? ` (${d.why})` : ''} — now waiting to be ordered`;
    case 'units_sourced':
      return `${d.units} unit${d.units === 1 ? '' : 's'} ${d.replaces ? 'moved to' : 'now reserved on'} ${ref}${d.eta ? ` (ETA ${fmtDate(d.eta)})` : d.replaces ? ' (no arrival date yet)' : ''}`;
    case 'eta_changed':
      return `${ref} arrival date ${d.from ? `moved from ${fmtDate(d.from)}` : 'set'}${d.to ? ` to ${fmtDate(d.to)}` : ' removed'} — ${d.units} unit${d.units === 1 ? '' : 's'} on it`;
    default:
      return e.kind;
  }
}

// Where an order stands, in a few words, for the list.
function summary(o) {
  const allocs = o.lines.flatMap((l) => l.allocations);
  const unsourced = allocs.filter((a) => a.source === 'unsourced').reduce((n, a) => n + a.quantity, 0);
  const incoming = allocs.filter((a) => a.source === 'shipment' && a.shipment?.status !== 'received');
  const etas = incoming.map((a) => a.shipment?.eta).filter(Boolean).sort();
  const parts = [];
  if (unsourced) parts.push(`${unsourced} to order`);
  if (incoming.length) parts.push(etas.length ? `arriving ${fmtDate(etas[etas.length - 1])}` : 'arriving, no date');
  if (!unsourced && !incoming.length) parts.push(o.backorderDraft ? 'all goods in Miami' : 'ready to ship');
  return parts.join(' · ');
}

function PayBadge({ p, label }) {
  if (!p) return null;
  const paid = p.financialStatus === 'PAID';
  const text = p.status !== 'COMPLETED' ? 'not invoiced' : p.verified === false ? 'invoiced' : words(p.financialStatus || 'pending');
  return (
    <span className={`badge ${paid ? 'ready' : 'warn'}`}>
      {label} {text}
    </span>
  );
}

export function OrdersView({ canPrepare, currency = 'USD' }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  const [openId, setOpenId] = useState(null);
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState('all');

  const load = useCallback(async () => {
    try {
      setData(await api.orders());
      setErr('');
    } catch (e) {
      setErr(e?.message || 'Could not load orders');
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  const orders = data?.orders || [];
  const shown = useMemo(() => {
    const t = q.trim().toLowerCase();
    return orders.filter((o) => {
      if (filter === 'backorder' && !o.backorderDraft) return false;
      if (filter === 'deposit' && !(o.depositDraft && o.depositDraft.status !== 'paid')) return false;
      if (filter === 'attention' && !o.attention) return false;
      if (!t) return true;
      const hay = [o.customer?.name, o.customer?.email, o.readyDraft?.name, o.backorderDraft?.name, o.depositDraft?.name, ...o.lines.flatMap((l) => [l.sku, l.title])]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      return hay.includes(t);
    });
  }, [orders, q, filter]);

  if (openId) {
    return <OrderDetail id={openId} canPrepare={canPrepare} currency={currency} onBack={() => { setOpenId(null); load(); }} />;
  }
  if (data == null && !err) return <div className="center muted">Loading orders…</div>;

  const review = async (e) => {
    try {
      await api.orderEventReview(e.orderId, e.id);
      await load();
    } catch (x) {
      setErr(x?.message || 'Could not update');
    }
  };

  return (
    <div className="orders">
      {err && <div className="err-inline small">{err}</div>}

      {data?.attention?.length > 0 && (
        <div className="ord-attn">
          <div className="lane-head">Needs attention · {data.attention.length}</div>
          {data.attention.map((e) => (
            <div className="ord-attn-row" key={e.id}>
              <button className="ord-attn-main" onClick={() => setOpenId(e.orderId)}>
                <strong>{e.customer}</strong>
                <span className="small">{eventText(e)}</span>
                <span className="muted small">{fmtWhen(e.at)}</span>
              </button>
              <button className="secondary small-btn" onClick={() => review(e)} title="You have dealt with this: re-sourced it or told the client">
                Mark handled
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="ord-tools">
        <input className="search" placeholder="Search client, draft number, SKU…" value={q} onChange={(e) => setQ(e.target.value)} />
        <div className="ord-filters">
          {[['all', 'All'], ['backorder', 'Backorders'], ['deposit', 'Deposit due'], ['attention', 'Needs attention']].map(([k, label]) => (
            <button key={k} className={filter === k ? 'chip active' : 'chip'} onClick={() => setFilter(k)}>
              {label}
            </button>
          ))}
        </div>
      </div>

      {shown.length === 0 && <div className="center muted">{orders.length ? 'No orders match.' : 'No orders recorded yet.'}</div>}
      {shown.map((o) => {
        const dep = o.depositDraft;
        const units = o.lines.reduce((n, l) => n + l.quantity, 0);
        return (
          <button className="ord-row" key={o.id} onClick={() => setOpenId(o.id)}>
            <div className="ord-row-main">
              <div className="ord-name">{o.customer?.name || o.customer?.email || 'No customer'}</div>
              <div className="muted small">
                {fmtDate(o.createdAt)} · {units} unit{units === 1 ? '' : 's'} · {[o.readyDraft?.name, o.backorderDraft?.name].filter(Boolean).join(' + ')}
              </div>
              <div className="small">{summary(o)}</div>
            </div>
            <div className="ord-badges">
              {o.attention > 0 && <span className="badge new">Needs attention</span>}
              {dep && (
                <span className={`badge ${dep.status === 'paid' ? 'ready' : 'warn'}`}>
                  {dep.status === 'paid' ? 'Deposit paid' : dep.status === 'awaiting_payment' ? 'Deposit payment pending' : 'Deposit due'}
                </span>
              )}
              {o.balance && <span className="badge done">Balance invoiced</span>}
              <span className="ord-total">{money(o.subtotal != null ? o.subtotal * (1 - (o.volumeDiscountPct || 0) / 100) : 0, currency)}</span>
            </div>
          </button>
        );
      })}
    </div>
  );
}

function OrderDetail({ id, canPrepare, currency, onBack }) {
  const [o, setO] = useState(null);
  const [err, setErr] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setO((await api.order(id)).order);
      setErr('');
    } catch (e) {
      setErr(e?.message || 'Could not load the order');
    }
  }, [id]);
  useEffect(() => {
    load();
  }, [load]);

  if (!o) {
    return (
      <div className="orders">
        <button className="link ord-back" onClick={onBack}>‹ All orders</button>
        <div className="center muted">{err || 'Loading order…'}</div>
      </div>
    );
  }

  const m = o.money;
  const dep = o.depositDraft;
  const pay = o.payment || {};
  const prepare = async () => {
    setBusy(true);
    setErr('');
    try {
      await api.orderBalance(o.id);
      setConfirming(false);
      await load();
    } catch (e) {
      setErr(e?.message || 'Could not prepare the balance invoice');
    } finally {
      setBusy(false);
    }
  };
  const review = async (e) => {
    try {
      await api.orderEventReview(o.id, e.id);
      await load();
    } catch (x) {
      setErr(x?.message || 'Could not update');
    }
  };
  const draftLink = (d, label) =>
    d && (
      <a className="link" href={d.adminUrl || d.invoiceUrl} target="_blank" rel="noreferrer" key={d.name}>
        {label} {d.name} ▸
      </a>
    );
  const readyTotal = o.readyDraft ? Number(o.readyDraft.total) || 0 : 0;

  return (
    <div className="orders">
      <button className="link ord-back" onClick={onBack}>‹ All orders</button>
      {err && <div className="err-inline small">{err}</div>}

      <div className="ord-card">
        <div className="ord-head">
          <div>
            <div className="ord-title">{o.customer?.name || o.customer?.email || 'No customer'}</div>
            <div className="muted small">
              Placed {fmtDate(o.createdAt)}
              {o.repName ? ` by ${o.repName}` : ''}
              {o.customer?.email ? ` · ${o.customer.email}` : ''}
              {o.customer?.phone ? ` · ${o.customer.phone}` : ''}
              {o.customer?.isRepeat ? ' · repeat client' : ''}
            </div>
          </div>
        </div>
        <div className="ord-links">
          {draftLink(o.readyDraft, 'Ready order')}
          {draftLink(o.backorderDraft, 'Backorder')}
          {draftLink(o.depositDraft, 'Deposit invoice')}
        </div>
        {o.notes && <div className="small ord-notes">{o.notes}</div>}
      </div>

      {o.events.some((e) => e.needsReview) && (
        <div className="ord-attn">
          <div className="lane-head">Needs attention</div>
          {o.events.filter((e) => e.needsReview).map((e) => (
            <div className="ord-attn-row" key={e.id}>
              <div className="ord-attn-main">
                <span className="small">{eventText(e)}</span>
                <span className="muted small">{fmtWhen(e.at)}</span>
              </div>
              <button className="secondary small-btn" onClick={() => review(e)}>Mark handled</button>
            </div>
          ))}
        </div>
      )}

      <div className="ord-card">
        <div className="lane-head">Items</div>
        {o.lines.map((l) => (
          <div className="ord-line" key={l.id}>
            <div className="ord-line-main">
              <span className="fsku">{l.sku}</span>
              <span className="small">{l.title}</span>
            </div>
            <div className="ord-line-qty">
              <strong>{l.quantity}</strong>
              {l.unitPrice != null && <span className="muted small"> × {money(l.unitPrice, currency)}</span>}
            </div>
            <div className="ord-sources">
              {l.allocations.map((a) => (
                <span key={a.id} className={`ord-src ${a.source}`}>
                  {sourceLabel(a)}
                  {a.firm && a.source !== 'stock' ? ' · held' : ''}
                </span>
              ))}
            </div>
          </div>
        ))}
      </div>

      <div className="ord-card">
        <div className="lane-head">Money</div>
        <div className="ord-money">
          {o.readyDraft && (
            <div className="ord-money-row">
              <span>
                Ready to ship · {o.readyDraft.name} <PayBadge p={pay.ready} label="" />
                {pay.ready?.fulfillmentStatus && <span className="muted small"> · {words(pay.ready.fulfillmentStatus)}</span>}
              </span>
              <span>{money(readyTotal, currency)}</span>
            </div>
          )}
          {m && (
            <>
              <div className="ord-money-row">
                <span>Backorder{m.volumeAmount > 0 ? ` (after ${m.volumeDiscountPct}% volume discount)` : ''} · {m.backorderDraft}</span>
                <span>{money(m.total, currency)}</span>
              </div>
              {dep && (
                <div className="ord-money-row">
                  <span>
                    Deposit {dep.pct}% · {dep.name} ·{' '}
                    {m.depositPaid
                      ? `paid ${fmtDate(dep.paidAt)}${dep.shopifyOrder ? ` · order ${dep.shopifyOrder}` : ''}${dep.verified === false ? ' (payment not verified)' : ''}`
                      : dep.status === 'awaiting_payment'
                        ? `order ${dep.shopifyOrder || ''} created, payment ${words(dep.financialStatus || 'pending')}`
                        : 'not paid yet'}
                  </span>
                  <span>{m.depositPaid ? `− ${money(m.depositAmount, currency)}` : money(m.depositAmount, currency)}</span>
                </div>
              )}
              <div className="ord-money-row total">
                <span>
                  {o.balance ? `Balance invoiced on ${m.backorderDraft}` : dep && !m.depositPaid ? 'Balance after the deposit' : 'Balance to invoice'}{' '}
                  {o.balance && <PayBadge p={pay.backorder} label="" />}
                  {o.balance && pay.backorder?.fulfillmentStatus && <span className="muted small"> · {words(pay.backorder.fulfillmentStatus)}</span>}
                </span>
                <span>{money(o.balance ? o.balance.amount : dep && !m.depositPaid ? m.total - m.depositAmount : m.balance, currency)}</span>
              </div>
              {o.balance?.mismatch && (
                <div className="err-inline small">
                  Shopify shows {money(o.balance.shopifyTotal, currency)} on {m.backorderDraft}. Check the draft before taking payment.
                </div>
              )}
              {canPrepare && !o.balance && !confirming && (
                <button
                  className="secondary small-btn"
                  disabled={dep && !m.depositPaid}
                  onClick={() => setConfirming(true)}
                >
                  Prepare balance invoice
                </button>
              )}
              {canPrepare && !o.balance && dep && !m.depositPaid && (
                <div className="muted small">Available once deposit {dep.name} is paid in Shopify.</div>
              )}
              {confirming && (
                <div className="ord-confirm">
                  <div className="small">
                    This updates draft {m.backorderDraft} in Shopify: the {money(m.credit, currency)} deposit is credited and the draft
                    will charge <strong>{money(m.balance, currency)}</strong>. It then appears in Checkout to collect.
                  </div>
                  <div className="ord-confirm-btns">
                    <button className="primary small" disabled={busy} onClick={prepare}>
                      {busy ? 'Updating Shopify…' : `Send ${money(m.balance, currency)} balance to Shopify`}
                    </button>
                    <button className="link" disabled={busy} onClick={() => setConfirming(false)}>Cancel</button>
                  </div>
                </div>
              )}
            </>
          )}
          <div className="ord-money-row total ord-grand">
            <span>Order total</span>
            <span>{money(readyTotal + (m ? m.total : 0), currency)}</span>
          </div>
        </div>
      </div>

      {o.shipments.length > 0 && (
        <div className="ord-card">
          <div className="lane-head">Shipments this order depends on</div>
          {o.shipments.map((s) => {
            const late = s.status !== 'received' ? daysLate(s.eta) : 0;
            const items = s.docs?.items || [];
            return (
              <div className="ord-ship" key={s.id}>
                <div className="ord-ship-head">
                  <strong>{s.reference || s.origin || 'Shipment'}</strong>
                  <span className={`badge ${s.status === 'received' ? 'ready' : 'card'}`}>{SHIP_STATUS[s.status] || s.status}</span>
                  {late > 0 && <span className="badge new">{late} day{late === 1 ? '' : 's'} late</span>}
                </div>
                <div className="muted small">
                  {s.units} unit{s.units === 1 ? '' : 's'} for this order
                  {s.origin && s.reference ? ` · ${s.origin}` : ''}
                  {s.status === 'received' ? '' : s.eta ? ` · ETA ${fmtDate(s.eta)}` : ' · no arrival date yet'}
                  {s.carrier ? ` · ${s.carrier}` : ''}
                  {s.tracking ? ` · ${s.tracking}` : ''}
                </div>
                <div className="ord-docs">
                  {items.map((d) =>
                    d.driveUrl ? (
                      <a key={d.docType} className={`ord-doc ${d.status}`} href={d.driveUrl} target="_blank" rel="noreferrer">
                        📄 {d.label} · {d.status}
                      </a>
                    ) : (
                      <span key={d.docType} className={`ord-doc ${d.status}`}>
                        {d.label} · {d.status === 'required' ? 'missing' : d.status}
                      </span>
                    )
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      <div className="ord-card">
        <div className="lane-head">History</div>
        {[...o.events].reverse().map((e) => (
          <div className="ord-event" key={e.id}>
            <span className="muted small">{fmtWhen(e.at)}</span>
            <span className="small">
              {eventText(e)}
              {e.reviewedBy ? (e.reviewedBy.startsWith('auto:') ? ' · resolved' : ` · handled by ${e.reviewedBy}`) : ''}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
