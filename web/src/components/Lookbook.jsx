import React from 'react';
import { unitWholesalePrice, money } from '../domain.js';

const BRAND_LOGO = 'https://bacimilanousa.com/cdn/shop/files/Baci_Logo_-_White.png?height=108';

// The customer-facing lookbook a personalized form link opens with: hero imagery per curated
// collection, image-forward product grids at their wholesale pricing, and a single CTA into the
// prefilled order form. Same data as the form — no separate catalog to maintain.
export function Lookbook({ catalog, onStart }) {
  const config = catalog?.config || {};
  const currency = config.currency || 'USD';
  const pct = config.discountPct ?? 50;
  const link = catalog?.link || {};
  const sections = (config.formCollections || [])
    .map((c) => ({
      ...c,
      products: (catalog?.products || []).filter((p) => (p.collections || []).some((x) => x.handle === c.handle)),
    }))
    .filter((s) => s.products.length > 0);

  return (
    <div className="lookbook">
      <header className="lb-hero">
        <img className="pf-logo" src={BRAND_LOGO} alt="Baci Milano" />
        <h1>{link.company ? `Curated for ${link.company}` : 'Curated U.S. Selections'}</h1>
        <p>
          {sections.length} collection{sections.length !== 1 ? 's' : ''} selected for you · wholesale
          pricing shown
        </p>
        {link.note && <p className="lb-note">“{link.note}”</p>}
        <button className="lb-cta" onClick={onStart}>
          Start your order ▸
        </button>
      </header>

      {sections.map((s) => (
        <section className="lb-section" key={s.handle}>
          <div className="lb-banner">
            {s.image ? <img src={s.image} alt="" loading="lazy" /> : null}
            <h2>{s.title}</h2>
          </div>
          <div className="lb-grid">
            {s.products.map((p) => {
              const v = p.variants[0];
              return (
                <figure className="lb-card" key={p.id}>
                  {p.image ? <img src={p.image} alt="" loading="lazy" /> : <div className="lb-ph" />}
                  <figcaption>
                    <span className="lb-title">{p.title}</span>
                    {v && (
                      <span className="lb-price">
                        {money(unitWholesalePrice(v, pct), currency)}{' '}
                        <small>MSRP {money(v.retailPrice, currency)}</small>
                      </span>
                    )}
                  </figcaption>
                </figure>
              );
            })}
          </div>
        </section>
      ))}

      <button className="cartbar lb-bar" onClick={onStart}>
        <span>{link.company || 'Ready when you are'}</span>
        <span>Start your order ▸</span>
      </button>
    </div>
  );
}
