import React from 'react';
import { unitWholesalePrice, stockState, stateRank, money } from '../domain.js';
import { cart, useCart } from '../cart.js';

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
  const cartItems = useCart();

  // Out-of-stock variants sink to the bottom of the card.
  const variants = [...product.variants].sort(
    (a, b) =>
      stateRank(availability[a.id] ?? a.available ?? 0, lowT) -
      stateRank(availability[b.id] ?? b.available ?? 0, lowT)
  );

  let anyOut = false;
  const rows = variants.map((v) => {
    const avail = availability[v.id] ?? v.available ?? 0;
    const state = stockState(avail, lowT);
    if (state === 'out') anyOut = true;
    const price = unitWholesalePrice(v, pct);
    const eta = fmtEta(v.restockEta);
    const incoming = v.incoming ?? 0;
    return (
      <div className={`vrow ${state === 'out' ? 'isout' : ''}`} key={v.id}>
        <div className="vmain">
          <div className="vtitle">{v.title && v.title !== 'Default Title' ? v.title : product.title}</div>
          <div className="vsku">{v.sku || '—'}</div>
          {state !== 'in' && (
            <div className="oos">
              {incoming > 0 ? (
                <span className="backorder">BackOrder{eta ? ` · ${eta}` : ''}</span>
              ) : eta ? (
                <span className="eta">Restock ~{eta}</span>
              ) : (
                state === 'out' && <span className="eta">Ships in ~{config?.leadTime || '6–10 weeks'}</span>
              )}
            </div>
          )}
        </div>
        <div className="vprice">
          <span className="b2b">{money(price, currency)}</span>
          <span className="msrp">{money(v.retailPrice, currency)}</span>
        </div>
        <div className={`stocknum ${state}`}>
          <span className="num">{Math.max(avail, 0)}</span>
          <span className="lbl">{state === 'out' ? 'out' : 'in stock'}</span>
          {incoming > 0 && <span className="incoming">+{incoming} incoming</span>}
        </div>
        <AddControl variant={v} product={product} unit={price} inCart={cartItems.find((i) => i.variantId === v.id)} />
      </div>
    );
  });

  const subs =
    anyOut && product.substitutes?.length
      ? product.substitutes.map((id) => productIndex.get(id)).filter(Boolean).slice(0, 4)
      : [];

  return (
    <div className="card">
      <div className="chead">
        {product.image ? (
          <img src={product.image} alt="" className="cimg" loading="lazy" />
        ) : (
          <div className="cimg ph" />
        )}
        <div className="cmeta">
          <div className="ctitle">{product.title}</div>
          <div className="ctags">
            {product.productType ? <span>{product.productType}</span> : null}
            {(product.materials || []).slice(0, 2).map((m) => (
              <span key={m}>{m}</span>
            ))}
          </div>
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

function AddControl({ variant, product, unit, inCart }) {
  if (!inCart) {
    return (
      <button
        className="add-btn"
        onClick={() =>
          cart.add({
            variantId: variant.id,
            productId: product.id,
            title: product.title,
            sku: variant.sku,
            image: product.image,
            unit,
            msrp: variant.retailPrice,
            origin: product.countryOfOrigin,
          })
        }
      >
        + Add to order
      </button>
    );
  }
  return (
    <div className="qty">
      <button onClick={() => cart.setQty(variant.id, inCart.qty - 1)} aria-label="decrease">−</button>
      <span className="qn">{inCart.qty}</span>
      <button onClick={() => cart.setQty(variant.id, inCart.qty + 1)} aria-label="increase">+</button>
    </div>
  );
}
