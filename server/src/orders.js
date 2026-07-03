// Create Shopify draft order(s) from a rep's cart. Pricing is server-authoritative (from the
// live snapshot cache): each line gets a wholesale discount; the rep's capped volume discount
// (if any) is applied at the order level. Rep identity is stamped on tags + custom attributes.
//
// A cart can mix items that are in stock now with items that aren't. Per line, we split the
// requested quantity into a "ready" portion (covered by live stock) and a "backorder" portion
// (the shortfall) and submit them as up to TWO separate draft orders: one fulfillable today,
// and one flagged for a deposit — since the office needs to invoice/ship these independently.
import { shopifyGraphQL } from './shopify.js';
import { cache } from './snapshot.js';
import { round2, maxAdditionalPct } from './domain.js';
import { resolveCustomer } from './customers.js';
import { cfg } from './config.js';

const clamp = (n, lo, hi) => Math.min(Math.max(n, lo), hi);

const DRAFT_ORDER_CREATE = `
mutation CreateDraft($input: DraftOrderInput!) {
  draftOrderCreate(input: $input) {
    draftOrder {
      id
      name
      invoiceUrl
      totalPriceSet { presentmentMoney { amount currencyCode } }
    }
    userErrors { field message }
  }
}`;

function findVariant(variantId) {
  for (const p of cache.products) for (const v of p.variants) if (v.id === variantId) return v;
  return null;
}

// Split each requested line by live stock into a "ready now" qty and a "backorder" (shortfall) qty.
function splitLines(lines) {
  const ready = [];
  const backorder = [];
  for (const l of lines || []) {
    const v = findVariant(l.variantId);
    if (!v) continue;
    const qty = Math.max(1, Math.floor(Number(l.quantity) || 1));
    const avail = Math.max(0, Math.floor(Number(v.available) || 0));
    const readyQty = Math.min(avail, qty);
    const backorderQty = qty - readyQty;
    if (readyQty > 0) ready.push({ v, qty: readyQty });
    if (backorderQty > 0) backorder.push({ v, qty: backorderQty });
  }
  return { ready, backorder };
}

// Price a set of {v, qty} entries at wholesale (override or global %). Returns Shopify line
// items (with the per-line wholesale discount applied) plus the wholesale subtotal.
function priceLines(entries, discountPct) {
  let subtotal = 0;
  const lineItems = entries.map(({ v, qty }) => {
    const retail = Number(v.retailPrice) || 0;
    const hasOverride = v.wholesaleOverride != null && v.wholesaleOverride !== '';
    const unit = hasOverride ? Number(v.wholesaleOverride) : round2(retail * (1 - discountPct / 100));
    subtotal += unit * qty;
    const discPct = retail > 0 ? clamp(round2((1 - unit / retail) * 100), 0, 100) : 0;
    return {
      variantId: v.id,
      quantity: qty,
      appliedDiscount: { valueType: 'PERCENTAGE', value: discPct, title: 'Wholesale' },
    };
  });
  return { lineItems, subtotal: round2(subtotal) };
}

async function submitDraftOrder({ lineItems, tags, customAttributes, note, customerId, customer, volumeDiscountPct, reserveUntil }) {
  const input = { lineItems, note: note || '', tags, customAttributes };
  if (reserveUntil) input.reserveInventoryUntil = reserveUntil;
  if (customer?.phone) input.phone = String(customer.phone).trim();
  if (customerId) input.purchasingEntity = { customerId };
  else if (customer?.email) input.email = String(customer.email).trim();
  if (volumeDiscountPct > 0) {
    input.appliedDiscount = { valueType: 'PERCENTAGE', value: round2(volumeDiscountPct), title: `Volume ${volumeDiscountPct}%` };
  }
  const data = await shopifyGraphQL(DRAFT_ORDER_CREATE, { input });
  const r = data.draftOrderCreate;
  if (r.userErrors?.length) throw new Error(r.userErrors.map((e) => e.message).join('; '));
  return {
    name: r.draftOrder.name,
    id: r.draftOrder.id,
    invoiceUrl: r.draftOrder.invoiceUrl,
    total: r.draftOrder.totalPriceSet?.presentmentMoney?.amount,
  };
}

export async function createOrders(rep, body = {}) {
  const { lines, customer = {}, notes, repDiscountPct, cardOnFile } = body;
  const discountPct = cache.config?.discountPct ?? 50;

  const { ready, backorder } = splitLines(lines);
  if (ready.length === 0 && backorder.length === 0) throw new Error('No valid line items');

  const { lineItems: readyItems, subtotal: readySubtotal } = priceLines(ready, discountPct);
  const { lineItems: backItems, subtotal: backSubtotal } = priceLines(backorder, discountPct);
  const totalSubtotal = round2(readySubtotal + backSubtotal);

  // Resolve the customer once (shared across both draft orders); tags come back fresh from
  // Shopify, never from the client, so the deposit tier can't be spoofed by the rep.
  const { customerId, isRepeat } = await resolveCustomer(customer.id || customer.email ? customer : null);
  const tiers = cache.config?.depositPct || { new_customer: 40, repeat_customer: 30 };
  const depositPct = isRepeat ? Number(tiers.repeat_customer) : Number(tiers.new_customer);

  // The volume-discount ladder is one deal-size negotiation lever; compute the cap off the
  // COMBINED subtotal (ready + backorder) so splitting into two orders can't change the tier,
  // then apply the same rep-chosen % to each resulting order's own subtotal.
  const cap = maxAdditionalPct(totalSubtotal, cache.config?.tiers || []);
  const applied = clamp(Number(repDiscountPct) || 0, 0, cap);

  const repName = rep?.name || rep?.email || 'unknown';
  const baseTags = ['b2b-app', `rep:${repName}`];
  // Card-on-file is collected at POS (captain saves the card via the reader) — the app only flags
  // it on the draft so the captain knows to do it at checkout. No card data ever touches the app.
  if (cardOnFile) baseTags.push('card-on-file');
  const baseAttrs = [
    { key: 'Sales rep', value: repName },
    { key: 'Rep email', value: rep?.email || '' },
  ];
  if (customer.name) baseAttrs.push({ key: 'Customer', value: String(customer.name) });
  if (customer.phone) baseAttrs.push({ key: 'Phone', value: String(customer.phone) });
  if (cardOnFile) baseAttrs.push({ key: 'Card on file', value: 'Save card at register (POS)' });

  const result = { ready: null, backorder: null };

  if (readyItems.length) {
    // Oversell guard: hold this draft's inventory so other reps / the online store can't sell
    // the same units while payment is being collected. Expires automatically if never completed.
    const reserveUntil =
      cfg.reserveHours > 0 ? new Date(Date.now() + cfg.reserveHours * 3600 * 1000).toISOString() : null;
    result.ready = await submitDraftOrder({
      lineItems: readyItems,
      tags: [...baseTags, 'ready-to-ship'],
      customAttributes: baseAttrs,
      note: notes || '',
      customerId,
      customer,
      volumeDiscountPct: applied,
      reserveUntil,
    });
  }

  if (backItems.length) {
    const backAfterVolume = round2(backSubtotal * (1 - applied / 100));
    const depositAmount = round2(backAfterVolume * (depositPct / 100));
    const balanceAmount = round2(backAfterVolume - depositAmount);
    const tierLabel = isRepeat ? 'Repeat (B2B-tagged)' : 'New customer';
    const depositNote =
      `BACKORDER — do not fulfill until stock arrives. ` +
      `Deposit required: ${depositPct}% ($${depositAmount.toFixed(2)}) due now (${tierLabel}); ` +
      `balance $${balanceAmount.toFixed(2)} due when items ship.`;

    result.backorder = await submitDraftOrder({
      lineItems: backItems,
      tags: [...baseTags, 'backorder', 'deposit-required', `deposit-pct:${depositPct}`],
      customAttributes: [
        ...baseAttrs,
        { key: 'Customer tier', value: tierLabel },
        { key: 'Deposit required', value: `${depositPct}% ($${depositAmount.toFixed(2)})` },
        { key: 'Balance due at fulfillment', value: `$${balanceAmount.toFixed(2)}` },
      ],
      note: notes ? `${notes}\n\n${depositNote}` : depositNote,
      customerId,
      customer,
      volumeDiscountPct: applied,
    });
    result.backorder.depositPct = depositPct;
    result.backorder.depositAmount = depositAmount;
    result.backorder.balanceAmount = balanceAmount;
    result.backorder.customerTier = tierLabel;
  }

  return result;
}
