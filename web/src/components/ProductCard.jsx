import React from 'react';
import { StockBadge } from './StockBadge.jsx';
import { unitWholesalePrice, stockState, money } from '../domain.js';

function fmtEta(d) {
  if (!d) return null;
  try {
    return new Date(d + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  } catch {
    return d;
  }
}

export function ProductCard({ product, availability, config, productIndex }) {
  const lowT = config?.lowThreshold ?? 10;
  const pct = config?.discountPct ?? 35;
  const currency = config?.currency || 'USD';

  let anyOut = false;
  const rows = product.variants.map((v) => {
    const avail = availability[v.id] ?? v.available ?? 0;
    const state = stockState(avail, lowT);
    if (state === 'out') anyOut = true;
    const price = unitWholesalePrice(v, pct);
    const eta = fmtEta(v.restockEta);
    return (
      <div className="vrow" key={v.id}>
        <div className="vmain">
          <div className="vtitle">{v.title && v.title !== 'Default Title' ? v.title : product.title}</div>
          <div className="vsku">{v.sku || '—'}</div>
        </div>
        <div className="vprice">
          <div className="b2b">{money(price, currency)}</div>
          <div className="msrp">MSRP {money(v.retailPrice, currency)}</div>
        </div>
        <div className="vstock">
          <StockBadge state={state} available={avail} />
          {state !== 'in' && (
            <div className="oos">
              {eta ? <span className="eta">Back ~{eta}</span> : null}
              <span className="backorder">Backorder ▸</span>
            </div>
          )}
        </div>
      </div>
    );
  });

  const subs =
    anyOut && product.substitutes?.length
      ? product.substitutes
          .map((id) => productIndex.get(id))
          .filter(Boolean)
          .slice(0, 4)
      : [];

  return (
    <div className="card">
      <div className="chead">
        {product.image ? <img src={product.image} alt="" className="cimg" loading="lazy" /> : <div className="cimg ph" />}
        <div>
          <div className="ctitle">{product.title}</div>
          {product.productType ? <div className="ctype">{product.productType}</div> : null}
        </div>
      </div>
      <div className="vrows">{rows}</div>
      {subs.length > 0 && (
        <div className="subs">
          <span className="subs-label">Sell instead:</span>
          {subs.map((p) => (
            <span className="chip" key={p.id}>
              {p.title}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
