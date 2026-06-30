import React, { useMemo, useState } from 'react';
import { ProductCard } from './ProductCard.jsx';

// Drill-down browse: Collection → Product Type → Design. At each level we show the
// next facet's chips (with counts) AND the products matching the current filter.
export function BrowseView({ products, availability, config, productIndex }) {
  const [collection, setCollection] = useState(null); // { handle, title }
  const [type, setType] = useState(null);
  const [design, setDesign] = useState(null);

  const filtered = useMemo(
    () =>
      products.filter(
        (p) =>
          (!collection || p.collections?.some((c) => c.handle === collection.handle)) &&
          (!type || p.productType === type) &&
          (!design || p.design === design)
      ),
    [products, collection, type, design]
  );

  const facet = useMemo(() => {
    if (!collection) {
      const m = new Map();
      for (const p of filtered)
        for (const c of p.collections || []) {
          const e = m.get(c.handle) || { handle: c.handle, title: c.title, count: 0 };
          e.count++;
          m.set(c.handle, e);
        }
      return { kind: 'collection', label: 'Collection', items: [...m.values()].sort((a, b) => b.count - a.count) };
    }
    if (!type) {
      const m = new Map();
      for (const p of filtered) {
        const t = p.productType || 'Other';
        m.set(t, (m.get(t) || 0) + 1);
      }
      return {
        kind: 'type',
        label: 'Product Type',
        items: [...m.entries()].map(([title, count]) => ({ title, count })).sort((a, b) => b.count - a.count),
      };
    }
    if (!design) {
      const m = new Map();
      for (const p of filtered) {
        const d = p.design || 'Other';
        m.set(d, (m.get(d) || 0) + 1);
      }
      return {
        kind: 'design',
        label: 'Design',
        items: [...m.entries()].map(([title, count]) => ({ title, count })).sort((a, b) => b.count - a.count),
      };
    }
    return { kind: 'none', items: [] };
  }, [filtered, collection, type, design]);

  const pick = (item) => {
    if (facet.kind === 'collection') setCollection({ handle: item.handle, title: item.title });
    else if (facet.kind === 'type') setType(item.title);
    else if (facet.kind === 'design') setDesign(item.title);
  };

  return (
    <div className="browse">
      <div className="crumbs">
        <button className="crumb" onClick={() => { setCollection(null); setType(null); setDesign(null); }}>
          All
        </button>
        {collection && (
          <>
            <span className="sep">›</span>
            <button className="crumb" onClick={() => { setType(null); setDesign(null); }}>
              {collection.title}
            </button>
          </>
        )}
        {type && (
          <>
            <span className="sep">›</span>
            <button className="crumb" onClick={() => setDesign(null)}>
              {type}
            </button>
          </>
        )}
        {design && (
          <>
            <span className="sep">›</span>
            <span className="crumb on">{design}</span>
          </>
        )}
      </div>

      {facet.kind !== 'none' && facet.items.length > 0 && (
        <div className="facets">
          <div className="facet-label">{facet.label}</div>
          <div className="chips">
            {facet.items.map((it) => (
              <button key={it.handle || it.title} className="facet-chip" onClick={() => pick(it)}>
                {it.title} <span className="cnt">{it.count}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="results">
        {filtered.slice(0, 60).map((p) => (
          <ProductCard
            key={p.id}
            product={p}
            availability={availability}
            config={config}
            productIndex={productIndex}
          />
        ))}
      </div>
    </div>
  );
}
