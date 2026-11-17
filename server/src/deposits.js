// Deposits as two Shopify invoices.
//
// The store is not on Shopify Plus, so Shopify's own draft-order deposit is unavailable. Instead
// a backorder produces two drafts: a DEPOSIT draft (one custom line, paid now) and the BACKORDER
// draft holding the goods. Payment always happens in Shopify; this module only
//   1. notices when a deposit draft has been completed, and makes that order's reservations firm;
//   2. prepares the balance: shows, in the app, what the backorder draft will charge once the
//      deposit is credited, and only on confirmation writes that credit to the Shopify draft.
//
// "Paid" is read as the deposit draft being COMPLETED. The app has no read_orders scope, so it
// cannot tell a draft completed as "payment pending" from one paid in full; the register flow
// completes a draft by taking payment, which is the case this relies on.
import { cfg } from './config.js';
import { round2 } from './domain.js';
import { draftOrderStatuses, updateDraftOrder } from './orders.js';
import { getOrder, listOrders, setOrderFirm, updateOrder } from './orderbook.js';

let lastRefresh = 0;

// Check open deposit drafts against Shopify (at most every 30s). Never throws: a failed check
// leaves statuses as they were.
export async function refreshDeposits({ force = false } = {}) {
  if (!force && Date.now() - lastRefresh < 30000) return 0;
  lastRefresh = Date.now();
  try {
    const open = (await listOrders({ limit: 500 })).filter((o) => o.depositDraft?.id && o.depositDraft.status !== 'paid');
    if (!open.length) return 0;
    const statuses = await draftOrderStatuses(open.map((o) => o.depositDraft.id));
    let paid = 0;
    for (const o of open) {
      const st = statuses.get(o.depositDraft.id);
      if (st?.status !== 'COMPLETED') continue;
      await updateOrder(o.id, { depositDraft: { ...o.depositDraft, status: 'paid', paidAt: st.completedAt || new Date().toISOString() } });
      await setOrderFirm(o.id, true);
      paid += 1;
    }
    return paid;
  } catch (err) {
    console.error('[deposits] status check failed', err);
    return 0;
  }
}

// What the backorder draft charges once the deposit is credited. Pure: no Shopify calls.
export function balancePreview(order) {
  const back = order.backorderDraft;
  if (!back) return null;
  const total = Number(back.total) || 0; // backorder total after the volume discount
  const subtotal = back.subtotal != null ? Number(back.subtotal) : total;
  const volumeAmount = round2(subtotal - total);
  const dep = order.depositDraft;
  const depositPaid = dep?.status === 'paid';
  const credit = depositPaid ? Number(dep.amount) || 0 : 0;
  return {
    backorderDraft: back.name,
    depositDraft: dep?.name || null,
    subtotal,
    volumeDiscountPct: order.volumeDiscountPct || 0,
    volumeAmount,
    total,
    depositAmount: dep ? Number(dep.amount) || 0 : 0,
    depositPaid,
    credit,
    balance: round2(total - credit),
    prepared: !!order.balance,
  };
}

// Write the deposit credit onto the backorder draft so Shopify invoices only the balance.
// Refuses while the deposit is unpaid unless `force` (an admin choosing to invoice in full).
export async function prepareBalance(orderId, by, { force = false } = {}) {
  await refreshDeposits({ force: true });
  const order = await getOrder(orderId);
  if (!order) return null;
  const p = balancePreview(order);
  if (!p) throw new Error('This order has no backorder');
  if (order.balance) throw new Error(`Balance already prepared on ${p.backorderDraft}`);
  if (order.depositDraft && !p.depositPaid && !force) {
    throw new Error(`Deposit ${p.depositDraft} is not paid yet`);
  }
  const back = order.backorderDraft;
  const tags = [...new Set([...(back.tags || []).filter((t) => t !== 'deposit-required'), 'balance-ready'])];
  const input = {
    tags,
    note: p.credit > 0
      ? `BALANCE — deposit ${p.depositDraft} ($${p.credit.toFixed(2)}) already paid and credited below. Balance due: $${p.balance.toFixed(2)}.`
      : `BALANCE — no deposit was collected. Full amount due: $${p.balance.toFixed(2)}.`,
  };
  // A draft order has ONE order-level discount, already used by the volume discount, so the
  // deposit credit is combined with it into a single fixed amount.
  const discount = round2(p.volumeAmount + p.credit);
  if (discount > 0) {
    input.appliedDiscount = {
      valueType: 'FIXED_AMOUNT',
      value: discount,
      title: p.credit > 0 ? (p.volumeAmount > 0 ? `Volume ${p.volumeDiscountPct}% + deposit paid` : 'Deposit paid') : `Volume ${p.volumeDiscountPct}%`,
      description: p.credit > 0 ? `Deposit ${p.depositDraft} $${p.credit.toFixed(2)}` : 'Volume discount',
    };
  }
  const updated = await updateDraftOrder(back.id, input);
  const shopifyTotal = Number(updated.total);
  const balance = {
    amount: p.balance,
    credit: p.credit,
    preparedAt: new Date().toISOString(),
    preparedBy: by,
    // Shopify is the record for money: if its total differs from ours, say so rather than hide it.
    shopifyTotal: Number.isFinite(shopifyTotal) ? shopifyTotal : null,
    mismatch: Number.isFinite(shopifyTotal) && Math.abs(shopifyTotal - p.balance) > 0.01,
  };
  await updateOrder(orderId, { balance, backorderDraft: { ...back, tags } });
  return { order: await getOrder(orderId), balance };
}

export const depositsEnabled = () => cfg.depositInvoices;
