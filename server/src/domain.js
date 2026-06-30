// Core B2B domain logic — pricing + availability.
// This is the single source of truth for the rules; the web client mirrors it in web/src/domain.js.

export function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

// Per-line wholesale unit price. Owner-set: override wins, else retail − global %.
// Reps cannot change this.
export function unitWholesalePrice(variant, discountPct) {
  const override = variant.wholesaleOverride;
  if (override != null && override !== '') return round2(Number(override));
  return round2(Number(variant.retailPrice) * (1 - Number(discountPct) / 100));
}

// Available-to-sell = sum of "available" across the configured sellable locations.
// Per spec, that's Miami Warehouse only — Shopify's "available" already nets committed demand.
export function availableToSell(inventoryLevels, sellableLocationIds) {
  return inventoryLevels
    .filter((l) => sellableLocationIds.includes(l.locationId))
    .reduce((sum, l) => sum + (Number(l.available) || 0), 0);
}

// Stock state band. Out if <= 0, Low if < threshold (default 10), else In stock.
export function stockState(available, lowThreshold = 10) {
  if (available <= 0) return 'out';
  if (available < lowThreshold) return 'low';
  return 'in';
}

// The ONLY negotiation lever: max additional % a rep may apply, by wholesale subtotal.
// Computed on the pre-volume subtotal so applying the discount can't drop you a tier.
export function maxAdditionalPct(wholesaleSubtotal, tiers) {
  let pct = 0;
  for (const t of [...tiers].sort((a, b) => a.min_order - b.min_order)) {
    if (wholesaleSubtotal >= t.min_order) pct = t.additional_pct;
  }
  return pct;
}

// Order math for the cart (used in M2; defined here so client + server agree).
export function orderTotals(lines, { discountPct, tiers }, repAppliedPct = 0) {
  const wholesaleSubtotal = round2(
    lines.reduce((s, l) => s + unitWholesalePrice(l, discountPct) * l.qty, 0)
  );
  const cap = maxAdditionalPct(wholesaleSubtotal, tiers);
  const appliedPct = Math.min(Math.max(repAppliedPct, 0), cap);
  const exceededCap = repAppliedPct > cap;
  const finalTotal = round2(wholesaleSubtotal * (1 - appliedPct / 100));
  return { wholesaleSubtotal, maxAdditionalPct: cap, appliedPct, exceededCap, finalTotal };
}
