import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';

// The order book: every order the app created, with where each unit comes from (Miami stock, a
// named inbound shipment, or not yet sourced) and the money — deposit paid or not, and the
// balance. Payment itself always happens in Shopify. "Prepare balance invoice" shows the figures
// here first; only on confirmation is the deposit credited on the Shopify backorder draft.
const money = (n, currency = 'USD') =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(Number(n) || 0);

const fmtDate = (iso) => {
  if (!iso) return '';
  const d = new Date(iso.length === 10 ? `${iso}T12:00:00` : iso);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
};

const SHIP_STATUS = { ordered: 'Ordered', in_transit: 'In transit', arrived: 'Arrived', receiving: 'Receiving', received: 'Received' };

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

export function OrdersView({ canPrepare, currency = 'USD' }) {
  const [orders, setOrders] = useState(null);
  const [err, setErr] = useState('');
  const [confirming, setConfirming] = useState(null); // order id whose balance is being reviewed
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setOrders((await api.orders()).orders || []);
      setErr('');
    } catch (e) {
      setErr(e?.message || 'Could not load orders');
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  const prepare = async (order) => {
    setBusy(true);
    setErr('');
    try {
      await api.orderBalance(order.id);
      setConfirming(null);
      await load();
    } catch (e) {
      setErr(e?.message || 'Could not prepare the balance invoice');
    } finally {
      setBusy(false);
    }
  };

  if (orders == null && !err) return <div className="center muted">Loading orders…</div>;

  return (
    <div className="orders">
      {err && <div className="err-inline small">{err}</div>}
      {orders?.length === 0 && <div className="center muted">No orders recorded yet.</div>}
      {(orders || []).map((o) => {
        const m = o.money;
        const dep = o.depositDraft;
        return (
          <div className="ord-card" key={o.id}>
            <div className="ord-head">
              <div>
                <div className="ord-name">{o.customer?.name || o.customer?.email || 'No customer'}</div>
                <div className="muted small">
                  {fmtDate(o.createdAt)}
                  {o.repName ? ` · ${o.repName}` : ''}
                  {[o.readyDraft?.name, o.backorderDraft?.name, dep?.name].filter(Boolean).map((n) => ` · ${n}`)}
                </div>
              </div>
              <div className="ord-badges">
                {dep && (
                  <span className={`badge ${dep.status === 'paid' ? 'ready' : 'warn'}`}>
                    {dep.status === 'paid' ? 'Deposit paid' : dep.status === 'awaiting_payment' ? 'Deposit payment pending' : 'Deposit due'}
                  </span>
                )}
                {o.balance && <span className="badge done">Balance invoiced</span>}
              </div>
            </div>

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

            {m && (
              <div className="ord-money">
                <div className="ord-money-row">
                  <span>Backorder total{m.volumeAmount > 0 ? ` (after ${m.volumeDiscountPct}% volume discount)` : ''}</span>
                  <span>{money(m.total, currency)}</span>
                </div>
                {dep && (
                  <div className="ord-money-row">
                    <span>
                      Deposit {dep.pct}% · {dep.name} · {m.depositPaid
                        ? `paid ${fmtDate(dep.paidAt)}${dep.shopifyOrder ? ` · order ${dep.shopifyOrder}` : ''}${dep.verified === false ? ' (payment not verified)' : ''}`
                        : dep.status === 'awaiting_payment'
                          ? `order ${dep.shopifyOrder || ''} created, payment ${String(dep.financialStatus || 'pending').toLowerCase().replace('_', ' ')}`
                          : 'not paid yet'}
                    </span>
                    <span>{m.depositPaid ? `− ${money(m.depositAmount, currency)}` : money(m.depositAmount, currency)}</span>
                  </div>
                )}
                <div className="ord-money-row total">
                  <span>
                    {o.balance
                      ? `Balance invoiced on ${m.backorderDraft}`
                      : dep && !m.depositPaid
                        ? 'Balance after the deposit'
                        : 'Balance to invoice'}
                  </span>
                  <span>{money(o.balance ? o.balance.amount : dep && !m.depositPaid ? m.total - m.depositAmount : m.balance, currency)}</span>
                </div>
                {o.balance?.mismatch && (
                  <div className="err-inline small">
                    Shopify shows {money(o.balance.shopifyTotal, currency)} on {m.backorderDraft}. Check the draft before taking payment.
                  </div>
                )}

                {canPrepare && !o.balance && confirming !== o.id && (
                  <button
                    className="secondary small-btn"
                    disabled={dep && !m.depositPaid}
                    title={dep && !m.depositPaid ? 'Available once the deposit is paid in Shopify' : ''}
                    onClick={() => setConfirming(o.id)}
                  >
                    Prepare balance invoice
                  </button>
                )}
                {canPrepare && !o.balance && dep && !m.depositPaid && (
                  <div className="muted small">Available once deposit {dep.name} is paid in Shopify.</div>
                )}
                {confirming === o.id && (
                  <div className="ord-confirm">
                    <div className="small">
                      This updates draft {m.backorderDraft} in Shopify: the {money(m.credit, currency)} deposit is credited and the
                      draft will charge <strong>{money(m.balance, currency)}</strong>. It then appears in Checkout to collect.
                    </div>
                    <div className="ord-confirm-btns">
                      <button className="primary small" disabled={busy} onClick={() => prepare(o)}>
                        {busy ? 'Updating Shopify…' : `Send ${money(m.balance, currency)} balance to Shopify`}
                      </button>
                      <button className="link" disabled={busy} onClick={() => setConfirming(null)}>
                        Cancel
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
