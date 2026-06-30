import React, { useMemo, useState } from 'react';
import { ProductCard } from './ProductCard.jsx';
import { productRank } from '../domain.js';

// Top level = curated main collections (config.mainCollections, in order).
// Inside a collection: filter by Product Type and/or Material. Out-of-stock sorts to the bottom.
export function BrowseView({ products, availability, config, productIndex }) {
  const [collection, setCollection] = useState(null); // { handle, title }
  const [type, setType] = useState(null);
  const [material, setMaterial] = useState(null);

  const lowT = config?.lowThreshold ?? 10;
  const main = config?.mainCollections || [];

  const collCounts = useMemo(() => {
    const m = new Map();
    for (const p of products) for (const c of p.collections || []) m.set(c.handle, (m.get(c.handle) || 0) + 1);
    return m;
  }, [products]);

  const inCollection = useMemo(
    () => (collection ? products.filter((p) => p.collections?.some((c) => c.handle === collection.handle)) : []),
    [products, collection]
  );

  const typeFacet = useMemo(() => facetCounts(inCollection, (p) => [p.productType || 'Other']), [inCollection]);
  const matFacet = useMemo(() => facetCounts(inCollection, (p) => p.materials || []), [inCollection]);

  const filtered = useMemo(() => {
    let list = inCollection;
    if (type) list = list.filter((p) => p.productType === type);
    if (material) list = list.filter((p) => (p.materials || []).includes(material));
    return [...list].sort((a, b) => productRank(a, availability, lowT) - productRank(b, availability, lowT));
  }, [inCollection, type, material, availability, lowT]);

  // Top level: pick a collection.
  if (!collection) {
    return (
      <div className="browse">
        <div className="facet-label">Collections</div>
        <div className="coll-grid">
          {main
            .filter((c) => collCounts.get(c.handle))
            .map((c) => (
              <button
                key={c.handle}
                className="coll-chip"
                onClick={() => { setType(null); setMaterial(null); setCollection(c); }}
              >
                {c.title} <span className="cnt">{collCounts.get(c.handle)}</span>
              </button>
            ))}
        </div>
      </div>
    );
  }

  // Inside a collection: filters + product list.
  return (
    <div className="browse">
      <div className="crumbs">
        <button className="crumb" onClick={() => { setCollection(null); setType(null); setMaterial(null); }}>
          ← Collections
        </button>
        <span className="sep">›</span>
        <span className="crumb on">{collection.title}</span>
      </div>

      {typeFacet.length > 1 && (
        <FilterRow label="Product Type" items={typeFacet} active={type} onPick={setType} />
      )}
      {matFacet.length > 1 && (
        <FilterRow label="Material" items={matFacet} active={material} onPick={setMaterial} />
      )}

      <div className="results">
        {filtered.map((p) => (
          <ProductCard key={p.id} product={p} availability={availability} config={config} productIndex={productIndex} />
        ))}
      </div>
    </div>
  );
}

function FilterRow({ label, items, active, onPick }) {
  return (
    <div className="facets">
      <div className="facet-label">{label}</div>
      <div className="chips">
        <button className={`facet-chip ${!active ? 'on' : ''}`} onClick={() => onPick(null)}>
          All
        </button>
        {items.map((it) => (
          <button
            key={it.title}
            className={`facet-chip ${active === it.title ? 'on' : ''}`}
            onClick={() => onPick(active === it.title ? null : it.title)}
          >
            {it.title} <span className="cnt">{it.count}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function facetCounts(list, keysFn) {
  const m = new Map();
  for (const p of list) for (const k of keysFn(p)) if (k) m.set(k, (m.get(k) || 0) + 1);
  return [...m.entries()]
    .map(([title, count]) => ({ title, count }))
    .sort((a, b) => b.count - a.count);
}
