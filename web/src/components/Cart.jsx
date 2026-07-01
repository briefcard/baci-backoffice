import React, { useState } from 'react';
import { cart, useCart, cartSubtotal } from '../cart.js';
import { money, maxAdditionalPct } from '../domain.js';
import { api } from '../api.js';

export function Cart({ config, onClose }) {
  const items = useCart();
  const currency = config?.currency || 'USD';
  const tiers = config?.tiers || [];
  const subtotal = cartSubtotal(items);
  const cap = maxAdditionalPct(subtotal, tiers);

  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [notes, setNotes] = useState('');
  const [disc, setDisc] = useState(0);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [done, setDone] = useState(null);

  const applied = Math.min(Math.max(Number(disc) || 0, 0), cap);
  const total = subtotal * (1 - applied / 100);

  const submit = async () => {
    setErr('');
    setBusy(true);
    try {
      const res = await api.createOrder({
        lines: items.map((i) => ({ variantId: i.variantId, quantity: i.qty })),
        customer: { name, email, phone },
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
            <h2>Draft order {done.name} created</h2>
            {done.invoiceUrl && (
              <a className="link" href={done.invoiceUrl} target="_blank" rel="noreferrer">
                Open in Shopify ▸
              </a>
            )}
            <button className="primary" onClick={onClose}>
              Done
            </button>
          </div>
        </div>
      </div>
    );
  }

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

          {items.map((i) => (
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
          ))}

          {items.length > 0 && (
            <>
              <div className="crow">
                <span>Subtotal</span>
                <strong>{money(subtotal, currency)}</strong>
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
              {applied > 0 && (
                <div className="crow">
                  <span>Total</span>
                  <strong>{money(total, currency)}</strong>
                </div>
              )}

              <div className="cfields">
                <input placeholder="Customer / company name" value={name} onChange={(e) => setName(e.target.value)} />
                <input type="email" placeholder="Customer email" value={email} onChange={(e) => setEmail(e.target.value)} />
                <input placeholder="Phone (optional)" value={phone} onChange={(e) => setPhone(e.target.value)} />
                <textarea placeholder="Notes for this order" value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} />
              </div>

              {err && <div className="err">{err}</div>}
              <button className="primary" disabled={busy} onClick={submit}>
                {busy ? 'Creating…' : `Create draft order · ${money(total, currency)}`}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
