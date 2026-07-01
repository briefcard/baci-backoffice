import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { money } from '../domain.js';

// The checkout captain's home base: a live list of orders reps captured in this app, each row
// showing who it's for, whether it ships now or is a deposit-backorder, and the exact amount to
// collect right now — with a one-tap deep link into the Shopify draft to take payment at POS.
export function CheckoutView({ config }) {
  const currency = config?.currency || 'USD';
  const [queue, setQueue] = useState(null);
  const [err, setErr] = useState('');
  const [refreshedAt, setRefreshedAt] = useState(null);

  const load = useCallback(async () => {
    try {
      const res = await api.checkoutQueue();
      setQueue(res.queue || []);
      setErr('');
      setRefreshedAt(Date.now());
    } catch (e) {
      setErr(e?.message || 'Could not load the checkout queue');
    }
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(load, 20000); // keep it fresh while the captain works the register
    return () => clearInterval(id);
  }, [load]);

  if (queue == null && !err) return <div className="center muted">Loading checkout queue…</div>;

  const open = (queue || []).filter((d) => !d.completed);
  const completed = (queue || []).filter((d) => d.completed);
  const dueTotal = open.reduce((s, d) => s + (Number(d.dueNow) || 0), 0);

  const refreshedText = refreshedAt
    ? new Date(refreshedAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
    : '—';

  return (
    <div className="checkout">
      <div className="checkout-head">
        <div>
          <strong>To collect</strong>{' '}
          <span className="muted small">
            {open.length} order{open.length !== 1 ? 's' : ''} · {money(dueTotal, currency)} due now
          </span>
        </div>
        <button className="link" onClick={load}>
          Refresh · {refreshedText}
        </button>
      </div>

      {err && <div className="err">{err}</div>}

      {open.length === 0 && !err && <div className="center muted">Nothing waiting to collect. 🎉</div>}

      {open.map((d) => (
        <CheckoutRow key={d.id} d={d} currency={currency} />
      ))}

      {completed.length > 0 && (
        <>
          <div className="checkout-head done-head">
            <strong>Completed</strong>
            <span className="muted small">{completed.length}</span>
          </div>
          {completed.map((d) => (
            <CheckoutRow key={d.id} d={d} currency={currency} completed />
          ))}
        </>
      )}
    </div>
  );
}

function CheckoutRow({ d, currency, completed }) {
  const isBackorder = d.type === 'backorder';
  return (
    <div className={`co-row ${completed ? 'is-done' : ''}`}>
      <div className="co-main">
        <div className="co-line1">
          <span className="co-name">{d.name}</span>
          <span className={`badge ${isBackorder ? 'warn' : 'ready'}`}>
            {isBackorder ? 'Deposit' : d.type === 'ready' ? 'Ready' : 'Order'}
          </span>
          {completed && <span className="badge done">Paid</span>}
        </div>
        <div className="co-line2 muted small">
          {d.customer || 'No customer'}
          {d.rep ? ` · ${d.rep}` : ''}
          {isBackorder && d.customerTier ? ` · ${d.customerTier}` : ''}
        </div>
        {isBackorder && (
          <div className="co-line3 small">
            Deposit {d.depositPct != null ? `${d.depositPct}% ` : ''}
            <strong>{money(d.depositAmount ?? d.dueNow, currency)}</strong> now · balance{' '}
            {money(d.balanceAmount, currency)} at fulfillment
          </div>
        )}
      </div>
      <div className="co-right">
        <div className="co-due">
          <span className="co-due-lbl">{completed ? 'Total' : 'Collect now'}</span>
          <span className="co-due-amt">{money(d.dueNow, currency)}</span>
        </div>
        {!completed && (
          <a className="primary small pay-btn" href={d.adminUrl} target="_blank" rel="noreferrer">
            Take payment ▸
          </a>
        )}
      </div>
    </div>
  );
}
