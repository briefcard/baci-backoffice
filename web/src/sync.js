// The offline-first live-sync engine.
//
// Lifecycle:
//   init()  → hydrate from IndexedDB (works fully offline) → if online, full refresh + open SSE
//   SSE     → inventory deltas patch state within seconds while connected
//   online  → IMMEDIATE inventory resync + reopen SSE the instant signal returns (owner requirement)
//   polling → 25s backstop whenever we're not "live"
//
// Status drives the freshness badge: 'live' | 'reconnecting' | 'offline'.
import { api } from './api.js';
import * as store from './db.js';
import { flushQueuedForms } from './formSections.js';

let state = { status: 'offline', syncedAt: null, snapshot: null, config: null, availability: {} };
const listeners = new Set();

export function subscribe(cb) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
export function getState() {
  return state;
}
function set(patch) {
  state = { ...state, ...patch };
  for (const l of listeners) l();
}

let es = null;
let pollTimer = null;

export async function init() {
  // 1) Hydrate from on-device cache first — instant, and works with no signal.
  const [snapshot, availability, syncedAt] = await Promise.all([
    store.loadSnapshot(),
    store.loadAvailability(),
    store.getSyncedAt(),
  ]);
  if (snapshot) {
    set({ snapshot, config: snapshot.config, availability, syncedAt, status: 'offline' });
  }

  window.addEventListener('online', onOnline);
  window.addEventListener('offline', onOffline);

  if (navigator.onLine) {
    await refresh();
    openStream();
    flushQueuedForms(); // send any order forms filled out while offline
  } else {
    set({ status: 'offline' });
  }
  startPolling();
}

// Full catalog + inventory pull.
export async function refresh() {
  try {
    const snapshot = await api.snapshot();
    const availability = {};
    for (const p of snapshot.products) for (const v of p.variants) availability[v.id] = v.available;
    await store.saveSnapshot(snapshot);
    await store.setAvailability(availability);
    set({ snapshot, config: snapshot.config, availability, syncedAt: Date.now(), status: 'live' });
  } catch {
    set({ status: navigator.onLine ? 'reconnecting' : 'offline' });
  }
}

// Lightweight inventory-only resync (used on reconnect — fast).
export async function refreshInventory() {
  try {
    const inv = await api.inventory();
    await store.setAvailability(inv.availability);
    set({
      availability: { ...state.availability, ...inv.availability },
      syncedAt: Date.now(),
      status: 'live',
    });
  } catch {
    /* leave status as-is */
  }
}

function openStream() {
  try {
    es?.close();
  } catch {
    /* noop */
  }
  es = new EventSource('/api/stream');
  es.onopen = () => set({ status: 'live' });
  es.onmessage = async (ev) => {
    try {
      const msg = JSON.parse(ev.data);
      if (msg.type === 'inventory') {
        await store.patchAvailability(msg.variantId, msg.available);
        set({
          availability: { ...state.availability, [msg.variantId]: msg.available },
          syncedAt: Date.now(),
          status: 'live',
        });
      } else if (msg.type === 'pending') {
        // A customer just submitted an order form — nudge the Pending tab to refresh.
        window.dispatchEvent(new CustomEvent('pending-order', { detail: msg }));
      }
    } catch {
      /* ignore malformed */
    }
  };
  es.onerror = () => {
    set({ status: navigator.onLine ? 'reconnecting' : 'offline' });
    try {
      es?.close();
    } catch {
      /* noop */
    }
    es = null;
    setTimeout(() => {
      if (navigator.onLine) openStream();
    }, 5000);
  };
}

// Signal regained → resync to LIVE immediately; do not wait for the next poll tick.
function onOnline() {
  set({ status: 'reconnecting' });
  refreshInventory();
  openStream();
  flushQueuedForms(); // offline-filled order forms go out the moment signal returns
}

function onOffline() {
  set({ status: 'offline' });
  try {
    es?.close();
  } catch {
    /* noop */
  }
  es = null;
}

function startPolling() {
  if (pollTimer) return;
  pollTimer = setInterval(() => {
    if (navigator.onLine && state.status !== 'live') refreshInventory();
  }, 25000);
}
