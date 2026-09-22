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

// ---- Case pack / MOQ ----
// A wholesale qty box counts SELLABLE UNITS, and for a "Set of 6" one unit is six pieces. Not
// saying so on the form is the single most expensive ambiguity on a B2B order: the customer
// reads "6" as six plates, the warehouse ships thirty-six. Every surface that shows a qty box
// or prints a line must therefore also say what one unit contains.
export function packSize(variant) {
  const n = Math.floor(Number(variant?.casePack) || 0);
  return n > 1 ? n : 1;
}

// "Set of 6" / "Sold individually" — the human sentence for one unit.
export function packLabel(variant) {
  const n = packSize(variant);
  return n > 1 ? `Set of ${n}` : 'Sold individually';
}

// Pieces behind a quantity of units (qty 2 of a set of 6 = 12 pieces).
export function pieces(variant, qty) {
  return packSize(variant) * Math.max(0, Math.floor(Number(qty) || 0));
}

// Minimum order quantity in UNITS. 0 = no minimum worth showing (unset, or a meaningless 1).
export function moqOf(variant) {
  const n = Math.floor(Number(variant?.moq) || 0);
  return n > 1 ? n : 0;
}

// Lines ordered below their minimum. Owner's rule (2026-09-21): SHOW these, never block on them
// — a rep mid-conversation on a tradeshow floor must always be able to capture the order, and
// the office can sort a short line out afterwards. Callers render it; nothing here disables.
export function belowMinimum(lines, variantOf = (l) => l) {
  const out = [];
  for (const l of lines || []) {
    const min = moqOf(variantOf(l));
    const qty = Math.floor(Number(l.qty) || 0);
    if (min > 0 && qty > 0 && qty < min) out.push({ line: l, qty, min });
  }
  return out;
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
