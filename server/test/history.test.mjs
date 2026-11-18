// Past shipments and the history import's filing rules, in-process (no database, no network).
import test from 'node:test';
import assert from 'node:assert/strict';

delete process.env.DATABASE_URL;
delete process.env.ANTHROPIC_API_KEY;
const { createShipment, updateShipment, receiveShipment, getShipment, refreshRollup, getRollup } = await import('../src/inbound.js');
const { ingestDocument, fileHistorical, getIntakeDoc, listIntake, assignDocument } = await import('../src/intakeDocs.js');
const { folderReference } = await import('../src/google.js');
const { readDocument } = await import('../src/reader.js');

const held = (filename, docType, refs, extracted, sourceId) =>
  ingestDocument({ filename, hash: `h-${sourceId}`, docType, refs, extracted, source: 'email' }, 'test', { historical: true, hold: true, sourceId });

test('a Drive folder name stands for its order or shipment number', () => {
  assert.deepEqual(folderReference('Order 111-2026'), { kind: 'italy_order', value: '111/2026' });
  assert.deepEqual(folderReference('Shipment 131-2026 (Three Way)'), { kind: 'internal', value: '131/2026' });
  assert.equal(folderReference('OLD VERSIONS'), null);
  assert.equal(folderReference('B2B SALES ASSETS'), null);
});

test('a past shipment is a record: received, never incoming, cannot be received or quietly made live', async () => {
  const ship = await createShipment('test', { reference: 'PAST-1', historical: true, status: 'in_transit', lines: [{ sku: 'X.AAA01', variantId: 'gid://v/1', expected: 40 }] });
  assert.equal(ship.status, 'received');
  assert.equal(ship.historical, true);
  await refreshRollup();
  assert.equal(getRollup().incoming.get('gid://v/1'), undefined);
  await assert.rejects(receiveShipment(ship.id, 'test', { lines: [{ id: ship.lines[0].id, received: 40 }] }), /past shipment/);
  await assert.rejects(updateShipment(ship.id, 'test', { status: 'in_transit' }), /past shipment/);
  await assert.rejects(updateShipment(ship.id, 'test', { historical: false }), /Choose where/);
  const live = await updateShipment(ship.id, 'test', { historical: false, status: 'in_transit' });
  assert.equal(live.historical, false);
  await refreshRollup();
  assert.equal(getRollup().incoming.get('gid://v/1'), 40);
});

test('filing a history batch: old supplier papers make past shipments, later papers join them, recent ones wait', async () => {
  // Taken in out of order: the freight invoice first, the order last.
  await held('freight.pdf', 'freight_invoice', [{ kind: 'freight_invoice', value: 'F-9' }, { kind: 'container', value: 'MSCU7654321' }], { docDate: '2026-04-25', total: 2000 }, 'a');
  await held('arrival.pdf', 'arrival_notice', [{ kind: 'container', value: 'MSCU7654321' }, { kind: 'italy_order', value: '555/2026' }], { docDate: '2026-04-10', eta: '2026-04-20', carrier: 'MSC' }, 'b');
  await held('order.pdf', 'order', [{ kind: 'italy_order', value: '555/2026' }], { docDate: '2026-03-01', reference: '555/2026', invoiceTotal: 500, lines: [{ sku: 'X.BBB01', expected: 10, unitPrice: 50 }] }, 'c');
  const recent = await held('new.pdf', 'order', [{ kind: 'italy_order', value: '777/2026' }], { docDate: '2026-11-10', reference: '777/2026', lines: [] }, 'd');
  const stray = await held('quote.pdf', 'freight_quote', [{ kind: 'forwarder_file', value: 'Q-1' }], { docDate: '2026-02-01' }, 'e');

  const out = await fileHistorical({ pastBefore: '2026-09-01' }, 'test');
  assert.deepEqual({ created: out.created, filed: out.filed, left: out.left }, { created: 1, filed: 3, left: 2 });
  const docs = await listIntake();
  const order = docs.find((d) => d.filename === 'order.pdf');
  const ship = await getShipment(order.shipmentId);
  assert.equal(ship.historical, true);
  assert.equal(ship.status, 'received');
  for (const name of ['freight.pdf', 'arrival.pdf']) assert.equal(docs.find((d) => d.filename === name).shipmentId, ship.id, name);
  assert.equal(ship.eta, '2026-04-20'); // applied from the arrival notice
  assert.equal(ship.invoiceTotal, 500); // the freight invoice's total is not the goods' cost
  assert.equal((await getIntakeDoc(recent.document.id)).status, 'unmatched'); // too recent to call "past"
  assert.equal((await getIntakeDoc(stray.document.id)).status, 'unmatched'); // a quote starts no shipment

  // A person settles the recent one as a live shipment.
  const res = await assignDocument(recent.document.id, { create: true }, 'test');
  assert.equal(res.shipment.historical, false);
  assert.equal(res.shipment.status, 'ordered');
});

test('the same source is never taken in twice, and set-aside files stay out of the inbox', async () => {
  const a = await ingestDocument({ filename: 'cat.pdf', hash: 'h-cat', source: 'drive' }, 'test', { historical: true, hold: true, sourceId: 'drive:1', status: 'skipped' });
  assert.equal(a.document.status, 'skipped');
  const b = await ingestDocument({ filename: 'cat-copy.pdf', hash: 'h-cat', source: 'email' }, 'test', { historical: true, hold: true, sourceId: 'gmail:9' });
  assert.equal(b.document.status, 'duplicate');
  const names = (await listIntake()).map((d) => d.filename);
  assert.ok(!names.includes('cat.pdf') && !names.includes('cat-copy.pdf'));
});

test("a file that only looks like a Baci document by its name is not trusted during an import", async () => {
  const r = await readDocument('Freight invoice 88231.xlsx', Buffer.from('not a spreadsheet'), {}, { gate: true });
  assert.equal(r.how, 'skipped');
  assert.equal(r.needsAI, true);
});
