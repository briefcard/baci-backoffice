// Order book rules, run in-process with no database and no Shopify (in-memory fallbacks).
//   cd server && npm test
import test from 'node:test';
import assert from 'node:assert/strict';

delete process.env.DATABASE_URL;
const { createShipment, updateShipment, receiveShipment, findDuplicateByReference } = await import('../src/inbound.js');
const { recordOrder, reconcile, listOrders, setOrderFirm, freeIncomingByVariant } = await import('../src/orderbook.js');
const { scopesSatisfied, missingScopes } = await import('../src/config.js');

let n = 0;
const variant = () => `gid://shopify/ProductVariant/t${++n}`;
const ship = (variantId, expected, extra = {}) =>
  createShipment('test', { reference: `T-${++n}`, status: 'ordered', lines: [{ sku: `SKU${n}`, variantId, expected }], ...extra });
const order = async (variantId, backorderQty, readyQty = 0) => {
  await new Promise((r) => setTimeout(r, 3)); // distinct created-at so "oldest order" is well defined
  return recordOrder({ rep: { email: 'rep@test' }, customer: { name: 'C' }, entries: [{ variantId, sku: 'S', title: 'T', unitPrice: 10, readyQty, backorderQty }] });
};
const sources = async (orderId) => {
  const o = (await listOrders()).find((x) => x.id === orderId);
  const out = { stock: 0, shipment: 0, unsourced: 0, byShipment: {} };
  for (const l of o.lines) for (const a of l.allocations) {
    out[a.source] += a.quantity;
    if (a.shipment) out.byShipment[a.shipment.reference] = (out.byShipment[a.shipment.reference] || 0) + a.quantity;
  }
  return out;
};

test('two orders cannot reserve the same incoming units', async () => {
  const v = variant();
  await ship(v, 100);
  const a = await order(v, 80, 5);
  const b = await order(v, 50);
  assert.deepEqual({ ...(await sources(a)), byShipment: undefined }, { stock: 5, shipment: 80, unsourced: 0, byShipment: undefined });
  const sb = await sources(b);
  assert.equal(sb.shipment, 20);
  assert.equal(sb.unsourced, 30);
  assert.equal((await freeIncomingByVariant()).get(v), 0);
});

test('the shipment with the earliest ETA is reserved first', async () => {
  const v = variant();
  const late = await ship(v, 10, { eta: '2027-03-01' });
  const early = await ship(v, 10, { eta: '2027-01-15' });
  const s = await sources(await order(v, 15));
  assert.equal(s.byShipment[early.reference], 10);
  assert.equal(s.byShipment[late.reference], 5);
});

test('a draft (RFQ) shipment is not promised to orders', async () => {
  const v = variant();
  await ship(v, 50, { status: 'draft' });
  assert.equal((await sources(await order(v, 10))).unsourced, 10);
});

test('cancelling a shipment releases its reservations; new supply goes to the oldest order', async () => {
  const v = variant();
  const s1 = await ship(v, 30);
  const first = await order(v, 20);
  const second = await order(v, 10);
  await updateShipment(s1.id, 'test', { status: 'cancelled' });
  await reconcile();
  assert.equal((await sources(first)).unsourced, 20);
  assert.equal((await sources(second)).unsourced, 10);
  await ship(v, 25);
  await reconcile();
  assert.equal((await sources(first)).shipment, 20);
  assert.deepEqual([(await sources(second)).shipment, (await sources(second)).unsourced], [5, 5]);
});

test('when a shipment line is cut, firm reservations keep their units', async () => {
  const v = variant();
  const s1 = await ship(v, 40);
  const paid = await order(v, 20);
  const unpaid = await order(v, 20);
  await setOrderFirm(paid, true);
  // the older order paid its deposit; cut the line to 25 units
  await updateShipment(s1.id, 'test', { lines: [{ ...s1.lines[0], expected: 25 }] });
  await reconcile();
  assert.equal((await sources(paid)).shipment, 20);
  assert.deepEqual([(await sources(unpaid)).shipment, (await sources(unpaid)).unsourced], [5, 15]);
});

test('a short receipt releases the units that did not arrive', async () => {
  const v = variant();
  const s1 = await ship(v, 30);
  const o = await order(v, 30);
  await receiveShipment(s1.id, 'test', { lines: [{ id: s1.lines[0].id, received: 26, damaged: 2 }] });
  await reconcile();
  const s = await sources(o);
  assert.deepEqual([s.shipment, s.unsourced], [24, 6]);
});

test('an empty receive is rejected', async () => {
  const s1 = await ship(variant(), 5);
  await assert.rejects(() => receiveShipment(s1.id, 'test', {}), /No lines to receive/);
});

test('duplicate references ignore case, spacing and punctuation', async () => {
  await createShipment('test', { reference: 'ORD-981' });
  assert.ok(await findDuplicateByReference('ord 981'));
  assert.ok(await findDuplicateByReference('Ord_981'));
  assert.equal(await findDuplicateByReference('ORD-982'), null);
});

test('a granted write scope covers the matching read scope', () => {
  const granted = 'write_products,write_inventory,read_locations,write_draft_orders,write_customers';
  assert.equal(scopesSatisfied(`${granted},read_orders`), true);
  assert.equal(scopesSatisfied('write_products,read_locations,write_draft_orders,write_customers,read_orders'), false);
  // read_orders is required: without it a deposit's payment status cannot be verified
  assert.equal(scopesSatisfied(granted), false);
  assert.deepEqual(missingScopes(granted), ['read_orders']);
});

const { balancePreview } = await import('../src/deposits.js');

test('balance = backorder total minus the deposit, only once the deposit is paid', () => {
  const order = {
    volumeDiscountPct: 8,
    backorderDraft: { name: '#D2', total: '37287.60', subtotal: 40530 },
    depositDraft: { name: '#D3', amount: 11186.28, pct: 30, status: 'open' },
  };
  const unpaid = balancePreview(order);
  assert.deepEqual([unpaid.depositPaid, unpaid.credit, unpaid.balance, unpaid.volumeAmount], [false, 0, 37287.6, 3242.4]);
  const paid = balancePreview({ ...order, depositDraft: { ...order.depositDraft, status: 'paid' } });
  assert.deepEqual([paid.depositPaid, paid.credit, paid.balance], [true, 11186.28, 26101.32]);
  assert.equal(balancePreview({ backorderDraft: null }), null);
});
