import { renderToString } from 'react-dom/server';
import React from 'react';
import fs from 'node:fs';
import { Lookbook, ReviewSheet } from './src/components/Lookbook.jsx';
import { OrderFormView } from './src/components/OrderFormView.jsx';
import { ShareFormSheet } from './src/components/CustomerPicker.jsx';
import { BlankFormDoc, OrderCopyDoc, RFQDoc } from './src/components/PrintDocs.jsx';

const catalog = JSON.parse(fs.readFileSync('/tmp/catalog.json', 'utf8'));
const availability = {};
for (const p of catalog.products) for (const v of p.variants) availability[v.id] = v.available ?? 0;

let failed = false;
const check = (name, fn) => {
  try {
    const html = renderToString(fn());
    console.log(`${name} OK — length`, html.length);
    return html;
  } catch (e) {
    failed = true;
    console.log(`${name} CRASH:`, e.message, '\n', (e.stack || '').split('\n').slice(0, 6).join('\n'));
    return '';
  }
};

// Generic lookbook (no link/customer): hero must be logo-only over the header image.
const generic = check('LOOKBOOK generic', () => React.createElement(Lookbook, { catalog, onStart: () => {} }));
if (generic && /Curated for/.test(generic)) {
  failed = true;
  console.log('LOOKBOOK generic FAIL: hero shows "Curated for" without a customer');
}

// Personalized lookbook (link with a company): hero must greet the customer.
const personalized = check('LOOKBOOK personalized', () =>
  React.createElement(Lookbook, {
    catalog: { ...catalog, link: { company: 'Smoke Test Co', note: 'Hi!' } },
    onStart: () => {},
    cta: 'Start your order ▸',
  })
);
// (SSR inserts comment markers between text nodes, so match the parts separately.)
if (personalized && !(/Curated for/.test(personalized) && /Smoke Test Co/.test(personalized))) {
  failed = true;
  console.log('LOOKBOOK personalized FAIL: hero missing "Curated for <company>"');
}

// Shoppable lookbook: qty inputs render on cards, and a non-empty shared qty state swaps the
// bottom bar to "Review & submit".
const firstVariantId = catalog.products[0]?.variants[0]?.id;
const shoppable = check('LOOKBOOK shoppable', () =>
  React.createElement(Lookbook, {
    catalog,
    onStart: () => {},
    availability,
    qty: { [firstVariantId]: 2 },
    onQty: () => {},
    mode: 'public',
    code: 'x',
    onReset: () => {},
  })
);
if (shoppable && !/lb-qty/.test(shoppable)) {
  failed = true;
  console.log('LOOKBOOK shoppable FAIL: no qty inputs rendered');
}
if (shoppable && !/Review/.test(shoppable)) {
  failed = true;
  console.log('LOOKBOOK shoppable FAIL: review bar missing with items in the order');
}

// --- Price-free lookbook (pricing: 'none') ---
// The fixture is the REAL server payload for a price-free link, so this also catches a UI that
// reads a price field the server no longer sends (which would render "$NaN").
const free = JSON.parse(fs.readFileSync('/tmp/catalog-nopricing.json', 'utf8'));
const freeVariantId = free.products[0]?.variants[0]?.id;

const priceFree = check('LOOKBOOK price-free', () =>
  React.createElement(Lookbook, {
    catalog: free,
    onStart: () => {},
    availability,
    qty: {},
    onQty: () => {},
    mode: 'public',
    code: 'x',
    onReset: () => {},
  })
);
if (priceFree) {
  // No money on the page, in any form — including the NaN a stripped price would produce.
  for (const [label, re] of [
    ['a currency amount', /\$\s?\d/],
    ['an MSRP label', /MSRP/i],
    ['NaN', /NaN/],
    ['a qty input', /lb-qty/],
    ['the wholesale-pricing subtitle', /wholesale pricing/i],
  ])
    if (re.test(priceFree)) {
      failed = true;
      console.log(`LOOKBOOK price-free FAIL: rendered ${label}`);
    }
  if (!/lb-heart/.test(priceFree)) {
    failed = true;
    console.log('LOOKBOOK price-free FAIL: no hearts rendered');
  }
  if (!/Tap ♡ to save pieces/.test(priceFree)) {
    failed = true;
    console.log('LOOKBOOK price-free FAIL: empty-state bar missing');
  }
}

// With a piece hearted, the bar becomes the quote CTA.
const hearted = check('LOOKBOOK price-free + hearted', () =>
  React.createElement(Lookbook, {
    catalog: free,
    onStart: () => {},
    availability,
    qty: { [freeVariantId]: 1 },
    onQty: () => {},
    mode: 'public',
    code: 'x',
    onReset: () => {},
  })
);
if (hearted) {
  if (!/Request a quote/.test(hearted)) {
    failed = true;
    console.log('LOOKBOOK price-free FAIL: hearted item did not surface the quote CTA');
  }
  // Adjacent text nodes are split by <!-- --> in SSR output — match the parts, not the phrase.
  if (!(/♥/.test(hearted) && /piece/.test(hearted) && /saved/.test(hearted))) {
    failed = true;
    console.log('LOOKBOOK price-free FAIL: saved count missing from the bar');
  }
  if (/\$\s?\d|NaN/.test(hearted)) {
    failed = true;
    console.log('LOOKBOOK price-free FAIL: pricing leaked once an item was hearted');
  }
}

// Multi-variant pieces get a heart PER VARIANT (so "the blue one" survives into the quote).
// The seed catalog is single-variant throughout, so synthesise one — the live catalog is full
// of them and this path would otherwise ship unrendered.
const multi = JSON.parse(JSON.stringify(free));
const mp = multi.products[0];
mp.variants = [
  { ...mp.variants[0], id: 'gid://v/1', sku: 'SMOKE.A', title: 'Cobalt' },
  { ...mp.variants[0], id: 'gid://v/2', sku: 'SMOKE.B', title: 'Amber' },
];
multi.products = [mp];
const multiHtml = check('LOOKBOOK price-free multi-variant', () =>
  React.createElement(Lookbook, {
    catalog: multi,
    onStart: () => {},
    availability: { 'gid://v/1': 5, 'gid://v/2': 0 },
    qty: { 'gid://v/2': 1 },
    onQty: () => {},
    mode: 'public',
    code: 'x',
    onReset: () => {},
  })
);
if (multiHtml) {
  if (!/lb-vars-heart/.test(multiHtml)) {
    failed = true;
    console.log('LOOKBOOK multi-variant FAIL: no per-variant heart rows');
  }
  if ((multiHtml.match(/lb-heart/g) || []).length < 2) {
    failed = true;
    console.log('LOOKBOOK multi-variant FAIL: expected a heart per variant');
  }
  if (!/Cobalt/.test(multiHtml) || !/Amber/.test(multiHtml)) {
    failed = true;
    console.log('LOOKBOOK multi-variant FAIL: variant names missing — buyer cannot say which one');
  }
  // An out-of-stock variant must NOT surface deposit/lead-time copy here: with no price shown,
  // "deposit" is a commitment the customer has not been asked to make yet.
  if (/deposit/i.test(multiHtml)) {
    failed = true;
    console.log('LOOKBOOK multi-variant FAIL: deposit language on a price-free card');
  }
  if (/\$\s?\d|NaN/.test(multiHtml)) {
    failed = true;
    console.log('LOOKBOOK multi-variant FAIL: pricing leaked');
  }
}

// The order form must survive a price-free payload without rendering "$NaN", even though a
// price-free share never routes to it.
const freeForm = check('FORM price-free', () =>
  React.createElement(OrderFormView, {
    snapshot: free,
    config: free.config,
    availability,
    mode: 'public',
    code: 'x',
    prefill: free.link,
  })
);
if (freeForm && /NaN/.test(freeForm)) {
  failed = true;
  console.log('FORM price-free FAIL: rendered NaN where a price would be');
}

check('FORM', () =>
  React.createElement(OrderFormView, {
    snapshot: catalog,
    config: catalog.config,
    availability,
    mode: 'public',
    code: 'x',
    prefill: catalog.link,
  })
);

// Share sheet without a customer (Form-stage path) and with one (cart path).
check('SHARE no-customer', () =>
  React.createElement(ShareFormSheet, {
    mainCollections: catalog.config.formCollections,
    initialSelected: catalog.config.formCollections.slice(0, 2).map((c) => c.handle),
    onClose: () => {},
  })
);
check('SHARE with-customer', () =>
  React.createElement(ShareFormSheet, {
    customer: { id: 'x', name: 'Smoke Test Co', email: 's@t.co', collectionsOfInterest: [] },
    mainCollections: catalog.config.formCollections,
    onClose: () => {},
  })
);

// ---------------------------------------------------------------------------------------
// CASE PACK / MOQ — a "Set of 6" priced per unit is the most expensive ambiguity on a
// wholesale form: the buyer reads 6 as six plates, the warehouse ships thirty-six. Every
// surface with a qty box or a printed line must state what one unit contains, so each one
// is asserted here rather than eyeballed once.
const fail = (msg) => {
  failed = true;
  console.log(msg);
};
// Text inside every element carrying `cls`. Needed because a bare /Set of 6/ also matches the
// product TITLE and a bare /30/ matches the phone number in the footer — both of which let a
// removed feature pass. (SSR splits adjacent text nodes with <!-- -->; strip those first.)
const textIn = (html, cls) =>
  // Backreference the tag name so the capture ends at the element's OWN closing tag — stopping
  // at the first `</` only read its first child, which silently passed a real assertion.
  [...html.matchAll(new RegExp(`<(\\w+)[^>]*class="[^"]*\\b${cls}\\b[^"]*"[^>]*>(.*?)</\\1>`, 'gs'))].map((m) =>
    m[2].replace(/<!--\s*-->/g, '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
  );
const someIn = (html, cls, re) => textIn(html, cls).some((t) => re.test(t));
const setProduct = catalog.products.find((p) => p.variants.some((v) => (v.casePack || 1) > 1));
const singleProduct = catalog.products.find((p) => p.variants.every((v) => (v.casePack || 1) === 1));
if (!setProduct || !singleProduct) {
  fail('PACK FIXTURE FAIL: need both a set and a single in /tmp/catalog.json to test against');
}
const setVariant = setProduct?.variants.find((v) => (v.casePack || 1) > 1);
const packOf = (v) => v.casePack;

// 1. Lookbook card states the pack, priced AND price-free (it describes goods, not a deal).
for (const [name, cat] of [['priced', catalog], ['price-free', free]]) {
  const html = check(`PACK lookbook ${name}`, () =>
    React.createElement(Lookbook, {
      catalog: cat,
      onStart: () => {},
      availability,
      qty: { [setVariant.id]: 3 },
      onQty: () => {},
      mode: 'public',
      code: 'x',
      onReset: () => {},
    })
  );
  if (!html) continue;
  if (!/lb-pack/.test(html)) fail(`PACK lookbook ${name} FAIL: no pack line on the cards`);
  if (!someIn(html, 'lb-pack', new RegExp(`^Set of ${packOf(setVariant)}\\b`)))
    fail(`PACK lookbook ${name} FAIL: no card's pack line says "Set of ${packOf(setVariant)}"`);
  if (!someIn(html, 'lb-pack', /^Sold individually/))
    fail(`PACK lookbook ${name} FAIL: single-piece cards do not say so`);
}

// 2. Priced lookbook turns units into pieces live, so nobody types 3 meaning 3 plates.
const packPriced = check('PACK lookbook pieces', () =>
  React.createElement(Lookbook, {
    catalog,
    onStart: () => {},
    availability,
    qty: { [setVariant.id]: 3 },
    onQty: () => {},
    mode: 'public',
    code: 'x',
    onReset: () => {},
  })
);
if (packPriced) {
  // (SSR splits adjacent text nodes with <!-- -->, so match the marker and the number apart.)
  if (!someIn(packPriced, 'lb-var-pieces', new RegExp(`=\\s*${packOf(setVariant) * 3} pieces`)))
    fail(`PACK lookbook FAIL: 3 units of a set of ${packOf(setVariant)} never resolves to ${packOf(setVariant) * 3} pieces`);
}

// 2b. The summary bar is the last number seen before submit — it must not let "units" read
//     as "pieces" on a cart that contains a set.
if (packPriced) {
  if (!someIn(packPriced, 'lb-bar', new RegExp(`${packOf(setVariant) * 3} pieces`, 'i')))
    fail('PACK lookbook FAIL: summary bar totals units without saying how many pieces that is');
}

// 3. Kiosk order form row: pack chip, minimum, and the piece count.
const packForm = check('PACK order form', () =>
  React.createElement(OrderFormView, {
    snapshot: catalog,
    config: catalog.config,
    availability,
    mode: 'public',
    code: 'x',
    qty: { [setVariant.id]: 2 },
    onQty: () => {},
  })
);
if (packForm) {
  if (!someIn(packForm, 'fpack', new RegExp(`^Set of ${packOf(setVariant)}\\b`)))
    fail('PACK form FAIL: no pack stated on the form rows');
  if (!someIn(packForm, 'fmoq', /^min \d+/)) fail('PACK form FAIL: no minimum on the form rows');
  if (!someIn(packForm, 'fpieces', new RegExp(`=\\s*${packOf(setVariant) * 2} pieces`)))
    fail('PACK form FAIL: no live piece count on a typed quantity');
}

// 3b. The ORDER FORM's own summary bar (the surface a shared link actually opens) must also
//     resolve units to pieces — same rule as the lookbook bar, different component.
const packFormBar = check('PACK order form bar', () =>
  React.createElement(OrderFormView, {
    snapshot: catalog,
    config: catalog.config,
    availability,
    mode: 'public',
    code: 'x',
    qty: { [setVariant.id]: 2 },
    onQty: () => {},
  })
);
if (packFormBar && !someIn(packFormBar, 'form-bar', new RegExp(`${packOf(setVariant) * 2} pieces`, 'i')))
  fail('PACK form FAIL: the submit bar totals units without saying how many pieces that is');

// 4. PRINTED blank order form — the paper the buyer writes on. Pack column + the sentence
//    that explains what the qty box counts.
const blank = check('PACK print blank form', () =>
  React.createElement(BlankFormDoc, { snapshot: catalog, config: catalog.config })
);
if (blank) {
  if (!/pf-th-pack/.test(blank)) fail('PACK print FAIL: blank form has no Pack column');
  if (!someIn(blank, 'pf-pack', new RegExp(`^\u00d7${packOf(setVariant)}$`)))
    fail('PACK print FAIL: blank form never prints a pack multiplier');
  if (!someIn(blank, 'pf-pack', /^each$/))
    fail('PACK print FAIL: blank form never marks a single-piece item as sold each');
  if (!someIn(blank, 'pf-moq', /^min \d+/)) fail('PACK print FAIL: blank form never prints a minimum');
  if (!/one unit is a set of six pieces/.test(blank))
    fail('PACK print FAIL: blank form never explains what the qty column counts');
}

// 5. PRINTED customer quote — unit price beside a line means the price of one PACK.
const line = {
  variantId: setVariant.id,
  title: setProduct.title,
  sku: setVariant.sku,
  qty: 2,
  unit: 100,
  msrp: 200,
  casePack: setVariant.casePack,
};
const quote = check('PACK print quote', () =>
  React.createElement(OrderCopyDoc, {
    order: { lines: { ready: [line], backorder: [] }, customer: null, notes: '', appliedPct: 0, result: null },
    currency: 'USD',
  })
);
if (quote) {
  if (!someIn(quote, 'pf-type', new RegExp(`^Set of ${packOf(setVariant)}$`)))
    fail('PACK print FAIL: quote line does not say the line is a set');
  if (!someIn(quote, 'pf-pieces', new RegExp(`^${packOf(setVariant) * 2} pcs$`)))
    fail(`PACK print FAIL: 2 sets never resolves to ${packOf(setVariant) * 2} pcs on the quote`);
}

// 6. PRINTED supplier RFQ — our pack, for the supplier to confirm against their cartoning.
const skuIndex = new Map([[String(setVariant.sku).toLowerCase(), { product: setProduct, variant: setVariant }]]);
const rfq = check('PACK print RFQ', () =>
  React.createElement(RFQDoc, {
    reference: 'RFQ TEST',
    origin: 'Baci Milano S.R.L.',
    notes: '',
    lines: [{ id: 1, sku: setVariant.sku, title: setProduct.title, expected: 5 }],
    skuIndex,
  })
);
if (rfq) {
  if (!/pf-th-pack/.test(rfq)) fail('PACK print FAIL: RFQ has no Pack column');
  if (!someIn(rfq, 'pf-pack', new RegExp(`^\u00d7${packOf(setVariant)}$`)))
    fail('PACK print FAIL: RFQ line never states our pack size');
  if (!someIn(rfq, 'pf-pieces', new RegExp(`^${packOf(setVariant) * 5} pcs$`)))
    fail(`PACK print FAIL: RFQ line never resolves 5 packs to ${packOf(setVariant) * 5} pcs`);
}

// 7. Under-minimum lines are FLAGGED and never blocking (owner's rule, 2026-09-21). Asserted
//    on the customer review sheet: the warning names the short line, offers the fix, and the
//    submit button stays enabled.
const shortSheet = check('PACK below-minimum flag', () =>
  React.createElement(ReviewSheet, {
    chosen: [{ product: setProduct, variant: { ...setVariant, moq: 3 }, qty: 1 }],
    availability,
    onBack: () => {},
    onDone: () => {},
    mode: 'public',
    code: 'x',
    setQ: () => {},
    config: catalog.config,
  })
);
if (shortSheet) {
  if (!/min-warn/.test(shortSheet)) fail('MIN FAIL: a line under its minimum raises no flag');
  if (!someIn(shortSheet, 'min-row', /qty 1 · min 3/))
    fail('MIN FAIL: the flag does not name the quantity and the minimum');
  if (!/Raise to/.test(shortSheet)) fail('MIN FAIL: the flag offers no one-tap fix');
  // The whole point of "show, do not block": submit must still be live.
  const submit = shortSheet.match(/<button class="primary"([^>]*)>/);
  if (submit && /disabled/.test(submit[1]))
    fail('MIN FAIL: submit is disabled on a short line — the owner asked for show, not block');
}

// A line AT its minimum must not be flagged (a warning that always fires is noise).
const okSheet = check('PACK at-minimum quiet', () =>
  React.createElement(ReviewSheet, {
    chosen: [{ product: setProduct, variant: { ...setVariant, moq: 3 }, qty: 3 }],
    availability,
    onBack: () => {},
    onDone: () => {},
    mode: 'public',
    code: 'x',
    setQ: () => {},
    config: catalog.config,
  })
);
if (okSheet && /min-warn/.test(okSheet)) fail('MIN FAIL: a line AT its minimum is flagged anyway');

process.exit(failed ? 1 : 0);
