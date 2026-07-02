import React, { useEffect } from 'react';
import { unitWholesalePrice, money } from '../domain.js';
import { buildFormSections } from '../formSections.js';

// The printable twin of the digital order form — same live catalog, same section order as the
// paper catalogue, current Shopify pricing, blank qty boxes. Print it the morning of a show and
// it's automatically up to date (only items in Shopify, new products in their collections).
export function PrintOrderForm({ snapshot, config, onDone }) {
  const currency = config?.currency || 'USD';
  const pct = config?.discountPct ?? 50;
  const sections = buildFormSections(snapshot?.products || [], config?.formCollections || []);

  useEffect(() => {
    const after = () => onDone?.();
    window.addEventListener('afterprint', after);
    const t = setTimeout(() => window.print(), 900); // give images a beat to load
    return () => {
      window.removeEventListener('afterprint', after);
      clearTimeout(t);
    };
  }, [onDone]);

  const today = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });

  return (
    <div className="print-form">
      <div className="pf-cover">
        <div className="pf-brand">
          <h1>BACI MILANO</h1>
          <div className="pf-sub">CURATED U.S. SELECTIONS · ORDER FORM</div>
          <div className="pf-co">
            Baci Milano USA, LLC · 1835 E Hallandale Beach Blvd STE 834, Hallandale Beach, FL 33009
            <br />
            305.600.0099 · info@bacimilanousa.com · www.bacimilanousa.com
          </div>
          <div className="pf-date">Printed {today} — prices current as of print date</div>
        </div>
        <div className="pf-fields">
          {['COMPANY NAME', 'CONTACT', 'ADDRESS', 'CITY / STATE / ZIP', 'PHONE', 'E-MAIL', 'SALES REP', 'DELIVERY DATE', 'NOTES'].map(
            (label) => (
              <div className="pf-field" key={label}>
                <span>{label}</span>
                <span className="pf-line" />
              </div>
            )
          )}
        </div>
      </div>

      {sections.map((s) => (
        <section className="pf-section" key={s.handle}>
          <div className="pf-section-head">
            <h2>{s.title}</h2>
            <span>CATALOGUE: {s.title.toUpperCase()}</span>
          </div>
          <table>
            <thead>
              <tr>
                <th className="pf-th-img" />
                <th>Item</th>
                <th className="pf-th-sku">SKU</th>
                <th className="pf-th-price">Unit</th>
                <th className="pf-th-qty">Qty</th>
              </tr>
            </thead>
            <tbody>
              {s.products.map((p) =>
                p.variants.map((v, i) => (
                  <tr key={v.id}>
                    <td className="pf-td-img">
                      {i === 0 && p.image ? <img src={p.image} alt="" /> : null}
                    </td>
                    <td>
                      <div className="pf-item">
                        {p.title}
                        {v.title && v.title !== 'Default Title' ? ` — ${v.title}` : ''}
                      </div>
                      <div className="pf-type">
                        {[p.productType, (p.materials || [])[0]].filter(Boolean).join(' · ')}
                      </div>
                    </td>
                    <td className="pf-td-sku">{v.sku || '—'}</td>
                    <td className="pf-td-price">{money(unitWholesalePrice(v, pct), currency)}</td>
                    <td className="pf-td-qty">
                      <span className="pf-qtybox" />
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </section>
      ))}

      <div className="pf-foot">
        Wholesale order form — pricing per unit. Totals, availability, and volume pricing are
        confirmed by your Baci Milano sales rep.
      </div>
    </div>
  );
}
