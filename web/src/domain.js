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

export function money(n, currency = 'USD') {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(Number(n) || 0);
}
