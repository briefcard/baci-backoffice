// Document intake and the reference index, in-process (no database, no Shopify).
import test from 'node:test';
import assert from 'node:assert/strict';
import * as XLSX from 'xlsx';

delete process.env.DATABASE_URL;
const { createShipment } = await import('../src/inbound.js');
const { parseIntakeFile } = await import('../src/intake.js');
const { refKey, addRef, listRefs, matchRefs, ingestDocument, assignDocument, getIntakeDoc } = await import('../src/intakeDocs.js');

// A packing list laid out like the Turkish ones (PKLIST_640): "item Code4" header, blank spacer
// columns, cartons / weights / volume per line, and the order it ships named at the top.
function packingList({ number, orders, rows }) {
  const grid = [
    [`PKLIST_${number.replace('/', '_')}_BACI_MILANO_USA_LLC`, '', '', '', 'BACİ MİLANO DEKORASYON SANAYİ VE TİCARET ANONİM ŞİRKETİ'],
    ['', '', '', '', 'Şişli / Istanbul – Turkey'],
    ['Packing list #', 'Date', 'Orders', '', '', 'Customer po #'],
    [number, '7/27/2026', orders],
    ['item Code4', 'Description', '', 'Barcode Number', 'Quantity Piece/Set', '', 'Qnty/Set per Inner Carton', '', 'Qnty/Set per Master Carton', '', 'Quantity of Master Carton', 'Net Weight in kg', 'Gross Weight in kg', 'CBM Per Master ', 'Total CBM'],
    ...rows.map(([sku, desc, qty, cartons, net, gross, cbm]) => [sku, desc, '', '8059793465840', qty, 'Pcs', 1, 'PC', 8, 'Pcs', cartons, net, gross, 0.014, cbm]),
  ];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(grid), 'Sheet1');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}
const PK640 = () => packingList({ number: '640/2026', orders: '111/2026', rows: [['CUP1.ZOD01', 'CUP WITH LID/SAUCER ARIES', 752, 94, 353.44, 444.62, 1.318], ['CUP1.ZOD02', 'CUP WITH LID/SAUCER TAURUS', ' 1,200 ', 150, 564, 709.5, 2.1]] });

test('one spelling per reference number', () => {
  for (const v of ['111/2026', '111-2026', 'ORD_111_2026', 'Order 111 / 2026', '0111/2026', '2026/111']) assert.equal(refKey(v), '111/2026');
  assert.equal(refKey('MSCU 123456-7'), 'MSCU1234567');
  assert.equal(refKey('  '), '');
});

test('a packing list is read: its own number, the order it ships, quantities, cartons, weight, volume', async () => {
  const p = await parseIntakeFile('PKLIST_640_BACI_MILANO_USA_LLC.xlsx', PK640());
  assert.equal(p.docType, 'packing_list');
  assert.deepEqual(p.refs, [{ kind: 'packing_list', value: '640/2026' }, { kind: 'italy_order', value: '111/2026' }]);
  assert.deepEqual(p.lines.map((l) => [l.sku, l.expected, l.cartons, l.cbm]), [['CUP1.ZOD01', 752, 94, 1.318], ['CUP1.ZOD02', 1200, 150, 2.1]]);
  assert.deepEqual([p.totals.units, p.totals.cartons, p.totals.cbm, p.totals.grossKg], [1952, 244, 3.418, 1154.12]);
});

test('a document files itself on the one shipment that carries its number, and adds its other numbers', async () => {
  const ship = await createShipment('test', { reference: '111/2026', status: 'ordered' });
  const { document, duplicate } = await ingestDocument({ filename: 'PKLIST_640.xlsx', buffer: PK640() }, 'staff@test');
  assert.equal(duplicate, false);
  assert.deepEqual([document.status, document.shipmentId], ['matched', ship.id]);
  // the shipment is now also known by its packing-list number
  assert.deepEqual((await listRefs([ship.id])).map((r) => `${r.kind} ${r.key}`).sort(), ['italy_order 111/2026', 'packing_list 640/2026']);
  // so a later document quoting ONLY the packing list finds it
  const later = await ingestDocument({ filename: 'arrival-notice.pdf', hash: 'h-arrival', docType: 'arrival_notice', refs: [{ kind: 'packing_list', value: 'PKLIST 640-2026' }, { kind: 'forwarder_file', value: '599573' }] }, 'agent@whatsapp');
  assert.deepEqual([later.document.status, later.document.shipmentId], ['matched', ship.id]);
  // and now the forwarder's own file number finds it too
  const [byFile] = await matchRefs([{ kind: 'other', value: '599573' }]);
  assert.equal(byFile.shipment.id, ship.id);
});

test('the same file is taken in once', async () => {
  const buf = packingList({ number: '701/2026', orders: '300/2026', rows: [['CUP1.ZOD03', 'GEMINI', 10, 2, 5, 6, 0.03]] });
  const a = await ingestDocument({ filename: 'PKLIST_701.xlsx', buffer: buf }, 't');
  const b = await ingestDocument({ filename: 'PKLIST_701 (1).xlsx', buffer: buf }, 't');
  assert.equal(b.duplicate, true);
  assert.equal(b.document.id, a.document.id);
});

test('an order split across two shipments waits for a person; a more specific number decides', async () => {
  const s1 = await createShipment('test', { reference: 'Sea part', status: 'ordered' });
  const s2 = await createShipment('test', { reference: 'Air part', status: 'ordered' });
  await addRef(s1.id, { kind: 'italy_order', value: '500/2026' }, 't');
  await addRef(s2.id, { kind: 'italy_order', value: '500/2026' }, 't');
  await addRef(s2.id, { kind: 'packing_list', value: '683/2026' }, 't');
  // only the order number: both shipments carry it, so nobody guesses
  const vague = await ingestDocument({ filename: 'note.pdf', hash: 'h-vague', refs: [{ kind: 'italy_order', value: '500/2026' }] }, 't');
  assert.equal(vague.document.status, 'needs_review');
  assert.equal(vague.candidates.length, 2);
  // the packing-list number names one shipment
  const exact = await ingestDocument({ filename: 'pk.pdf', hash: 'h-exact', refs: [{ kind: 'italy_order', value: '500/2026' }, { kind: 'packing_list', value: '683/2026' }] }, 't');
  assert.deepEqual([exact.document.status, exact.document.shipmentId], ['matched', s2.id]);
  // a person settles the vague one
  const res = await assignDocument(vague.document.id, { shipmentId: s1.id }, 'staff@test');
  assert.deepEqual([res.document.status, res.document.shipmentId, res.document.reviewedBy], ['matched', s1.id, 'staff@test']);
});

test('a document with no home can start a shipment, lines and numbers included', async () => {
  const buf = packingList({ number: '900/2026', orders: '880/2026', rows: [['CUP1.ZOD05', 'LEO', 48, 6, 20, 25, 0.08]] });
  const { document } = await ingestDocument({ filename: 'PKLIST_900.xlsx', buffer: buf }, 't');
  assert.equal(document.status, 'unmatched');
  const res = await assignDocument(document.id, { create: true }, 'staff@test');
  assert.equal(res.created, true);
  assert.deepEqual([res.shipment.status, res.shipment.lines.length, res.shipment.lines[0].expected], ['in_transit', 1, 48]);
  assert.deepEqual((await listRefs([res.shipment.id])).map((r) => r.key).sort(), ['880/2026', '900/2026']);
  assert.equal((await getIntakeDoc(document.id)).shipmentId, res.shipment.id);
});

const { applyPreview, applyDocument } = await import('../src/intakeDocs.js');
const { getShipment } = await import('../src/inbound.js');

test('applying documents fills the shipment in: prices and origin from the invoice, volume from the packing list', async () => {
  const ship = await createShipment('test', { reference: '1200/2026', status: 'ordered', lines: [{ sku: 'CUP1.ZOD01', expected: 700 }, { sku: 'OLD.ITEM01', expected: 5 }] });
  // what a reader extracted from the supplier invoice for this order
  const inv = await ingestDocument({
    filename: 'INVOICE_1300.pdf', hash: 'h-inv-1300', docType: 'invoice',
    refs: [{ kind: 'supplier_invoice', value: '1300/2026' }, { kind: 'italy_order', value: '1200/2026' }],
    extracted: { invoiceTotal: 6510, incoterm: 'EXW', paymentTerms: '100 % IN ADVANCE', lines: [
      { sku: 'CUP1.ZOD01', expected: 752, unitPrice: 7.5, currency: 'EUR', madeIn: 'BANGLADESH', hsCode: '69111000' },
      { sku: 'CUP1.ZOD02', expected: 116, unitPrice: 7.5, currency: 'EUR', madeIn: 'BANGLADESH', hsCode: '69111000' }] },
  }, 't');
  assert.equal(inv.document.status, 'matched');

  const pre = await applyPreview(inv.document.id);
  assert.equal(pre.lineUpdates, 1);
  assert.deepEqual(pre.fields.sort(), ['made-in', 'tariff code', 'unit price']);
  assert.deepEqual(pre.missing, [{ sku: 'CUP1.ZOD02', expected: 116 }]);
  assert.deepEqual(pre.qtyDiffs, [{ sku: 'CUP1.ZOD01', shipment: 700, document: 752 }]);
  assert.deepEqual(pre.notOnDocument, ['OLD.ITEM01']);
  assert.deepEqual(pre.header.map((h) => [h.field, h.to]), [['invoiceTotal', 6510], ['incoterm', 'EXW'], ['paymentTerms', '100 % IN ADVANCE']]);
  // the preview changed nothing
  assert.equal((await getShipment(ship.id)).lines[0].unitCost, null);

  // default apply: details and header only; quantities and new lines are opt-in
  await applyDocument(inv.document.id, {}, 'staff@test');
  let s = await getShipment(ship.id);
  const zod1 = () => s.lines.find((l) => l.sku === 'CUP1.ZOD01');
  assert.deepEqual([zod1().unitCost, zod1().currency, zod1().madeIn, zod1().hsCode, zod1().expected], [7.5, 'EUR', 'BANGLADESH', '69111000', 700]);
  assert.deepEqual([s.invoiceTotal, s.incoterm, s.paymentTerms, s.lines.length], [6510, 'EXW', '100 % IN ADVANCE', 2]);
  assert.equal((await getIntakeDoc(inv.document.id)).applied.by, 'staff@test');

  // the packing list brings volume, and this time quantities and the missing line are accepted
  const pk = await ingestDocument({ filename: 'PKLIST_1400.xlsx', buffer: packingList({ number: '1400/2026', orders: '1200/2026', rows: [['CUP1.ZOD01', 'ARIES', 752, 94, 353.44, 444.62, 1.318], ['CUP1.ZOD02', 'TAURUS', 116, 15, 54.5, 68.6, 0.21]] }) }, 't');
  assert.equal(pk.document.shipmentId, ship.id);
  const res = await applyDocument(pk.document.id, { addMissing: true, setQuantities: true }, 'staff@test');
  assert.deepEqual([res.summary.added, res.summary.quantitiesSet], [1, 1]);
  s = await getShipment(ship.id);
  assert.deepEqual([zod1().expected, zod1().cartons, zod1().cbm, zod1().unitCost], [752, 94, 1.318, 7.5]); // price kept
  assert.deepEqual(s.lines.map((l) => l.sku).sort(), ['CUP1.ZOD01', 'CUP1.ZOD02', 'OLD.ITEM01']);
  assert.equal(s.invoiceTotal, 6510); // a packing list never touches money
  // nothing left to apply
  assert.equal((await applyPreview(pk.document.id)).nothing, true);
});

test('a forwarder notice read elsewhere moves the arrival date once applied', async () => {
  const ship = await createShipment('test', { reference: '1500/2026', status: 'in_transit', eta: '2026-12-18' });
  await addRef(ship.id, { kind: 'forwarder_file', value: 'FF-88001' }, 't');
  const n = await ingestDocument({ filename: 'arrival.pdf', hash: 'h-arr-88001', docType: 'arrival_notice', refs: [{ kind: 'forwarder_file', value: 'FF 88001' }], extracted: { eta: '2027-01-06', carrier: 'MSC', container: 'MSCU7654321' } }, 'agent@whatsapp');
  assert.equal(n.document.shipmentId, ship.id);
  assert.deepEqual((await applyPreview(n.document.id)).header.map((h) => [h.field, h.from, h.to]), [['eta', '2026-12-18', '2027-01-06'], ['carrier', null, 'MSC'], ['tracking', null, 'MSCU7654321']]);
  const res = await applyDocument(n.document.id, {}, 'staff@test');
  assert.deepEqual([res.before.eta, res.shipment.eta, res.shipment.carrier, res.shipment.tracking], ['2026-12-18', '2027-01-06', 'MSC', 'MSCU7654321']);
});
