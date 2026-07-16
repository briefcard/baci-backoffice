import React, { useState } from 'react';
import { unitWholesalePrice, money } from '../domain.js';

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
// through the curated gallery inline.
function GalleryCard({ product, price, msrp, currency, onZoom }) {
  const gallery = product.gallery?.length ? product.gallery : product.image ? [product.image] : [];
  const [idx, setIdx] = useState(0);
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
          {money(price, currency)} <small>MSRP {money(msrp, currency)}</small>
        </span>
      </figcaption>
    </figure>
  );
}

// The customer-facing lookbook a personalized form link opens with: the owner's curated
// lifestyle heroes per collection (custom.collection_* metafields), a supporting image strip,
// image-forward product grids at wholesale pricing, and a single CTA into the prefilled form.
export function Lookbook({ catalog, onStart }) {
  const config = catalog?.config || {};
  const currency = config.currency || 'USD';
  const pct = config.discountPct ?? 50;
  const link = catalog?.link || {};
  const [zoom, setZoom] = useState(null); // { images, title }
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
          {s.images?.length > 0 && (
            <div className="lb-strip">
              {s.images.slice(0, 2).map((u, i) => (
                <img key={i} src={u} alt="" loading="lazy" />
              ))}
            </div>
          )}
          <div className="lb-grid">
            {s.products.map((p) => {
              const v = p.variants[0];
              return (
                <GalleryCard
                  key={p.id}
                  product={p}
                  price={v ? unitWholesalePrice(v, pct) : 0}
                  msrp={v?.retailPrice || 0}
                  currency={currency}
                  onZoom={(images, title) => setZoom({ images, title })}
                />
              );
            })}
          </div>
        </section>
      ))}

      <button className="cartbar lb-bar" onClick={onStart}>
        <span>{link.company || 'Ready when you are'}</span>
        <span>Start your order ▸</span>
      </button>

      {zoom && <ImageLightbox images={zoom.images} title={zoom.title} onClose={() => setZoom(null)} />}
    </div>
  );
}
