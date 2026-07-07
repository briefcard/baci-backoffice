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
  return { reference: ref, origin };
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
  for (let i = 0; i < grid.length; i++) {
    const row = grid[i].map((c) => String(c).trim().toLowerCase());
    const ci = row.findIndex((c) => c === 'code');
    const qi = row.findIndex((c) => /^quantity/.test(c));
    if (ci >= 0 && qi >= 0) {
      head = i;
      codeCol = ci;
      qtyCol = qi;
      descCol = row.findIndex((c) => /^description/.test(c));
      break;
    }
  }
  const lines = [];
  if (head >= 0) {
    for (let i = head + 1; i < grid.length; i++) {
      const sku = String(grid[i][codeCol] || '').trim().toUpperCase();
      const qty = Math.floor(Number(grid[i][qtyCol]) || 0);
      if (!SKU_RE.test(sku) || qty <= 0) continue;
      lines.push(toLine(sku, qty, descCol >= 0 ? String(grid[i][descCol] || '') : ''));
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
    const desc = r.cells
      .filter((c) => c !== skuCell && !/^\d/.test(c.str) && !/€|%/.test(c.str))
      .map((c) => c.str)
      .join(' ');
    lines.push({ sku, qty, desc });
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
      out.push(toLine(l.sku, l.qty, l.desc));
    }
  }
  // Merge duplicate SKUs (packing lists repeat a SKU across pallets).
  const bySku = new Map();
  for (const l of out) {
    const ex = bySku.get(l.sku);
    if (ex) ex.expected += l.expected;
    else bySku.set(l.sku, l);
  }
  return { lines: [...bySku.values()], meta: extractMeta(allText) };
}

export async function parseIntakeFile(filename, buf) {
  const name = String(filename || '').toLowerCase();
  const result = name.endsWith('.xlsx') || name.endsWith('.xls') ? parseXlsx(buf) : await parsePdf(buf);
  return {
    filename,
    ...result.meta,
    lines: result.lines,
    matchedCount: result.lines.filter((l) => l.matched).length,
    unmatchedCount: result.lines.filter((l) => !l.matched).length,
  };
}
