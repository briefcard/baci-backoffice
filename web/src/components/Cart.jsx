import React, { useMemo, useState } from 'react';
import { cart, useCart } from '../cart.js';
import { money, maxAdditionalPct, round2, splitByAvailability } from '../domain.js';
import { api } from '../api.js';
import { CustomerPicker } from './CustomerPicker.jsx';
import { PrintDoc, OrderCopyDoc } from './PrintDocs.jsx';

const sum = (its) => its.reduce((s, i) => s + i.unit * i.qty, 0);

// Also used to review a customer-submitted order form: `pendingId` switches the submit to the
// pending-confirm endpoint (which closes out the pool entry), with the buyer's info prefilled.
export function Cart({ config, availability, onClose, onFinished, onDiscard, pendingId, initialCustomer, initialNotes }) {
  const items = useCart();
  const currency = config?.currency || 'USD';
  const tiers = config?.tiers || [];
  const depositTiers = config?.depositPct || { new_customer: 40, repeat_customer: 30 };

  const { ready, backorder } = useMemo(() => splitByAvailability(items, availability), [items, availability]);
  const readySubtotal = round2(sum(ready));
  const backorderSubtotal = round2(sum(backorder));
  const combinedSubtotal = round2(readySubtotal + backorderSubtotal);
  const cap = maxAdditionalPct(combinedSubtotal, tiers);

  const [customer, setCustomer] = useState(initialCustomer || null);
  const [notes, setNotes] = useState(initialNotes || '');
  const [disc, setDisc] = useState(0);
  const [cardOnFile, setCardOnFile] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [done, setDone] = useState(null);
  const [doneCtx, setDoneCtx] = useState(null); // snapshot of the order for the printable copy
  const [showPrint, setShowPrint] = useState(false);
  const [showQuote, setShowQuote] = useState(false); // pre-confirm quote PDF (client adjustments)

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
      const payload = {
        lines: items.map((i) => ({ variantId: i.variantId, quantity: i.qty })),
        customer: customer ? { id: customer.id || undefined, name: customer.name, email: customer.email, phone: customer.phone } : {},
        notes,
        repDiscountPct: applied,
        cardOnFile,
      };
      const res = pendingId ? await api.confirmPending(pendingId, payload) : await api.createOrder(payload);
      // Snapshot everything the printable client copy needs BEFORE the cart is cleared.
      setDoneCtx({
        lines: { ready, backorder },
        customer: customer ? { name: customer.name, email: customer.email, phone: customer.phone } : null,
        notes,
        appliedPct: applied,
        result: res,
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
            {doneCtx && (
              <button className="secondary" onClick={() => setShowPrint(true)}>
                🖨 Print / save PDF for customer
              </button>
            )}
            <button className="primary" onClick={onFinished || onClose}>
              Done
            </button>
          </div>
        </div>
        {showPrint && doneCtx && (
          <PrintDoc title="Order copy" onClose={() => setShowPrint(false)}>
            <OrderCopyDoc order={doneCtx} currency={currency} leadTime={config?.leadTime} depositPctHint={depositPct} />
          </PrintDoc>
        )}
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
          <strong>{pendingId ? 'Review order form' : 'Order'}</strong>
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
                <CustomerPicker value={customer} onChange={setCustomer} mainCollections={config?.mainCollections || []} />
                <label className="cust-check">
                  <input type="checkbox" checked={cardOnFile} onChange={(e) => setCardOnFile(e.target.checked)} />
                  Card on file — save the card at the register (POS)
                </label>
                <textarea placeholder="Notes for this order" value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} />
              </div>

              {err && <div className="err">{err}</div>}
              <button className="primary" disabled={busy} onClick={submit}>
                {busy ? 'Creating…' : `Create order${backorder.length ? 's' : ''} · ${money(grandTotal, currency)}`}
              </button>
              {/* Client-quote round-trips: export the branded quote BEFORE confirming, so the
                  rep can send it, take adjustments (close drawer, add items, reopen), re-send. */}
              <button className="secondary" onClick={() => setShowQuote(true)}>
                🖨 Quote PDF for customer
              </button>
              {pendingId && onDiscard && (
                <button className="link discard-link" onClick={onDiscard}>
                  Discard this review (keeps the pending form)
                </button>
              )}
            </>
          )}
        </div>
        {showQuote && (
          <PrintDoc title="Customer quote" onClose={() => setShowQuote(false)}>
            <OrderCopyDoc
              order={{
                lines: { ready, backorder },
                customer: customer ? { name: customer.name, email: customer.email, phone: customer.phone } : null,
                notes,
                appliedPct: applied,
                result: null,
              }}
              currency={currency}
              leadTime={config?.leadTime}
              depositPctHint={depositPct}
            />
          </PrintDoc>
        )}
      </div>
    </div>
  );
}
