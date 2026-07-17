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
