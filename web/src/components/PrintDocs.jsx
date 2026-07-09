import React, { useState } from 'react';
import { createPortal } from 'react-dom';
import { unitWholesalePrice, money, round2 } from '../domain.js';
import { buildFormSections } from '../formSections.js';

// Printable documents, rendered as a full-screen PREVIEW overlay (portaled to <body>, outside
// the app shell) with an explicit Print / Save-as-PDF button. What you see in the preview is
// exactly what prints: in print media the app root is hidden and only this document renders.
// This replaces the old auto-window.print() approach, which fought the PWA's mobile layout.
//
// Two documents share the wrapper:
//   BlankFormDoc — the empty order form: cover page with fill-in blanks (like the paper form's
//                  page 1) + the full catalog with MSRP, wholesale unit price, and empty qty boxes.
//   OrderCopyDoc — a client-shareable copy of a drafted order (lines, totals, deposit terms).

export function PrintDoc({ title, children, onClose }) {
  return createPortal(
    <div className="printdoc">
      <div className="printdoc-toolbar">
        <strong>{title}</strong>
        <span>
          <button className="primary small" onClick={() => window.print()}>
            🖨 Print / Save as PDF
          </button>
          <button className="pd-close" onClick={onClose}>
            ✕ Close
          </button>
        </span>
      </div>
      <div className="printdoc-pages">{children}</div>
    </div>,
    document.body
  );
}

// Brand assets from bacimilanousa.com: white logo on the site's electric-blue theme color.
const BRAND_LOGO = 'https://bacimilanousa.com/cdn/shop/files/Baci_Logo_-_White.png?height=108';

function DocHeader({ subtitle }) {
  return (
    <div className="pf-brand">
      <div className="pf-band">
        <img className="pf-logo" src={BRAND_LOGO} alt="Baci Milano" />
        <div className="pf-band-sub">{subtitle}</div>
      </div>
      <div className="pf-co">
        Baci Milano USA, LLC · 1835 E Hallandale Beach Blvd STE 834, Hallandale Beach, FL 33009
        <br />
        305.600.0099 · info@bacimilanousa.com · www.bacimilanousa.com
      </div>
    </div>
  );
}

// ---- The empty order form (cover page + catalog with blank qty boxes) ----

// Cover-page blanks mirroring the paper form's first page (company / delivery / terms blocks).
const COVER_COMPANY = ['COMPANY NAME', 'ADDRESS', 'CITY', 'STATE / ZIP', 'PHONE', 'E-MAIL', 'BUYER NAME'];
const COVER_DELIVERY = ['DELIVERY ADDRESS', 'CITY', 'STATE / ZIP', 'PHONE'];
const COVER_TERMS = ['DELIVERY DATE', 'PAYMENT', 'SALES REP', 'NOTE', ''];

function CoverBlock({ heading, labels }) {
  return (
    <div className="pf-block">
      <div className="pf-block-head">{heading}</div>
      {labels.map((label, i) => (
        <div className="pf-field" key={`${label}-${i}`}>
          <span>{label}</span>
          <span className="pf-line" />
        </div>
      ))}
    </div>
  );
}

export function BlankFormDoc({ snapshot, config }) {
  const currency = config?.currency || 'USD';
  const pct = config?.discountPct ?? 50;
  const sections = buildFormSections(snapshot?.products || [], config?.formCollections || []);
  const today = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });

  return (
    <>
      <div className="pf-cover">
        <DocHeader subtitle="CURATED U.S. SELECTIONS · ORDER FORM" />
        <div className="pf-date">Printed {today} — wholesale pricing current as of print date</div>
        <CoverBlock heading="CUSTOMER" labels={COVER_COMPANY} />
        <CoverBlock heading="DELIVERY (if different)" labels={COVER_DELIVERY} />
        <CoverBlock heading="ORDER" labels={COVER_TERMS} />
      </div>

      {sections.map((s) => (
        <section className="pf-section" key={s.handle}>
          <div className="pf-section-head">
            <h2>{s.title}</h2>
            <span>CATALOGUE: {s.title.toUpperCase()}</span>
          </div>
          {s.groups.map((g) => (
            <div key={g.type}>
              <div className="pf-group-head">{g.type}</div>
              <table>
                <thead>
                  <tr>
                    <th className="pf-th-img" />
                    <th>Item</th>
                    <th className="pf-th-sku">SKU</th>
                    <th className="pf-th-price">MSRP</th>
                    <th className="pf-th-price">Wholesale</th>
                    <th className="pf-th-qty">Qty</th>
                  </tr>
                </thead>
                <tbody>
                  {g.products.map((p) =>
                    p.variants.map((v, i) => (
                      <tr key={v.id}>
                        <td className="pf-td-img">{i === 0 && p.image ? <img src={p.image} alt="" /> : null}</td>
                        <td>
                          <div className="pf-item">
                            {p.title}
                            {v.title && v.title !== 'Default Title' ? ` — ${v.title}` : ''}
                          </div>
                          <div className="pf-type">{(p.materials || [])[0] || ''}</div>
                        </td>
                        <td className="pf-td-sku">{v.sku || '—'}</td>
                        <td className="pf-td-price pf-msrp">{money(v.retailPrice, currency)}</td>
                        <td className="pf-td-price">{money(unitWholesalePrice(v, pct), currency)}</td>
                        <td className="pf-td-qty">
                          <span className="pf-qtybox" />
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          ))}
        </section>
      ))}

      <div className="pf-foot">
        Wholesale order form — pricing per unit. Totals, availability, and volume pricing are
        confirmed by your Baci Milano sales rep.
      </div>
    </>
  );
}

// ---- Supplier-facing order form / RFQ (from an inbound shipment draft) ----
// Baci Milano USA is the BUYER here: SKU, item, photo, quantity, and a blank unit-cost column
// for the supplier to quote. Print → Save as PDF → email to Turkey/Italy.
export function RFQDoc({ reference, origin, notes, lines, skuIndex }) {
  const today = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  const rows = (lines || []).filter((l) => (l.expected || 0) > 0);
  const total = rows.reduce((n, l) => n + l.expected, 0);
  return (
    <>
      <div className="pf-copyhead">
        <DocHeader subtitle="PURCHASE ORDER — REQUEST FOR QUOTE" />
        <div className="pf-meta">
          <div>{today}</div>
          {reference && <div>Our reference: {reference}</div>}
          {origin && <div>To: {origin}</div>}
        </div>
      </div>

      <section className="pf-section">
        <table>
          <thead>
            <tr>
              <th className="pf-th-img" />
              <th>Item</th>
              <th className="pf-th-sku">SKU</th>
              <th className="pf-th-qty">Qty</th>
              <th className="pf-th-price">Unit cost*</th>
              <th className="pf-th-price">Total*</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((l) => {
              const p = skuIndex?.get((l.sku || '').toLowerCase())?.product;
              return (
                <tr key={l.id || l.sku}>
                  <td className="pf-td-img">{p?.image ? <img src={p.image} alt="" /> : null}</td>
                  <td>
                    <div className="pf-item">{l.title || p?.title || ''}</div>
                  </td>
                  <td className="pf-td-sku">{l.sku}</td>
                  <td className="pf-td-qty pf-qty-num">{l.expected}</td>
                  <td className="pf-td-price"><span className="pf-fillline">$</span></td>
                  <td className="pf-td-price"><span className="pf-fillline">$</span></td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <div className="pf-meta" style={{ marginTop: 8 }}>
          <div>Total units requested: {total} across {rows.length} item{rows.length !== 1 ? 's' : ''}</div>
        </div>
      </section>

      {notes && (
        <div className="pf-notes">
          <div className="pf-block-head">NOTES</div>
          <div>{notes}</div>
        </div>
      )}

      <div className="pf-terms">
        <div className="pf-block-head">TERMS &amp; CONDITIONS</div>
        <ul>
          <li>* Unit cost and total columns are to be completed by the supplier — please quote in EUR or USD, stating currency and incoterms (e.g. FOB port).</li>
          <li>Please confirm unit pricing, availability, packing (units per carton), and the earliest ship date / ETA for the quantities above.</li>
          <li>Quantities are requested amounts and become binding only upon our written purchase-order confirmation.</li>
          <li>Please reply referencing our RFQ number above.</li>
        </ul>
      </div>

      <div className="pf-foot">
        Baci Milano USA, LLC · GS@BaciMilanoUSA.com · 305.600.0099 · 1835 E Hallandale Beach Blvd STE 834, Hallandale Beach, FL 33009
      </div>
    </>
  );
}

// ---- A client-shareable copy of a drafted order ----
// `order` = { lines: { ready, backorder }, customer, notes, appliedPct, result }
//   result (when submitted) = createOrders response: { ready: {name…}, backorder: {name, depositPct,
//   depositAmount, balanceAmount, customerTier…} } — server-authoritative deposit figures win.

function LinesTable({ lines, currency, showOrigin }) {
  return (
    <table>
      <thead>
        <tr>
          <th className="pf-th-img" />
          <th>Item</th>
          <th className="pf-th-sku">SKU</th>
          <th className="pf-th-qty">Qty</th>
          <th className="pf-th-price">MSRP</th>
          <th className="pf-th-price">Unit</th>
          <th className="pf-th-price">Total</th>
        </tr>
      </thead>
      <tbody>
        {lines.map((l) => (
          <tr key={l.variantId}>
            <td className="pf-td-img">{l.image ? <img src={l.image} alt="" /> : null}</td>
            <td>
              <div className="pf-item">{l.title}</div>
              {showOrigin && l.origin && <div className="pf-type">Made in {l.origin}</div>}
            </td>
            <td className="pf-td-sku">{l.sku || '—'}</td>
            <td className="pf-td-qty pf-qty-num">{l.qty}</td>
            <td className="pf-td-price pf-msrp">{l.msrp != null ? money(l.msrp, currency) : '—'}</td>
            <td className="pf-td-price">{money(l.unit, currency)}</td>
            <td className="pf-td-price">{money(round2(l.unit * l.qty), currency)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function OrderCopyDoc({ order, currency = 'USD', leadTime = '6–10 weeks', depositPctHint = null }) {
  // Country of origin on the invoice — available when needed, OFF by default.
  const [showOrigin, setShowOrigin] = useState(false);
  const { lines, customer, notes, appliedPct = 0, result } = order;
  const ready = lines?.ready || [];
  const backorder = lines?.backorder || [];
  const sum = (its) => round2(its.reduce((s, i) => s + i.unit * i.qty, 0));
  const readySub = sum(ready);
  const backSub = sum(backorder);
  const subtotal = round2(readySub + backSub);
  const afterVolume = round2(subtotal * (1 - appliedPct / 100));
  const backAfterVolume = round2(backSub * (1 - appliedPct / 100));
  const depositPct = result?.backorder?.depositPct ?? depositPctHint;
  const depositAmount = result?.backorder?.depositAmount ?? (depositPct != null ? round2(backAfterVolume * (depositPct / 100)) : null);
  const balanceAmount = result?.backorder?.balanceAmount ?? (depositAmount != null ? round2(backAfterVolume - depositAmount) : null);
  const readyAfterVolume = round2(readySub * (1 - appliedPct / 100));
  // What the client pays NOW: everything shipping today + the deposit securing the backorder.
  const dueToday = depositAmount != null ? round2(readyAfterVolume + depositAmount) : null;
  const today = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  const submitted = !!(result?.ready || result?.backorder);

  return (
    <>
      <div className="pf-copyhead">
        <DocHeader subtitle={submitted ? 'WHOLESALE ORDER SUMMARY' : 'WHOLESALE ORDER — DRAFT'} />
        <div className="pf-meta">
          <div>{today}</div>
          {result?.ready?.name && <div>Order ref: {result.ready.name} (ready to ship)</div>}
          {result?.backorder?.name && <div>Order ref: {result.backorder.name} (backorder)</div>}
          {!submitted && <div className="pf-draft-note">Pending confirmation — not yet an order</div>}
        </div>
        {(customer?.name || customer?.email || customer?.phone) && (
          <div className="pf-custblock">
            <div className="pf-block-head">PREPARED FOR</div>
            {customer.name && <div>{customer.name}</div>}
            {customer.email && <div>{customer.email}</div>}
            {customer.phone && <div>{customer.phone}</div>}
          </div>
        )}
      </div>

      <label className="doc-toggle">
        <input type="checkbox" checked={showOrigin} onChange={(e) => setShowOrigin(e.target.checked)} />
        Show country of origin on this document
      </label>

      {ready.length > 0 && (
        <section className="pf-section">
          <div className="pf-section-head">
            <h2>Ready to ship</h2>
          </div>
          <LinesTable lines={ready} currency={currency} showOrigin={showOrigin} />
        </section>
      )}

      {backorder.length > 0 && (
        <section className="pf-section">
          <div className="pf-section-head">
            <h2>Backorder — ships in approx. {leadTime}</h2>
          </div>
          <LinesTable lines={backorder} currency={currency} showOrigin={showOrigin} />
        </section>
      )}

      <div className="pf-totals">
        <div>
          <span>Subtotal</span>
          <strong>{money(subtotal, currency)}</strong>
        </div>
        {appliedPct > 0 && (
          <div>
            <span>Volume discount ({appliedPct}%)</span>
            <strong>−{money(round2(subtotal - afterVolume), currency)}</strong>
          </div>
        )}
        <div className="pf-grand">
          <span>Total</span>
          <strong>{money(afterVolume, currency)}</strong>
        </div>
        {backorder.length > 0 && dueToday != null && (
          <>
            <div className="pf-due">
              <span>DUE TODAY</span>
              <strong>{money(dueToday, currency)}</strong>
            </div>
            <div className="pf-subrow">
              <span>Ready to ship</span>
              <span>{money(readyAfterVolume, currency)}</span>
            </div>
            <div className="pf-subrow">
              <span>
                Backorder deposit ({depositPct}%{result?.backorder?.customerTier ? ` · ${result.backorder.customerTier}` : ''})
              </span>
              <span>{money(depositAmount, currency)}</span>
            </div>
            <div className="pf-due2">
              <span>Due before shipment (backorder balance)</span>
              <strong>{money(balanceAmount, currency)}</strong>
            </div>
          </>
        )}
      </div>

      {notes && (
        <div className="pf-notes">
          <div className="pf-block-head">NOTES</div>
          <div>{notes}</div>
        </div>
      )}

      <div className="pf-terms">
        <div className="pf-block-head">TERMS &amp; CONDITIONS</div>
        <ul>
          {quoteTerms(leadTime).map((t, i) => (
            <li key={i}>{t}</li>
          ))}
        </ul>
      </div>

      <div className="pf-foot">
        Questions or changes — your Baci Milano sales rep · 305.600.0099 · GS@BaciMilanoUSA.com ·
        Baci Milano USA, LLC · 1835 E Hallandale Beach Blvd STE 834, Hallandale Beach, FL 33009
      </div>
    </>
  );
}

// Quote terms / timelines / cost exclusions printed in the customer PDF footer. Wholesale
// boilerplate — OWNER SHOULD REVIEW the exact wording with legal/ops before relying on it.
const quoteTerms = (leadTime) => [
  'Prices are wholesale, quoted in U.S. dollars, and EXCLUDE freight/shipping, insurance, duties, and any applicable state or local taxes unless expressly stated on this document.',
  'This quote is valid for 14 days from the date above. All items are subject to prior sale and to availability at time of order confirmation.',
  'In-stock ("ready to ship") items typically ship within 3–5 business days of cleared payment.',
  `Backordered items typically ship in ${leadTime} from order confirmation; any ship/arrival dates shown are good-faith estimates and may change.`,
  'Backorder deposits are applied to the balance due at fulfillment; the remaining balance is due before the backordered goods ship.',
  'This document is a quotation, not an invoice or confirmed order, until accepted by Baci Milano USA and payment terms are met.',
];
