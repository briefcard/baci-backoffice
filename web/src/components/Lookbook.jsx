import React, { useEffect, useMemo, useState } from 'react';
import { unitWholesalePrice, money, packSize, packLabel, pieces, moqOf, belowMinimum } from '../domain.js';
import { submitOrQueue } from '../formSections.js';

const BRAND_LOGO = 'https://bacimilanousa.com/cdn/shop/files/Baci_Logo_-_White.png?height=108';

// Brand film behind the hero (Shopify CDN — H.264 720p, ~3MB, faststart, no audio track).
// The poster paints instantly so the hero is never blank; the video fades in over it once it can
// actually play. Reps work on venue Wi-Fi, so this is deliberately small and skippable.
const HERO_VIDEO = 'https://cdn.shopify.com/s/files/1/0769/1993/1192/files/baci-lookbook-hero.mp4?v=1786055850';
// Poster is the video's FIRST frame, pulled at 1920x1080 from the original master (not from the
// 720p transcode — that was a compressed frame of already-compressed video). Matching frame 0
// means the fade to video has no visible jump.
const HERO_POSTER = 'https://cdn.shopify.com/s/files/1/0769/1993/1192/files/baci-lookbook-hero-poster-hq.jpg?v=1786057485';

// Don't pull 3MB of video on a metered/slow connection or when the viewer prefers reduced
// motion — the poster still carries the hero in those cases.
function useHeroVideo() {
  const [play, setPlay] = useState(false);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const c = navigator.connection || {};
    const slow = c.saveData === true || /(^|-)2g$/.test(c.effectiveType || '');
    const still = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
    if (!slow && !still) setPlay(true);
  }, []);
  return play;
}

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

// A heart: the only control on a price-free card. Tapping it saves the piece to the interest
// list — no quantity, no price, no commitment, which is the whole point of the price-free share.
function Heart({ on, onClick, label }) {
  return (
    <button
      type="button"
      className={`lb-heart${on ? ' on' : ''}`}
      onClick={onClick}
      aria-pressed={on}
      aria-label={on ? `Remove ${label} from your selection` : `Save ${label} to your selection`}
      title={on ? 'Saved — tap to remove' : 'Save to your selection'}
    >
      {on ? '♥' : '♡'}
    </button>
  );
}

// Image-forward product card: big primary photo (tap → lightbox), thumbnail strip to flip
// through the curated gallery inline — and, when setQ is provided, per-variant qty inputs so
// customers order straight from the lookbook (same oversell messaging as the form rows).
//
// PRICE-FREE (priceFree): no money renders at all and the qty inputs become hearts. A
// single-variant piece gets one heart over the photo; a multi-variant piece gets a heart per
// variant, so "I want the blue one" survives into the quote.
function GalleryCard({ product, pct, currency, onZoom, availability, qty, setQ, lead, priceFree }) {
  const gallery = product.gallery?.length ? product.gallery : product.image ? [product.image] : [];
  const [idx, setIdx] = useState(0);
  const v0 = product.variants[0];
  const multi = product.variants.length > 1;
  const hearts = priceFree && setQ;
  // Pack/minimum are variant-level, but on a card the first variant speaks for the piece: every
  // colourway of one product ships the same way.
  const moq = v0 ? moqOf(v0) : 0;
  return (
    <figure className={`lb-card${priceFree ? ' lb-card-plain' : ''}`}>
      {gallery.length ? (
        <img src={gallery[idx]} alt="" loading="lazy" onClick={() => onZoom(gallery, product.title)} />
      ) : (
        <div className="lb-ph" />
      )}
      {hearts && !multi && v0 && (
        <Heart
          on={(qty?.[v0.id] || 0) > 0}
          onClick={() => setQ(v0.id, (qty?.[v0.id] || 0) > 0 ? 0 : 1)}
          label={product.title}
        />
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
        {/* What ONE unit contains. Shown price-free too — it describes the goods, not the deal. */}
        {v0 && <span className="lb-pack">{packLabel(v0)}{moq > 0 ? ` · min ${moq}` : ''}</span>}
        {!priceFree && (
          <span className="lb-price">
            {money(v0 ? unitWholesalePrice(v0, pct) : 0, currency)}{' '}
            <small>MSRP {money(v0?.retailPrice || 0, currency)}</small>
          </span>
        )}
      </figcaption>

      {hearts && multi && (
        <div className="lb-vars lb-vars-heart">
          {product.variants.map((v) => (
            <div className="lb-var" key={v.id}>
              <span className="lb-var-label">{v.title && v.title !== 'Default Title' ? v.title : v.sku || '—'}</span>
              <Heart
                on={(qty?.[v.id] || 0) > 0}
                onClick={() => setQ(v.id, (qty?.[v.id] || 0) > 0 ? 0 : 1)}
                label={`${product.title} ${v.title || ''}`.trim()}
              />
            </div>
          ))}
        </div>
      )}

      {!priceFree && setQ && (
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
                  {/* Units -> pieces, live: "3 = 18 pieces". The customer types boxes; this is
                      the only place they learn what that means before the order is placed. */}
                  {packSize(v) > 1 && entered > 0 && (
                    <small className="lb-var-pieces">= {pieces(v, entered)} pieces</small>
                  )}
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
  // Price-free share: no pricing anywhere, hearts instead of quantities, and the submission is
  // a request for a quote rather than an order. The server has already stripped the prices out
  // of this payload — this flag only decides what we draw.
  const priceFree = config.pricing === 'none';
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
  const playVideo = useHeroVideo();
  const [videoOn, setVideoOn] = useState(false);
  // Price-free hero has nothing to "start" — its CTA just drops the viewer into the first
  // collection, and the fixed bar takes over once they've hearted something.
  const scrollToCollections = () =>
    document.querySelector('.lb-section')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  // Character count drives the hero name's font size (see --chars in styles.css): the size is
  // derived from BOTH the available width and the name's length, so a short name is large on any
  // screen and a long one shrinks just enough to hold one line — instead of a fixed size tier
  // that would over-shrink on desktop and still overflow on a phone.
  const companyChars = Math.max((link.company || '').trim().length, 1);

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
  const pieceCount = chosen.reduce((n, c) => n + pieces(c.variant, c.qty), 0);

  return (
    <div className="lookbook">
      <header className="lb-hero">
        {/* Brand film, not the first collection's photo. Poster paints first; the video fades in
            over it on canplay, so a slow load or a blocked autoplay just leaves the still frame. */}
        <img className="lb-hero-bg" src={HERO_POSTER} alt="" />
        {playVideo && (
          <video
            className={`lb-hero-bg lb-hero-video${videoOn ? ' on' : ''}`}
            src={HERO_VIDEO}
            poster={HERO_POSTER}
            autoPlay
            muted
            loop
            playsInline
            preload="auto"
            aria-hidden="true"
            onCanPlay={() => setVideoOn(true)}
          />
        )}
        <div className="lb-hero-scrim" />
        <div className="lb-hero-in">
          <span className="lb-eyebrow">{link.company ? 'Private Selection' : 'The Lookbook'}</span>
          <img className="pf-logo" src={BRAND_LOGO} alt="Baci Milano" />
          {link.company && (
            <h1 className="lb-display lb-name">
              <span className="lb-curated">Curated for</span>
              {/* Store name gets its own line and steps down a size tier as it gets longer, so
                  short names stay big and long ones still fit on one line. If it does have to
                  wrap, text-wrap:balance splits it into even, centred lines instead of leaving
                  one orphan word. */}
              <span className="lb-company" style={{ '--chars': companyChars }}>
                {link.company}
              </span>
            </h1>
          )}
          <p className="lb-hero-sub">
            {sections.length} collection{sections.length !== 1 ? 's' : ''}
            {link.company ? ' selected for you' : ''} · {priceFree ? 'the collection' : 'wholesale pricing'}
          </p>
          {link.note && <p className="lb-note">“{link.note}”</p>}
          {priceFree ? (
            <>
              <button className="lb-cta" onClick={scrollToCollections}>
                View the collections ▾
              </button>
              <p className="lb-hero-hint">
                Tap ♡ on anything that interests you — we'll send pricing on your selection.
              </p>
            </>
          ) : (
            <button className="lb-cta" onClick={onStart}>
              {cta}
            </button>
          )}
        </div>
      </header>

      {sections.map((s, i) => (
        <section className="lb-section" key={s.handle}>
          <div className="lb-banner">
            {s.image ? <img src={s.image} alt="" loading="lazy" /> : null}
            <div className="lb-banner-cap">
              <span className="lb-eyebrow">
                {String(i + 1).padStart(2, '0')} — {sections.length === 1 ? 'The Collection' : 'Collection'}
              </span>
              <h2 className="lb-display">{s.title}</h2>
            </div>
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
                priceFree={priceFree}
              />
            ))}
          </div>
        </section>
      ))}

      {priceFree ? (
        // The interest list. Before anything is hearted the bar is a prompt, not a dead button —
        // tapping it scrolls into the collections rather than opening an empty sheet.
        chosen.length > 0 ? (
          <button className="cartbar lb-bar" onClick={() => setReview(true)}>
            <span>
              ♥ {chosen.length} piece{chosen.length !== 1 ? 's' : ''} saved
            </span>
            <span>Request a quote ▸</span>
          </button>
        ) : (
          <button className="cartbar lb-bar lb-bar-quiet" onClick={scrollToCollections}>
            <span>{link.company || 'Baci Milano'}</span>
            <span>Tap ♡ to save pieces</span>
          </button>
        )
      ) : shoppable && unitCount > 0 ? (
        <button className="cartbar lb-bar" onClick={() => setReview(true)}>
          <span>
            {unitCount} unit{unitCount !== 1 ? 's' : ''} · {chosen.length} item{chosen.length !== 1 ? 's' : ''}
            {/* Last place the number is seen before submitting: if any line is a set, the bar
                must not leave "units" to be read as "pieces". */}
            {pieceCount !== unitCount && ` · ${pieceCount} pieces`}
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
          intent={priceFree ? 'quote' : 'order'}
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
              <div className="big-check">{priceFree ? '♥' : '✓'}</div>
              <h2>{priceFree ? 'Your selection is with us' : 'Order received!'}</h2>
              <p className="muted">
                {doneState === 'queued'
                  ? 'Saved on this device — it will send automatically the moment signal returns.'
                  : priceFree
                    ? 'A Baci Milano rep will come back to you with pricing and availability on the pieces you saved.'
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
export function ReviewSheet({ chosen, availability, currency, mode, code, onBack, onDone, setQ, prefill, intent = 'order' }) {
  const quote = intent === 'quote';
  const [company, setCompany] = useState(prefill?.company || '');
  const [contact, setContact] = useState(prefill?.contact || '');
  const [email, setEmail] = useState(prefill?.email || '');
  const [phone, setPhone] = useState(prefill?.phone || '');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const short = belowMinimum(chosen, (c) => c.variant);

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
        intent,
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
          <strong>{quote ? 'Request a quote' : 'Your order'}</strong>
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
                  {quote ? (
                    // Quantity is optional here — the customer is asking what it costs, not
                    // committing. But a number they DO give lets the rep quote volume pricing
                    // in one pass instead of a round trip, so it's worth offering.
                    <label className="cs cq-wrap">
                      {c.variant.sku} ·{' '}
                      <input
                        className="cq"
                        type="number"
                        inputMode="numeric"
                        min="1"
                        value={c.qty}
                        onChange={(e) => setQ(c.variant.id, Math.max(1, Math.floor(Number(e.target.value) || 1)))}
                      />{' '}
                      <span className="muted">
                        qty (optional)
                        {packSize(c.variant) > 1 ? ` · ${packLabel(c.variant).toLowerCase()}` : ''}
                      </span>
                    </label>
                  ) : (
                    <div className="cs">
                      {c.variant.sku} · qty {c.qty}
                      {packSize(c.variant) > 1 && (
                        <span className="cs-pack"> · {pieces(c.variant, c.qty)} pieces</span>
                      )}
                      {dep > 0 && (
                        <span className="cs-dep">
                          {now > 0 ? ` — ${now} now · ${dep} on deposit` : ' — on deposit (ships when available)'}
                        </span>
                      )}
                    </div>
                  )}
                </div>
                <button className="link" onClick={() => setQ(c.variant.id, 0)}>
                  Remove
                </button>
              </div>
            );
          })}

          {!quote &&
            chosen.some((c) => c.qty > Math.max(0, availability?.[c.variant.id] ?? c.variant.available ?? 0)) && (
              <div className="dep-note">
                Quantities beyond what's on hand are <strong>secured with a deposit</strong> and ship
                as soon as stock arrives — so nothing gets oversold. Your rep will go over the details.
              </div>
            )}

          {/* Minimums are stated, not enforced — the order still goes through and the rep
              confirms. A quote request is only an enquiry, so it is left alone entirely. */}
          {!quote && short.length > 0 && (
            <div className="min-warn">
              <strong>
                {short.length} item{short.length !== 1 ? 's' : ''} below the minimum order quantity
              </strong>
              {short.map(({ line, qty, min }) => (
                <div className="min-row" key={line.variant.id}>
                  <span>{line.product.title}</span>
                  <span>
                    qty {qty} · min {min}
                  </span>
                  <button className="link" onClick={() => setQ(line.variant.id, min)}>
                    Raise to {min}
                  </button>
                </div>
              ))}
              <div className="min-note">You can send it as is — your rep will confirm.</div>
            </div>
          )}

          <div className="muted small form-note">
            {quote
              ? 'Nothing is ordered by sending this. A Baci Milano rep will come back with wholesale pricing and availability on these pieces.'
              : 'A Baci Milano rep will go over totals, availability, and any volume pricing with you.'}
          </div>

          <div className="cfields">
            <input placeholder="Store / company name" value={company} onChange={(e) => setCompany(e.target.value)} />
            <input placeholder="Your name" value={contact} onChange={(e) => setContact(e.target.value)} />
            <input type="email" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} />
            <input placeholder="Phone" value={phone} onChange={(e) => setPhone(e.target.value)} />
            <textarea
              placeholder={quote ? 'Anything we should know? (timing, quantities, questions)' : 'Anything we should know?'}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
            />
          </div>

          {err && <div className="err">{err}</div>}
          <button className="primary" disabled={busy || chosen.length === 0} onClick={submit}>
            {busy ? 'Sending…' : quote ? 'Send quote request' : 'Submit order form'}
          </button>
        </div>
      </div>
    </div>
  );
}
