// Supplier document intake: turn an ORD pro-forma PDF, a PKLIST packing-list PDF, or a PKLIST
// .xlsx into shipment lines { sku, qty, description } for admin review.
//
// Strategy (learned from the real files — ORD_110/113, PKLIST_131 pdf, PKLIST_167 xlsx):
//  - XLSX: locate the header row ("Code" ... "Quantity (PCS)") and read columns directly.
//  - PDF: the raw text stream is SCRAMBLED (column-by-column), so we rebuild the visual table
//    from pdf.js text coordinates: group items into rows by Y, then read the SKU token and the
//    quantity from the column under the "Q.ty"/"Quantity" header X-band.
//  - Every SKU candidate is validated against the live catalog (cache) — matched lines carry the
//    variantId; unmatched ones are kept but flagged for the admin to fix in review.
import * as XLSX from 'xlsx';
import { matchSku } from './inbound.js';

// Their SKU shape: PL1.COL01, CUS60.POR02, APIT1.AQ38, BOOK.TES21, HEA.SAG01C, BRBOT1.BAR08P
const SKU_RE = /^[A-Z0-9]{2,8}\.[A-Z]{2,5}\d{1,3}[A-Z]{0,2}$/;

// "6.883,25" -> 6883.25 ; "3,75" -> 3.75 ; "9" -> 9 (EU number format on supplier documents).
function euNumber(str) {
  return Number(String(str).trim().replace(/\./g, '').replace(',', '.'));
}
function euNumberOrNull(str) {
  if (str == null || str === '') return null;
  const n = euNumber(str);
  return Number.isFinite(n) ? n : null;
}
// A spreadsheet cell that may be a number or a formatted string like " 1,200 ".
function cellNumber(c) {
  if (typeof c === 'number') return c;
  const n = Number(String(c ?? '').replace(/[\s,]/g, ''));
  return Number.isFinite(n) ? n : NaN;
}

const COUNTRIES = ['TURKEY', 'CHINA', 'BANGLADESH', 'ITALY', 'INDIA', 'VIETNAM', 'PORTUGAL'];

function toLine(sku, qty, description) {
  const hit = matchSku(sku);
  return {
    sku,
    expected: qty,
    title: hit?.product?.title || (description || '').slice(0, 200) || null,
    variantId: hit?.variant?.id || null,
    matched: !!hit,
    description: (description || '').slice(0, 200),
  };
}

// Meta: reference from anywhere; origin from the LETTERHEAD only (the top of the document) —
// the line items carry "Made In: TURKEY/CHINA" columns that would fool a whole-text match.
function extractMeta(text) {
  const ref =
    text.match(/(?:Order number|Packing list #|Orders)[\s\S]{0,40}?(\d{2,4}\/\d{4})/i)?.[1] || null;
  // Company identifiers from the letterhead — these never appear in line-item columns
  // (unlike "Made In: TURKEY"), so they're safe on the full text.
  const origin = /Dekorasyon|Istanbul|Şişli/i.test(text)
    ? 'Baci Milano — Turkey HQ'
    : /S\.?R\.?L\.?|Corridoni|20122 Milano/i.test(text)
      ? 'Baci Milano — Italy'
      : null;

  // WHEN: document date (dd/mm/yyyy on both ORD and PKLIST).
  const dm = text.match(/\b(\d{2})\/(\d{2})\/(\d{4})\b/);
  const docDate = dm ? `${dm[3]}-${dm[2]}-${dm[1]}` : null;
  // WHERE: FOB port + where the goods are made (from the Made In column values).
  const fob = text.match(/FOB\s+([A-Z][A-Z ]{2,18}?)(?=\s*(?:\n|Order|Bank|$))/)?.[1]?.trim() || null;
  const madeIn = [...new Set(text.match(/\b(TURKEY|CHINA|BANGLADESH|ITALY|INDIA|VIETNAM|PORTUGAL)\b/g) || [])];
  // Linked documents (a packing list references its order #s) + doc type + supplier notes.
  // Exclude fragments of dd/mm/yyyy dates (e.g. "01/2026" out of "27/01/2026") from linked refs.
  const dateFrags = new Set([...text.matchAll(/\d{1,2}\/(\d{1,2}\/\d{4})/g)].map((m) => m[1]));
  const linked = [...new Set([...text.matchAll(/\b(\d{2,4}\/\d{4})\b/g)].map((m) => m[1]))].filter(
    (r) => r !== ref && !dateFrags.has(r)
  );
  const docType = /Invoice number/i.test(text)
    ? 'invoice'
    : /PRO-?FORMA|Order number/i.test(text)
      ? 'order'
      : /Packing list/i.test(text)
        ? 'packing_list'
        : 'unknown';
  const supplierNote = text.match(/(MERCE MAGAZZINO [A-Z]+|ORDINE MAGAZZINO [A-Z]+)/)?.[1] || null;
  const poHit = text.match(/Customer PO\s*#?\s*[:\s]\s*([A-Z0-9-]{2,20})(?![\/\w])/i)?.[1] || null;
  const customerPo = poHit && /\d/.test(poHit) ? poHit : null;

  // Invoice total (pro-formas): EU number format 10.831,81 -> 10831.81.
  const tm =
    text.match(/Invoice total\s*(?:EUR|€)?[\s\S]{0,40}?([\d.]{1,12},\d{1,2})/i) ||
    text.match(/(?:Net amount|Total)[\s\S]{0,30}?([\d.]{1,12},\d{2})\s*€/i);
  const invoiceTotal = tm ? euNumber(tm[1]) : null;

  // An invoice prints its number as YEAR/NUMBER ("2026/667"); orders and packing lists print
  // NUMBER/YEAR. Normalise the invoice to NUMBER/YEAR so every reference reads the same way.
  const inv = text.match(/Invoice number[\s\S]{0,60}?\b(20\d{2})\/(\d{1,5})\b/i);
  const invoiceNumber = inv ? `${Number(inv[2])}/${inv[1]}` : null;

  // Every reference this document carries, each labelled with what kind of number it is.
  const refs = [];
  const addRef = (kind, value) => {
    if (value && !refs.some((r) => r.kind === kind && r.value === value)) refs.push({ kind, value });
  };
  if (docType === 'invoice') {
    addRef('supplier_invoice', invoiceNumber);
  } else if (docType === 'order') {
    addRef('italy_order', ref);
  } else if (docType === 'packing_list') {
    addRef('packing_list', text.match(/Packing list #[\s\S]{0,40}?(\d{2,4}\/\d{4})/i)?.[1] || ref);
    // A packing list names the order(s) it ships: "Orders 111/2026".
    for (const r of linked) addRef('italy_order', r);
  }
  if (customerPo) addRef('customer_po', customerPo);

  // Terms and shipping weights, when the document states them.
  const paymentTerms = text.match(/(\d{1,3}\s*%\s*IN ADVANCE[^\n]*)/i)?.[1]?.trim() || null;
  const incoterm = /EX\s*FACTORY|EX\s*WORKS|\bEXW\b/i.test(text) ? 'EXW' : fob ? `FOB ${fob}` : /\bFOB\b/.test(text) ? 'FOB' : null;
  const pallets = Number(text.match(/(\d{1,3})\s*PALLETS?/i)?.[1]) || null;
  const netKg = euNumberOrNull(text.match(/([\d.,]+)\s*KG/i)?.[1]);
  const grossKg = euNumberOrNull([...text.matchAll(/([\d.,]+)\s*KG/gi)][1]?.[1]);

  return {
    reference: docType === 'invoice' ? invoiceNumber : ref,
    origin, docDate, fob, madeIn, linked, docType, supplierNote, customerPo, invoiceTotal,
    refs, paymentTerms, incoterm, pallets, netKg, grossKg,
    // every money-looking figure printed on the document, to confirm a computed total against
    amounts: [...new Set([...text.matchAll(/\b\d{1,3}(?:\.\d{3})*,\d{1,2}\b/g)].map((m) => euNumber(m[0])))],
  };
}

// ---- XLSX (SheetJS) ----
function parseXlsx(buf) {
  const wb = XLSX.read(buf, { type: 'buffer' });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const grid = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: '' });
  const flat = grid.flat().filter((x) => typeof x === 'string').join('\n');

  // Find the header row: has a "Code" cell and a "Quantity" cell.
  let head = -1;
  let codeCol = -1;
  let qtyCol = -1;
  let descCol = -1;
  let extra = {};
  for (let i = 0; i < grid.length; i++) {
    const row = grid[i].map((c) => String(c).trim().toLowerCase());
    // "Code" on orders; "item Code4" on the Turkish packing lists.
    const ci = row.findIndex((c) => c === 'code' || /^item code/.test(c));
    const qi = row.findIndex((c) => /^quantity/.test(c));
    if (ci >= 0 && qi >= 0) {
      head = i;
      codeCol = ci;
      qtyCol = qi;
      descCol = row.findIndex((c) => /^description/.test(c));
      extra = {
        barcode: row.findIndex((c) => /^barcode/.test(c)),
        cartons: row.findIndex((c) => /quantity of master carton|^cartons?$/.test(c)),
        netKg: row.findIndex((c) => /^net weight/.test(c)),
        grossKg: row.findIndex((c) => /^gross weight/.test(c)),
        cbm: row.findIndex((c) => /^total cbm/.test(c)),
      };
      break;
    }
  }
  const lines = [];
  if (head >= 0) {
    for (let i = head + 1; i < grid.length; i++) {
      const sku = String(grid[i][codeCol] || '').trim().toUpperCase();
      const qty = Math.floor(cellNumber(grid[i][qtyCol]) || 0);
      if (!SKU_RE.test(sku) || qty <= 0) continue;
      const line = toLine(sku, qty, descCol >= 0 ? String(grid[i][descCol] || '') : '');
      const num = (col) => (col >= 0 && Number.isFinite(cellNumber(grid[i][col])) ? cellNumber(grid[i][col]) : null);
      if (extra.barcode >= 0) line.barcode = String(grid[i][extra.barcode] || '').trim() || null;
      line.cartons = num(extra.cartons ?? -1);
      line.netKg = num(extra.netKg ?? -1);
      line.grossKg = num(extra.grossKg ?? -1);
      line.cbm = num(extra.cbm ?? -1);
      lines.push(line);
    }
  } else {
    // Fallback: any row whose first SKU-looking cell has a plausible qty cell after it.
    for (const row of grid) {
      const sku = row.map((c) => String(c).trim().toUpperCase()).find((c) => SKU_RE.test(c));
      if (!sku) continue;
      const nums = row.map((c) => Number(c)).filter((n) => Number.isInteger(n) && n > 0 && n < 100000);
      if (nums.length) lines.push(toLine(sku, nums[0], ''));
    }
  }
  return { lines, meta: extractMeta(flat) };
}

// ---- PDF (pdf.js text items with coordinates) ----
async function pdfTextItems(buf) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(buf),
    isEvalSupported: false,
    useSystemFonts: true,
    disableFontFace: true,
  }).promise;
  const pages = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const tc = await page.getTextContent();
    pages.push(
      tc.items
        .filter((it) => it.str && it.str.trim())
        .map((it) => ({ str: it.str.trim(), x: it.transform[4], y: it.transform[5] }))
    );
  }
  return pages;
}

function parsePdfPage(items) {
  // Group into visual rows by Y (2.5pt tolerance), left→right.
  const rows = [];
  const sorted = [...items].sort((a, b) => b.y - a.y || a.x - b.x);
  for (const it of sorted) {
    const row = rows.find((r) => Math.abs(r.y - it.y) < 2.5);
    if (row) {
      row.cells.push(it);
      row.y = (row.y + it.y) / 2;
    } else {
      rows.push({ y: it.y, cells: [it] });
    }
  }
  for (const r of rows) r.cells.sort((a, b) => a.x - b.x);

  // Learn the quantity column from the header ("Q.ty" / "Quantity (PCS)").
  let qtyX = null;
  for (const r of rows) {
    const h = r.cells.find((c) => /^q\.?\s?ty\b|^quantity/i.test(c.str));
    if (h) {
      qtyX = h.x;
      break;
    }
  }

  const lines = [];
  for (const r of rows) {
    const skuCell = r.cells.find((c) => SKU_RE.test(c.str.toUpperCase()));
    if (!skuCell) continue;
    const sku = skuCell.str.toUpperCase();
    // Quantity: the integer cell nearest the qty column; else the first standalone integer
    // to the right of the SKU that isn't a barcode/HS code (those are 8+ digits).
    const ints = r.cells
      .filter((c) => c !== skuCell && /^\d{1,6}$/.test(c.str))
      .map((c) => ({ n: Number(c.str), x: c.x }));
    let qty = null;
    if (ints.length) {
      const pick =
        qtyX != null
          ? ints.reduce((best, c) => (Math.abs(c.x - qtyX) < Math.abs(best.x - qtyX) ? c : best))
          : ints[0];
      qty = pick.n;
    }
    // Invoice columns, when present: barcode (12-14 digits), Made In, HS code (6-10 digits),
    // currency, then unit price and line total to the right of the currency.
    const up = (c) => c.str.toUpperCase();
    const madeIn = r.cells.map(up).find((s) => COUNTRIES.includes(s)) || null;
    const barcode = r.cells.find((c) => /^\d{12,14}$/.test(c.str))?.str || null;
    const hsCode = r.cells.find((c) => c !== skuCell && /^\d{6,10}$/.test(c.str) && c.str !== barcode)?.str || null;
    const cur = r.cells.find((c) => /^(EUR|USD|TRY)$/.test(up(c)));
    const money = cur ? r.cells.filter((c) => c.x > cur.x && /^[\d.]+(,\d+)?$/.test(c.str)).map((c) => euNumber(c.str)) : [];
    const material = cur && madeIn ? r.cells.find((c) => c.x > r.cells.find((m) => up(m) === madeIn).x && !/^\d/.test(c.str) && c !== cur && up(c) !== madeIn)?.str || null : null;
    const desc = r.cells
      .filter((c) => c !== skuCell && !/^\d/.test(c.str) && !/€|%/.test(c.str) && c !== cur && up(c) !== madeIn && c.str !== material)
      .map((c) => c.str)
      .join(' ');
    lines.push({
      sku, qty, desc, madeIn, barcode, hsCode, material,
      currency: cur ? up(cur) : null,
      unitPrice: money.length >= 2 ? money[0] : null,
      lineTotal: money.length >= 2 ? money[1] : null,
    });
  }
  return { lines, qtyX };
}

async function parsePdf(buf) {
  const pages = await pdfTextItems(buf);
  const allText = pages.flat().map((i) => i.str).join('\n');
  const out = [];
  for (const items of pages) {
    const { lines } = parsePdfPage(items);
    for (const l of lines) {
      if (l.qty == null || l.qty <= 0 || l.qty > 100000) continue;
      const line = toLine(l.sku, l.qty, l.desc);
      for (const k of ['madeIn', 'barcode', 'hsCode', 'material', 'currency', 'unitPrice', 'lineTotal']) {
        if (l[k] != null) line[k] = l[k];
      }
      out.push(line);
    }
  }
  // Merge duplicate SKUs (packing lists repeat a SKU across pallets).
  const bySku = new Map();
  for (const l of out) {
    const ex = bySku.get(l.sku);
    if (ex) {
      ex.expected += l.expected;
      if (l.lineTotal != null) ex.lineTotal = (ex.lineTotal || 0) + l.lineTotal;
    } else bySku.set(l.sku, l);
  }
  return { lines: [...bySku.values()], meta: extractMeta(allText) };
}

export async function parseIntakeFile(filename, buf) {
  const name = String(filename || '').toLowerCase();
  const result = name.endsWith('.xlsx') || name.endsWith('.xls') ? parseXlsx(buf) : await parsePdf(buf);
  // Filename references (ORD_111_2026, PKLIST_640, INVOICE_667) fill in when the text has none.
  const meta = result.meta;
  const year = (meta.docDate || '').slice(0, 4) || String(new Date().getFullYear());
  const fromName = String(filename || '').toUpperCase().match(/\b(ORD|PKLIST|INVOICE)[_ -]?(\d{1,5})(?:[_ -](20\d{2}))?/);
  if (fromName) {
    const kind = { ORD: 'italy_order', PKLIST: 'packing_list', INVOICE: 'supplier_invoice' }[fromName[1]];
    if (!meta.refs.some((r) => r.kind === kind)) meta.refs.unshift({ kind, value: `${Number(fromName[2])}/${fromName[3] || year}` });
    if (meta.docType === 'unknown') meta.docType = { ORD: 'order', PKLIST: 'packing_list', INVOICE: 'invoice' }[fromName[1]];
  }
  if (!meta.reference && meta.refs[0]) meta.reference = meta.refs[0].value;

  // Checks: each priced line is qty x unit price, and the lines add up to the stated total.
  const priced = result.lines.filter((l) => l.unitPrice != null && l.lineTotal != null);
  const badLines = priced.filter((l) => Math.abs(l.expected * l.unitPrice - l.lineTotal) > 0.011).map((l) => l.sku);
  const linesTotal = priced.length ? Math.round(priced.reduce((s, l) => s + l.lineTotal, 0) * 100) / 100 : null;
  const sum = (k) => {
    const xs = result.lines.map((l) => l[k]).filter((x) => x != null);
    return xs.length ? Math.round(xs.reduce((s, x) => s + x, 0) * 1000) / 1000 : null;
  };
  // PDF text order is scrambled, so the printed total may not sit next to its label: accept
  // the lines' sum as the stated total when that exact figure is printed on the document.
  if (meta.invoiceTotal == null && linesTotal != null && (meta.amounts || []).includes(linesTotal)) meta.invoiceTotal = linesTotal;
  delete meta.amounts;
  const checks = {
    pricedLines: priced.length,
    badLines,
    linesTotal,
    totalMatches: linesTotal != null && meta.invoiceTotal != null ? Math.abs(linesTotal - meta.invoiceTotal) < 0.011 : null,
  };
  const totals = { units: result.lines.reduce((s, l) => s + l.expected, 0), cartons: sum('cartons'), netKg: sum('netKg') ?? meta.netKg, grossKg: sum('grossKg') ?? meta.grossKg, cbm: sum('cbm') };

  return {
    filename,
    ...meta,
    checks,
    totals,
    lines: result.lines,
    matchedCount: result.lines.filter((l) => l.matched).length,
    unmatchedCount: result.lines.filter((l) => !l.matched).length,
  };
}
