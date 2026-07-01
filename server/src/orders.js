// Create a Shopify draft order from a rep's cart. Pricing is server-authoritative (from the
// live snapshot cache): each line gets a wholesale discount; the rep's capped volume discount
// (if any) is applied at the order level. Rep identity is stamped on tags + custom attributes.
import { shopifyGraphQL } from './shopify.js';
import { cache } from './snapshot.js';
import { round2, maxAdditionalPct } from './domain.js';

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

const FIND_CUSTOMER = `query($q: String!) { customers(first: 1, query: $q) { nodes { id } } }`;
const CREATE_CUSTOMER = `mutation($input: CustomerInput!) {
  customerCreate(input: $input) { customer { id } userErrors { field message } }
}`;

// Match an existing customer by email, else create one. Returns a customer gid or null.
async function findOrCreateCustomer({ email, name, phone }) {
  const e = String(email).trim();
  const found = await shopifyGraphQL(FIND_CUSTOMER, { q: `email:${e}` });
  if (found.customers?.nodes?.[0]) return found.customers.nodes[0].id;

  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  const input = { email: e };
  if (parts.length > 1) {
    input.firstName = parts.slice(0, -1).join(' ');
    input.lastName = parts[parts.length - 1];
  } else if (parts.length === 1) {
    input.firstName = parts[0];
  }
  if (phone) input.phone = String(phone).trim();

  let res = await shopifyGraphQL(CREATE_CUSTOMER, { input });
  if (res.customerCreate?.userErrors?.length && input.phone) {
    delete input.phone; // phone formats are often rejected — retry without it
    res = await shopifyGraphQL(CREATE_CUSTOMER, { input });
  }
  return res.customerCreate?.customer?.id || null;
}

export async function createDraftOrder(rep, body = {}) {
  const { lines, customer = {}, notes, repDiscountPct } = body;
  const discountPct = cache.config?.discountPct ?? 35;

  const lineItems = [];
  let subtotal = 0;
  for (const l of lines || []) {
    const v = findVariant(l.variantId);
    if (!v) continue;
    const qty = Math.max(1, Math.floor(Number(l.quantity) || 1));
    const retail = Number(v.retailPrice) || 0;
    const hasOverride = v.wholesaleOverride != null && v.wholesaleOverride !== '';
    const unit = hasOverride ? Number(v.wholesaleOverride) : round2(retail * (1 - discountPct / 100));
    subtotal += unit * qty;
    const discPct = retail > 0 ? clamp(round2((1 - unit / retail) * 100), 0, 100) : 0;
    lineItems.push({
      variantId: v.id,
      quantity: qty,
      appliedDiscount: { valueType: 'PERCENTAGE', value: discPct, title: 'Wholesale' },
    });
  }
  if (lineItems.length === 0) throw new Error('No valid line items');
  subtotal = round2(subtotal);

  const repName = rep?.name || rep?.email || 'unknown';
  const tags = ['b2b-app', `rep:${repName}`];
  const customAttributes = [
    { key: 'Sales rep', value: repName },
    { key: 'Rep email', value: rep?.email || '' },
  ];
  if (customer.name) customAttributes.push({ key: 'Customer', value: String(customer.name) });
  if (customer.phone) customAttributes.push({ key: 'Phone', value: String(customer.phone) });

  const input = { lineItems, note: notes || '', tags, customAttributes };
  if (customer.phone) input.phone = String(customer.phone).trim();
  if (customer.email) {
    // Match an existing customer (dedupe) or create one; fall back to email-on-draft if it fails.
    let customerId = null;
    try {
      customerId = await findOrCreateCustomer(customer);
    } catch (err) {
      customerId = null;
    }
    if (customerId) input.purchasingEntity = { customerId };
    else input.email = String(customer.email).trim();
  }

  // Rep's volume discount, hard-capped by the order-size tier.
  const cap = maxAdditionalPct(subtotal, cache.config?.tiers || []);
  const applied = clamp(Number(repDiscountPct) || 0, 0, cap);
  if (applied > 0) {
    input.appliedDiscount = { valueType: 'PERCENTAGE', value: round2(applied), title: `Volume ${applied}%` };
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
