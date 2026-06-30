import React from 'react';

const LABELS = {
  in: { text: 'In stock', cls: 'stock in' },
  low: { text: 'Low', cls: 'stock low' },
  out: { text: 'Out', cls: 'stock out' },
};

export function StockBadge({ state, available }) {
  const l = LABELS[state] || LABELS.out;
  return (
    <span className={l.cls}>
      {l.text}
      {state !== 'out' && available != null ? ` · ${available}` : ''}
    </span>
  );
}
