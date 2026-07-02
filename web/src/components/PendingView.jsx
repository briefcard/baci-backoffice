import React from 'react';

// The shared pool of customer-submitted order forms. Every rep (and the captain) sees all of
// them; each is stamped with the booth/rep that captured it (or QR). Opening one seeds the
// normal cart review — totals, volume discount, deposit, customer attach — then Confirm creates
// the Shopify draft order(s) through the standard pipeline.
export function PendingView({ pending, onOpen, onDismiss }) {
  if (pending == null) return <div className="center muted">Loading pending forms…</div>;

  const open = pending.filter((p) => p.status === 'pending');
  const handled = pending.filter((p) => p.status !== 'pending');

  const when = (iso) => {
    try {
      return new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    } catch {
      return '';
    }
  };
  const who = (p) =>
    [p.customer?.company, p.customer?.contact].filter(Boolean).join(' — ') ||
    p.customer?.email ||
    p.customer?.phone ||
    'No customer info';
  const units = (p) => (p.lines || []).reduce((s, l) => s + (Number(l.quantity) || 0), 0);

  return (
    <div className="pending">
      {open.length === 0 && <div className="center muted">No order forms waiting. 📋</div>}

      {open.map((p) => (
        <div className="pend-row" key={p.id}>
          <div className="pend-main">
            <div className="pend-line1">
              <strong>{who(p)}</strong>
              <span className={`badge ${p.source === 'qr' ? 'card' : 'ready'}`}>
                {p.source === 'qr' ? 'QR' : p.repName || 'Kiosk'}
              </span>
            </div>
            <div className="muted small">
              {when(p.createdAt)} · {(p.lines || []).length} item{(p.lines || []).length !== 1 ? 's' : ''} ·{' '}
              {units(p)} units
              {p.notes ? ` · “${p.notes.slice(0, 60)}${p.notes.length > 60 ? '…' : ''}”` : ''}
            </div>
          </div>
          <div className="pend-actions">
            <button className="link" onClick={() => onDismiss(p)}>
              Dismiss
            </button>
            <button className="primary small" onClick={() => onOpen(p)}>
              Review ▸
            </button>
          </div>
        </div>
      ))}

      {handled.length > 0 && (
        <>
          <div className="checkout-head done-head">
            <strong>Recently handled</strong>
            <span className="muted small">{handled.length}</span>
          </div>
          {handled.map((p) => (
            <div className="pend-row is-done" key={p.id}>
              <div className="pend-main">
                <div className="pend-line1">
                  <strong>{who(p)}</strong>
                  <span className={`badge ${p.status === 'confirmed' ? 'ready' : 'done'}`}>{p.status}</span>
                  {p.result?.ready?.name && <span className="muted small">{p.result.ready.name}</span>}
                  {p.result?.backorder?.name && <span className="muted small">{p.result.backorder.name}</span>}
                </div>
                <div className="muted small">
                  {when(p.createdAt)} · by {p.handledBy || '—'}
                </div>
              </div>
            </div>
          ))}
        </>
      )}
    </div>
  );
}
