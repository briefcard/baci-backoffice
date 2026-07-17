import React, { useMemo, useState } from 'react';
import { unitWholesalePrice, money } from '../domain.js';
import { submitOrQueue } from '../formSections.js';

const BRAND_LOGO = 'https://bacimilanousa.com/cdn/shop/files/Baci_Logo_-_White.png?height=108';

// Fullscreen image viewer shared by the lookbook and the order form: tap any product photo to
// flip through its curated gallery (custom.image_and_video, native images as fallback).
export function ImageLightbox({ images = [], title, onClose }) {
  const [idx, setIdx] = useState(0);
  if (!images.length) return null;
  return (
    <div className="lightbox" onClick={onClose}>
      <button className="lightbox-x" onClick={onClose}>✕</button>
      <img className="lightbox-main" src={images[idx]} alt="" onClick={(e) => e.stopPropagation()} />
      {title && <div className="lightbox-title">{title}</div>}
      {images.length > 1 && (
        <div className="lightbox-thumbs" onClick={(e) => e.stopPropagation()}>
          {images.map((u, i) => (
            <img
              key={i}
              src={u}
              alt=""
              className={i === idx ? 'on' : ''}
              onClick={() => setIdx(i)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// Image-forward product card: big primary photo (tap → lightbox), thumbnail strip to flip
// through the curated gallery inline — and, when setQ is provided, per-variant qty inputs so
// customers order straight from the lookbook (same oversell messaging as the form rows).
function GalleryCard({ product, pct, currency, onZoom, availability, qty, setQ, lead }) {
  const gallery = product.gallery?.length ? product.gallery : product.image ? [product.image] : [];
  const [idx, setIdx] = useState(0);
  const v0 = product.variants[0];
  const multi = product.variants.length > 1;
  return (
    <figure className="lb-card">
      {gallery.length ? (
        <img src={gallery[idx]} alt="" loading="lazy" onClick={() => onZoom(gallery, product.title)} />
      ) : (
        <div className="lb-ph" />
      )}
      {gallery.length > 1 && (
        <div className="lb-thumbs">
          {gallery.map((u, i) => (
            <img key={i} src={u} alt="" className={i === idx ? 'on' : ''} onClick={() => setIdx(i)} />
          ))}
        </div>
      )}
      <figcaption>
        <span className="lb-title">{product.title}</span>
        <span className="lb-price">
          {money(v0 ? unitWholesalePrice(v0, pct) : 0, currency)}{' '}
          <small>MSRP {money(v0?.retailPrice || 0, currency)}</small>
        </span>
      </figcaption>
      {setQ && (
        <div className="lb-vars">
          {product.variants.map((v) => {
            const avail = Math.max(0, availability?.[v.id] ?? v.available ?? 0);
            const out = avail <= 0;
            const entered = Math.floor(Number(qty?.[v.id]) || 0);
            const over = Math.max(0, entered - avail);
            return (
              <div className="lb-var" key={v.id}>
                <span className="lb-var-label">
                  {multi ? (v.title && v.title !== 'Default Title' ? v.title : v.sku || '—') : 'Qty'}
                  {multi && <small className="lb-var-price"> {money(unitWholesalePrice(v, pct), currency)}</small>}
                  {out && <em className="flater">deposit · ~{lead}</em>}
                  {!out && over > 0 && <em className="flater">+{over} on deposit</em>}
                </span>
                <input
                  className="lb-qty"
                  type="number"
                  inputMode="numeric"
                  min="0"
                  placeholder="0"
                  value={qty?.[v.id] || ''}
                  onChange={(e) => setQ(v.id, e.target.value)}
                />
              </div>
            );
          })}
        </div>
      )}
    </figure>
  );
}

// The customer-facing lookbook: the owner's curated lifestyle heroes per collection
// (custom.collection_* metafields), a supporting image strip, image-forward product grids at
// wholesale pricing. Opens from a personalized link OR from the rep's Form stage (curate →
// share/present). With a customer attached the hero reads "Curated for <company>"; without one
// it's just the logo over the header image.
//
// SHOPPABLE: pass qty/onQty (+ availability/mode/code) and every card grows qty inputs — the
// customer orders right here, no switch to the form required. The qty state is OWNED BY THE
// PARENT and shared with OrderFormView, so moving between lookbook and form keeps the order.
export function Lookbook({ catalog, onStart, cta = 'Start your order ▸', availability, qty, onQty, mode, code, prefill, onReset }) {
  const config = catalog?.config || {};
  const currency = config.currency || 'USD';
  const pct = config.discountPct ?? 50;
  const lead = config.leadTime || '6–10 weeks';
  const link = catalog?.link || {};
  const [zoom, setZoom] = useState(null); // { images, title }
  const [review, setReview] = useState(false);
  const [doneState, setDoneState] = useState(null); // null | 'sent' | 'queued'
  const shoppable = typeof onQty === 'function';
  const setQ = shoppable
    ? (variantId, value) => {
        const n = Math.max(0, Math.floor(Number(value) || 0));
        onQty((m) => ({ ...m, [variantId]: n }));
      }
    : null;
  const sections = (config.formCollections || [])
    .map((c) => ({
      ...c,
      products: (catalog?.products || []).filter((p) => (p.collections || []).some((x) => x.handle === c.handle)),
    }))
    .filter((s) => s.products.length > 0);
  const heroImage = sections.find((s) => s.image)?.image || null;

  // Everything with a quantity across the WHOLE catalog — including items picked over on the
  // form view — so the review sheet always matches what the customer entered anywhere.
  const chosen = useMemo(() => {
    if (!shoppable) return [];
    const out = [];
    for (const p of catalog?.products || [])
      for (const v of p.variants) {
        const n = Math.floor(Number(qty?.[v.id]) || 0);
        if (n > 0) out.push({ product: p, variant: v, qty: n });
      }
    return out;
  }, [shoppable, catalog, qty]);
  const unitCount = chosen.reduce((s, c) => s + c.qty, 0);

  return (
    <div className="lookbook">
      <header className="lb-hero">
        {heroImage && <img className="lb-hero-bg" src={heroImage} alt="" />}
        {heroImage && <div className="lb-hero-tint" />}
        <div className="lb-hero-in">
          <img className="pf-logo" src={BRAND_LOGO} alt="Baci Milano" />
          {link.company && <h1>Curated for {link.company}</h1>}
          <p>
            {sections.length} collection{sections.length !== 1 ? 's' : ''}
            {link.company ? ' selected for you' : ''} · wholesale pricing shown
          </p>
          {link.note && <p className="lb-note">“{link.note}”</p>}
          <button className="lb-cta" onClick={onStart}>
            {cta}
          </button>
        </div>
      </header>

      {sections.map((s) => (
        <section className="lb-section" key={s.handle}>
          <div className="lb-banner">
            {s.image ? <img src={s.image} alt="" loading="lazy" /> : null}
            <h2>{s.title}</h2>
          </div>
          {s.images?.length > 0 && (
            <div className="lb-strip">
              {s.images.slice(0, 2).map((u, i) => (
                <img key={i} src={u} alt="" loading="lazy" />
              ))}
            </div>
          )}
          <div className="lb-grid">
            {s.products.map((p) => (
              <GalleryCard
                key={p.id}
                product={p}
                pct={pct}
                currency={currency}
                onZoom={(images, title) => setZoom({ images, title })}
                availability={availability}
                qty={qty}
                setQ={setQ}
                lead={lead}
              />
            ))}
          </div>
        </section>
      ))}

      {shoppable && unitCount > 0 ? (
        <button className="cartbar lb-bar" onClick={() => setReview(true)}>
          <span>
            {unitCount} unit{unitCount !== 1 ? 's' : ''} · {chosen.length} item{chosen.length !== 1 ? 's' : ''}
          </span>
          <span>Review &amp; submit ▸</span>
        </button>
      ) : (
        <button className="cartbar lb-bar" onClick={onStart}>
          <span>{link.company || 'Ready when you are'}</span>
          <span>{cta}</span>
        </button>
      )}

      {review && (
        <ReviewSheet
          chosen={chosen}
          prefill={prefill || (link.company || link.email ? link : null)}
          availability={availability}
          currency={currency}
          mode={mode}
          code={code}
          onBack={() => setReview(false)}
          onDone={(state) => {
            setReview(false);
            setDoneState(state);
          }}
          setQ={setQ}
        />
      )}

      {doneState && (
        <div className="cart-overlay">
          <div className="cart">
            <div className="form-done">
              <div className="big-check">✓</div>
              <h2>Order received!</h2>
              <p className="muted">
                {doneState === 'queued'
                  ? 'Saved on this device — it will send automatically the moment signal returns.'
                  : 'A Baci Milano rep will review the totals with you shortly.'}
              </p>
              <button
                className="primary"
                onClick={() => {
                  onReset?.();
                  setDoneState(null);
                }}
              >
                Done
              </button>
            </div>
          </div>
        </div>
      )}

      {zoom && <ImageLightbox images={zoom.images} title={zoom.title} onClose={() => setZoom(null)} />}
    </div>
  );
}

// The customer's submit sheet — lines with the ready/deposit split, contact fields, and the
// offline-queueing submit. Lives here (not OrderFormView) so both the lookbook and the form can
// use it without a circular import; totals are NEVER rendered in customer mode.
export function ReviewSheet({ chosen, availability, currency, mode, code, onBack, onDone, setQ, prefill }) {
  const [company, setCompany] = useState(prefill?.company || '');
  const [contact, setContact] = useState(prefill?.contact || '');
  const [email, setEmail] = useState(prefill?.email || '');
  const [phone, setPhone] = useState(prefill?.phone || '');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const submit = async () => {
    if (!company.trim() && !contact.trim()) {
      setErr('Please add your store or contact name.');
      return;
    }
    setErr('');
    setBusy(true);
    try {
      const payload = {
        lines: chosen.map((c) => ({
          variantId: c.variant.id,
          quantity: c.qty,
          sku: c.variant.sku,
          title: c.product.title,
        })),
        customer: { company, contact, email, phone },
        notes,
      };
      const { queued } = await submitOrQueue({ kind: mode === 'public' ? 'qr' : 'kiosk', code, payload });
      onDone(queued ? 'queued' : 'sent');
    } catch (e) {
      setErr(e?.message || 'Could not submit — please try again.');
      setBusy(false);
    }
  };

  return (
    <div className="cart-overlay" onClick={onBack}>
      <div className="cart" onClick={(e) => e.stopPropagation()}>
        <div className="cart-head">
          <strong>Your order</strong>
          <button className="x" onClick={onBack}>
            ✕
          </button>
        </div>
        <div className="cart-body">
          {chosen.map((c) => {
            const avail = Math.max(0, availability?.[c.variant.id] ?? c.variant.available ?? 0);
            const now = Math.min(avail, c.qty);
            const dep = c.qty - now;
            return (
              <div className="citem" key={c.variant.id}>
                {c.product.image ? <img src={c.product.image} alt="" /> : <div className="ph" />}
                <div className="cinfo">
                  <div className="ct">{c.product.title}</div>
                  <div className="cs">
                    {c.variant.sku} · qty {c.qty}
                    {dep > 0 && (
                      <span className="cs-dep">
                        {now > 0 ? ` — ${now} now · ${dep} on deposit` : ' — on deposit (ships when available)'}
                      </span>
                    )}
                  </div>
                </div>
                <button className="link" onClick={() => setQ(c.variant.id, 0)}>
                  Remove
                </button>
              </div>
            );
          })}

          {chosen.some((c) => c.qty > Math.max(0, availability?.[c.variant.id] ?? c.variant.available ?? 0)) && (
            <div className="dep-note">
              Quantities beyond what's on hand are <strong>secured with a deposit</strong> and ship
              as soon as stock arrives — so nothing gets oversold. Your rep will go over the details.
            </div>
          )}

          <div className="muted small form-note">
            A Baci Milano rep will go over totals, availability, and any volume pricing with you.
          </div>

          <div className="cfields">
            <input placeholder="Store / company name" value={company} onChange={(e) => setCompany(e.target.value)} />
            <input placeholder="Your name" value={contact} onChange={(e) => setContact(e.target.value)} />
            <input type="email" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} />
            <input placeholder="Phone" value={phone} onChange={(e) => setPhone(e.target.value)} />
            <textarea placeholder="Anything we should know?" value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} />
          </div>

          {err && <div className="err">{err}</div>}
          <button className="primary" disabled={busy || chosen.length === 0} onClick={submit}>
            {busy ? 'Submitting…' : 'Submit order form'}
          </button>
        </div>
      </div>
    </div>
  );
}
