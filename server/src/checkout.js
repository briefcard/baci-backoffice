// Checkout-captain queue: one person at the register handles all POS payments for orders reps
// captured in this app. This reads back the draft orders THIS app created (tagged `b2b-app`),
// parses out everything the captain needs to act without asking the rep — who it's for, whether
// it ships now or is a deposit-backorder, and the exact amount to collect now — and hands them a
// deep link into the Shopify draft to take payment.
import { shopifyGraphQL } from './shopify.js';
import { cfg } from './config.js';

const QUEUE_QUERY = `
query CheckoutQueue($q: String!) {
  draftOrders(first: 50, query: $q, sortKey: UPDATED_AT, reverse: true) {
    nodes {
      id
      name
      legacyResourceId
      createdAt
      updatedAt
      completedAt
      invoiceUrl
      tags
      note2
      customer { id displayName defaultEmailAddress { emailAddress } }
      totalPriceSet { presentmentMoney { amount currencyCode } }
      customAttributes { key value }
    }
  }
}`;

// Pull the first "$123.45" style amount out of a stamped attribute value (e.g. "30% ($123.45)").
function parseAmount(str) {
  if (!str) return null;
  const m = String(str).match(/\$([0-9,]+(?:\.[0-9]+)?)/);
  return m ? Number(m[1].replace(/,/g, '')) : null;
}

function tagValue(tags, prefix) {
  const t = (tags || []).find((x) => String(x).startsWith(prefix));
  return t ? t.slice(prefix.length) : null;
}

// Store handle for the Admin deep link: "769684-2.myshopify.com" -> "769684-2".
function storeHandle() {
  return String(cfg.shopifyStore || '').replace(/\.myshopify\.com$/i, '');
}

function parseDraft(n) {
  const tags = n.tags || [];
  const attrs = Object.fromEntries((n.customAttributes || []).map((a) => [a.key, a.value]));
  const total = Number(n.totalPriceSet?.presentmentMoney?.amount) || 0;
  const currency = n.totalPriceSet?.presentmentMoney?.currencyCode || 'USD';

  const isBackorder = tags.includes('backorder') || tags.includes('deposit-required');
  const isReady = tags.includes('ready-to-ship');
  const type = isBackorder ? 'backorder' : isReady ? 'ready' : 'other';

  const depositPct = isBackorder ? Number(tagValue(tags, 'deposit-pct:')) || null : null;
  // Prefer the exact $ we stamped at creation; fall back to total × pct.
  const depositAmount = isBackorder
    ? parseAmount(attrs['Deposit required']) ?? (depositPct != null ? round2(total * (depositPct / 100)) : null)
    : null;
  const balanceAmount = isBackorder
    ? parseAmount(attrs['Balance due at fulfillment']) ?? (depositAmount != null ? round2(total - depositAmount) : null)
    : null;

  // What the captain collects at the register right now.
  const dueNow = isBackorder ? depositAmount ?? total : total;

  return {
    id: n.id,
    name: n.name,
    createdAt: n.createdAt,
    completed: !!n.completedAt,
    type,
    rep: attrs['Sales rep'] || tagValue(tags, 'rep:') || '',
    customer: n.customer?.displayName || attrs['Customer'] || n.customer?.defaultEmailAddress?.emailAddress || '',
    total,
    currency,
    dueNow,
    depositPct,
    depositAmount,
    balanceAmount,
    customerTier: attrs['Customer tier'] || null,
    invoiceUrl: n.invoiceUrl || null,
    adminUrl: `https://admin.shopify.com/store/${storeHandle()}/draft_orders/${n.legacyResourceId}`,
  };
}

function round2(x) {
  return Math.round((Number(x) + Number.EPSILON) * 100) / 100;
}

export async function listCheckoutQueue() {
  const data = await shopifyGraphQL(QUEUE_QUERY, { q: 'tag:b2b-app' });
  return (data.draftOrders?.nodes || []).map(parseDraft);
}
