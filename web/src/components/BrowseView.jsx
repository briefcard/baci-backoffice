import React, { useMemo, useState } from 'react';
import { ProductCard } from './ProductCard.jsx';
import { productRank } from '../domain.js';

// Faceted browse: products are always visible. Filter rows at the top —
// Collection (curated main lines) → Product Type → Material. Out-of-stock sorts to the bottom.
export function BrowseView({ products, availability, config, productIndex }) {
  const [collection, setCollection] = useState(null); // collection handle
  const [type, setType] = useState(null);
  const [material, setMaterial] = useState(null);

  const lowT = config?.lowThreshold ?? 10;
  const main = config?.mainCollections || [];

  const collCounts = useMemo(() => {
    const m = new Map();
    for (const p of products) for (const c of p.collections || []) m.set(c.handle, (m.get(c.handle) || 0) + 1);
    return m;
  }, [products]);

  // Products after the collection filter — the basis for the type/material facets.
  const base = useMemo(
    () => (collection ? products.filter((p) => p.collections?.some((c) => c.handle === collection)) : products),
    [products, collection]
  );

  const typeFacet = useMemo(() => facetCounts(base, (p) => [p.productType || 'Other']), [base]);
  const matFacet = useMemo(() => facetCounts(base, (p) => p.materials || []), [base]);

  const filtered = useMemo(() => {
    let list = base;
    if (type) list = list.filter((p) => p.productType === type);
    if (material) list = list.filter((p) => (p.materials || []).includes(material));
    return [...list]
      .sort((a, b) => productRank(a, availability, lowT) - productRank(b, availability, lowT))
      .slice(0, 200);
  }, [base, type, material, availability, lowT]);

  const collItems = main
    .filter((c) => collCounts.get(c.handle))
    .map((c) => ({ key: c.handle, title: c.title, count: collCounts.get(c.handle) }));

  return (
    <div className="browse">
      {collItems.length > 0 && (
        <FilterRow
          label="Collection"
          items={collItems}
          active={collection}
          onPick={(k) => { setCollection(k); setType(null); setMaterial(null); }}
        />
      )}
      {typeFacet.length > 1 && (
        <FilterRow
          label="Product Type"
          items={typeFacet.map((i) => ({ key: i.title, title: i.title, count: i.count }))}
          active={type}
          onPick={setType}
        />
      )}
      {matFacet.length > 1 && (
        <FilterRow
          label="Material"
          items={matFacet.map((i) => ({ key: i.title, title: i.title, count: i.count }))}
          active={material}
          onPick={setMaterial}
        />
      )}

      <div className="results">
        {filtered.map((p) => (
          <ProductCard key={p.id} product={p} availability={availability} config={config} productIndex={productIndex} />
        ))}
        {filtered.length === 0 && <div className="center muted">No matches.</div>}
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
            key={it.key}
            className={`facet-chip ${active === it.key ? 'on' : ''}`}
            onClick={() => onPick(active === it.key ? null : it.key)}
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
