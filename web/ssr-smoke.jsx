import { renderToString } from 'react-dom/server';
import React from 'react';
import fs from 'node:fs';
import { Lookbook } from './src/components/Lookbook.jsx';
import { OrderFormView } from './src/components/OrderFormView.jsx';

const catalog = JSON.parse(fs.readFileSync('/tmp/catalog.json', 'utf8'));
const availability = {};
for (const p of catalog.products) for (const v of p.variants) availability[v.id] = v.available ?? 0;

try {
  const html = renderToString(React.createElement(Lookbook, { catalog, onStart: () => {} }));
  console.log('LOOKBOOK OK — length', html.length);
} catch (e) {
  console.log('LOOKBOOK CRASH:', e.message, '\n', (e.stack || '').split('\n').slice(0, 6).join('\n'));
}
try {
  const html = renderToString(
    React.createElement(OrderFormView, {
      snapshot: catalog,
      config: catalog.config,
      availability,
      mode: 'public',
      code: 'x',
      prefill: catalog.link,
    })
  );
  console.log('FORM OK — length', html.length);
} catch (e) {
  console.log('FORM CRASH:', e.message, '\n', (e.stack || '').split('\n').slice(0, 6).join('\n'));
}
