import React, { useMemo, useState } from 'react';
import { cart, useCart } from '../cart.js';
import { money, maxAdditionalPct, round2 } from '../domain.js';
import { api } from '../api.js';
import { CustomerPicker } from './CustomerPicker.jsx';

// Split each cart line by live stock into a "ready now" qty and a "backorder" (shortfall) qty —
// mirrors the server's split so the rep sees, before submitting, what ships today vs later.
function splitItems(items, availability) {
  const ready = [];
  const backorder = [];
  for (const i of items) {
    const avail = Math.max(0, Math.floor(Number(availability?.[i.variantId] ?? 0)));
    const readyQty = Math.min(avail, i.qty);
    const backorderQty = i.qty - readyQty;
    if (readyQty > 0) ready.push({ ...i, qty: readyQty });
    if (backorderQty > 0) backorder.push({ ...i, qty: backorderQty });
  }
  return { ready, backorder };
}

const sum = (its) => its.reduce((s, i) => s + i.unit * i.qty, 0);

export function Cart({ config, availability, onClose }) {
  const items = useCart();
  const currency = config?.currency || 'USD';
  const tiers = config?.tiers || [];
  const depositTiers = config?.depositPct || { new_customer: 40, repeat_customer: 30 };

  const { ready, backorder } = useMemo(() => splitItems(items, availability), [items, availability]);
  const readySubtotal = round2(sum(ready));
  const backorderSubtotal = round2(sum(backorder));
  const combinedSubtotal = round2(readySubtotal + backorderSubtotal);
  const cap = maxAdditionalPct(combinedSubtotal, tiers);

  const [customer, setCustomer] = useState(null);
  const [notes, setNotes] = useState('');
  const [disc, setDisc] = useState(0);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [done, setDone] = useState(null);

  const applied = Math.min(Math.max(Number(disc) || 0, 0), cap);
  const readyTotal = readySubtotal * (1 - applied / 100);
  const backorderAfterVolume = backorderSubtotal * (1 - applied / 100);
  // Default the preview to the new-customer (higher) tier until a customer is picked, since
  // that's what the server will actually charge if the order is submitted with no customer set.
  const depositPct = customer?.isB2B ? depositTiers.repeat_customer : depositTiers.new_customer;
  const depositAmount = round2(backorderAfterVolume * (depositPct / 100));
  const balanceAmount = round2(backorderAfterVolume - depositAmount);
  const grandTotal = readyTotal + backorderAfterVolume;

  const submit = async () => {
    setErr('');
    setBusy(true);
    try {
      const res = await api.createOrder({
        lines: items.map((i) => ({ variantId: i.variantId, quantity: i.qty })),
        customer: customer ? { id: customer.id || undefined, name: customer.name, email: customer.email, phone: customer.phone } : {},
        notes,
        repDiscountPct: applied,
      });
      setDone(res);
      cart.clear();
    } catch (e) {
      setErr(e?.message || 'Could not create the order');
      setBusy(false);
    }
  };

  if (done) {
    return (
      <div className="cart-overlay">
        <div className="cart">
          <div className="cart-done">
            <div className="big-check">✓</div>
            {done.ready && (
              <div className="done-order">
                <h2>Draft order {done.ready.name} created</h2>
                <div className="muted small">Ready to ship</div>
                {done.ready.invoiceUrl && (
                  <a className="link" href={done.ready.invoiceUrl} target="_blank" rel="noreferrer">
                    Open in Shopify ▸
                  </a>
                )}
              </div>
            )}
            {done.backorder && (
              <div className="done-order">
                <h2>Draft order {done.backorder.name} created</h2>
                <div className="muted small">
                  Backorder · {done.backorder.customerTier} · deposit {done.backorder.depositPct}% (
                  {money(done.backorder.depositAmount, currency)}) due now, balance{' '}
                  {money(done.backorder.balanceAmount, currency)} due at fulfillment
                </div>
                {done.backorder.invoiceUrl && (
                  <a className="link" href={done.backorder.invoiceUrl} target="_blank" rel="noreferrer">
                    Open in Shopify ▸
                  </a>
                )}
              </div>
            )}
            <button className="primary" onClick={onClose}>
              Done
            </button>
          </div>
        </div>
      </div>
    );
  }

  const renderLines = (its) =>
    its.map((i) => (
      <div className="citem" key={i.variantId}>
        {i.image ? <img src={i.image} alt="" /> : <div className="ph" />}
        <div className="cinfo">
          <div className="ct">{i.title}</div>
          <div className="cs">
            {i.sku} · {money(i.unit, currency)} ea
          </div>
        </div>
        <div className="qty">
          <button onClick={() => cart.setQty(i.variantId, i.qty - 1)}>−</button>
          <span className="qn">{i.qty}</span>
          <button onClick={() => cart.setQty(i.variantId, i.qty + 1)}>+</button>
        </div>
        <div className="clt">{money(i.unit * i.qty, currency)}</div>
      </div>
    ));

  return (
    <div className="cart-overlay" onClick={onClose}>
      <div className="cart" onClick={(e) => e.stopPropagation()}>
        <div className="cart-head">
          <strong>Order</strong>
          <button className="x" onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="cart-body">
          {items.length === 0 && <div className="muted center">No items yet.</div>}

          {ready.length > 0 && (
            <>
              <div className="order-section-head">Ready to ship</div>
              {renderLines(ready)}
            </>
          )}

          {backorder.length > 0 && (
            <>
              <div className="order-section-head warn">Backorder — deposit required</div>
              {renderLines(backorder)}
            </>
          )}

          {items.length > 0 && (
            <>
              <div className="crow">
                <span>Subtotal</span>
                <strong>{money(combinedSubtotal, currency)}</strong>
              </div>
              {cap > 0 && (
                <div className="crow disc">
                  <span>
                    Volume discount <small>(up to {cap}%)</small>
                  </span>
                  <span>
                    <input
                      type="number"
                      min="0"
                      max={cap}
                      value={disc}
                      onChange={(e) => setDisc(e.target.value)}
                    />{' '}
                    %
                  </span>
                </div>
              )}

              {backorder.length > 0 && (
                <div className="deposit-preview">
                  <div className="crow">
                    <span>
                      Deposit due now{' '}
                      <small>({depositPct}% · {customer?.isB2B ? 'repeat/B2B' : 'new customer'})</small>
                    </span>
                    <strong>{money(depositAmount, currency)}</strong>
                  </div>
                  <div className="crow muted small">
                    <span>Balance due at fulfillment</span>
                    <span>{money(balanceAmount, currency)}</span>
                  </div>
                  {!customer && (
                    <div className="muted small">Pick a customer below — an existing B2B account may lower this.</div>
                  )}
                </div>
              )}

              {applied > 0 && (
                <div className="crow">
                  <span>Total</span>
                  <strong>{money(grandTotal, currency)}</strong>
                </div>
              )}

              <div className="cfields">
                <CustomerPicker value={customer} onChange={setCustomer} />
                <textarea placeholder="Notes for this order" value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} />
              </div>

              {err && <div className="err">{err}</div>}
              <button className="primary" disabled={busy} onClick={submit}>
                {busy ? 'Creating…' : `Create order${backorder.length ? 's' : ''} · ${money(grandTotal, currency)}`}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
