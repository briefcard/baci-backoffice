// Builds the order form's sections — the digital + print twins of the paper catalogue.
// Section order mirrors the printed form (config.formCollections, served by the backend);
// each product lands in its FIRST matching section only, and anything that doesn't belong to
// one of the catalogue collections goes to "Everything else" so new Shopify items never vanish.
import { api } from './api.js';
import { queueForm, takeQueuedForms, removeQueuedForm } from './db.js';

export function buildFormSections(products, formCollections) {
  const sections = (formCollections || []).map((c) => ({ handle: c.handle, title: c.title, products: [] }));
  const rest = { handle: '__rest', title: 'Everything else', products: [] };
  const byHandle = new Map(sections.map((s) => [s.handle, s]));

  for (const p of products || []) {
    const home = (p.collections || []).map((c) => byHandle.get(c.handle)).find(Boolean);
    (home || rest).products.push(p);
  }
  for (const s of sections) {
    s.products.sort(
      (a, b) => (a.productType || '').localeCompare(b.productType || '') || a.title.localeCompare(b.title)
    );
  }
  rest.products.sort((a, b) => a.title.localeCompare(b.title));
  return [...sections, rest].filter((s) => s.products.length > 0);
}

// --- Offline submission queue (kiosk tablets on spotty venue Wi-Fi) ---
// A submission that fails on network gets queued in IndexedDB and flushed when signal returns.

async function send(entry) {
  if (entry.kind === 'qr') return api.publicFormSubmit(entry.code, entry.payload);
  return api.submitOrderForm(entry.payload);
}

// Submit now, or queue for later if we're offline. Returns { queued: boolean }.
export async function submitOrQueue(entry) {
  try {
    await send(entry);
    return { queued: false };
  } catch (err) {
    // Only queue transport-level failures; real 4xx rejections should surface to the user.
    if (navigator.onLine && !/fetch|network|load/i.test(String(err?.message || ''))) throw err;
    await queueForm(entry);
    return { queued: true };
  }
}

let flushing = false;
export async function flushQueuedForms() {
  if (flushing || !navigator.onLine) return;
  flushing = true;
  try {
    for (const row of await takeQueuedForms()) {
      try {
        await send(row);
        await removeQueuedForm(row.qid);
      } catch {
        break; // still offline (or server down) — retry on the next signal
      }
    }
  } finally {
    flushing = false;
  }
}
