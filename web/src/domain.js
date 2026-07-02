// Client mirror of server/src/domain.js — keeps price/stock display identical to the backend.
export function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

export function unitWholesalePrice(variant, discountPct) {
  const o = variant.wholesaleOverride;
  if (o != null && o !== '') return round2(Number(o));
  return round2(Number(variant.retailPrice) * (1 - Number(discountPct) / 100));
}

export function stockState(available, lowThreshold = 10) {
  if (available <= 0) return 'out';
  if (available < lowThreshold) return 'low';
  return 'in';
}

// Sort rank — in stock (0) first, low (1), out of stock (2) last.
export function stateRank(available, lowThreshold = 10) {
  if (available <= 0) return 2;
  if (available < lowThreshold) return 1;
  return 0;
}

// Best (lowest) stock rank across a product's variants — for ordering product lists.
export function productRank(product, availabilityMap, lowThreshold = 10) {
  let best = 2;
  for (const v of product.variants || []) {
    const a = availabilityMap[v.id] ?? v.available ?? 0;
    best = Math.min(best, stateRank(a, lowThreshold));
  }
  return best;
}

export function maxAdditionalPct(wholesaleSubtotal, tiers) {
  let pct = 0;
  for (const t of [...(tiers || [])].sort((a, b) => a.min_order - b.min_order)) {
    if (wholesaleSubtotal >= t.min_order) pct = t.additional_pct;
  }
  return pct;
}

export function money(n, currency = 'USD') {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(Number(n) || 0);
}

// Split cart lines by live stock into "ready now" and "backorder" (shortfall) portions —
// client mirror of the server's split, shared by the cart review and the printable order copy.
export function splitByAvailability(items, availability) {
  const ready = [];
  const backorder = [];
  for (const i of items || []) {
    const avail = Math.max(0, Math.floor(Number(availability?.[i.variantId] ?? 0)));
    const readyQty = Math.min(avail, i.qty);
    const backorderQty = i.qty - readyQty;
    if (readyQty > 0) ready.push({ ...i, qty: readyQty });
    if (backorderQty > 0) backorder.push({ ...i, qty: backorderQty });
  }
  return { ready, backorder };
}
