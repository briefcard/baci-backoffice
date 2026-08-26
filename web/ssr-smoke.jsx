import { renderToString } from 'react-dom/server';
import React from 'react';
import fs from 'node:fs';
import { Lookbook } from './src/components/Lookbook.jsx';
import { OrderFormView } from './src/components/OrderFormView.jsx';
import { ShareFormSheet } from './src/components/CustomerPicker.jsx';

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

process.exit(failed ? 1 : 0);
