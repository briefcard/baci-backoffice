// Builds the catalog + inventory snapshot from Shopify and holds it in memory.
// The PWA downloads this once, caches it on-device, then receives live deltas via SSE.
import fs from 'node:fs';
import { shopifyGraphQL } from './shopify.js';
import { cfg, MATERIALS } from './config.js';
import { availableToSell } from './domain.js';

export const cache = {
  version: 0,
  builtAt: null,
  showcase: false,
  config: {
    discountPct: cfg.defaultDiscountPct,
    tiers: [],
    depositPct: { new_customer: cfg.defaultDepositNewPct, repeat_customer: cfg.defaultDepositRepeatPct },
    lowThreshold: cfg.lowStockThreshold,
    currency: 'USD',
  },
  products: [],
  availability: new Map(), // variantId -> available-to-sell (sellable locations)
  invItemToVariant: new Map(), // numeric inventory_item_id -> variantId
};

function parseMoney(value) {
  if (value == null || value === '') return null;
  try {
    const o = JSON.parse(value);
    if (o && o.amount != null) return Number(o.amount);
  } catch {
    /* not json */
  }
  const n = Number(value);
  return Number.isNaN(n) ? null : n;
}

function parseList(value) {
  try {
    return JSON.parse(value || '[]');
  } catch {
    return [];
  }
}

// "Design" = the pattern/line, reliably the last dash-separated segment of the title
// (e.g. "Set of 6 Water Glasses - Orange - Aqua" → "Aqua").
function deriveDesign(title) {
  if (!title) return null;
  const parts = title.split(/\s[–—-]\s/);
  return parts.length > 1 ? parts[parts.length - 1].trim() : null;
}

// Material(s) inferred from product tags (e.g. "Acrylic", "Porcelain").
function deriveMaterials(tags, design) {
  const found = new Set();
  for (const t of tags || []) {
    const tl = String(t).toLowerCase();
    for (const m of MATERIALS) if (tl.includes(m.toLowerCase())) found.add(m);
    if (/\bcpc\b/.test(tl)) found.add('Polycarbonate'); // CPC = polycarbonate
  }
  // Crystal Touch is polycarbonate (CPC), not glass/crystal.
  if (/crystal touch/i.test(design || '') || (tags || []).some((t) => /crystal touch/i.test(t))) {
    found.add('Polycarbonate');
  }
  return [...found];
}

async function loadConfig() {
  const data = await shopifyGraphQL(`query {
    shop {
      pct: metafield(namespace: "b2b", key: "wholesale_discount_pct") { value }
      tiers: metafield(namespace: "b2b", key: "volume_discount_tiers") { value }
      deposit: metafield(namespace: "b2b", key: "deposit_pct") { value }
    }
  }`);
  const pct = data.shop?.pct?.value;
  let tiers = [];
  try {
    tiers = JSON.parse(data.shop?.tiers?.value || '{}').tiers || [];
  } catch {
    /* keep [] */
  }
  let depositPct = { new_customer: cfg.defaultDepositNewPct, repeat_customer: cfg.defaultDepositRepeatPct };
  try {
    const d = JSON.parse(data.shop?.deposit?.value || '{}');
    depositPct = {
      new_customer: d.new_customer != null ? Number(d.new_customer) : depositPct.new_customer,
      repeat_customer: d.repeat_customer != null ? Number(d.repeat_customer) : depositPct.repeat_customer,
    };
  } catch {
    /* keep defaults */
  }
  cache.config = {
    discountPct: pct != null ? Number(pct) : cfg.defaultDiscountPct,
    tiers,
    depositPct,
    lowThreshold: cfg.lowStockThreshold,
    currency: 'USD',
  };
}

const PRODUCTS_QUERY = `
query Snapshot($cursor: String, $loc: ID!) {
  products(first: 30, after: $cursor) {
    nodes {
      id
      title
      handle
      productType
      featuredImage { url }
      tags
      collections(first: 12) { nodes { handle title } }
      substitutes: metafield(namespace: "b2b", key: "substitutes") { value }
      binLoc: metafield(namespace: "warehouse", key: "bin_location") { value }
      origin: metafield(namespace: "custom", key: "country_of_origin") { value }
      variants(first: 40) {
        nodes {
          id
          sku
          title
          barcode
          price
          wholesale: metafield(namespace: "b2b", key: "wholesale_price") { value }
          casePack: metafield(namespace: "b2b", key: "case_pack") { value }
          moq: metafield(namespace: "b2b", key: "min_order_qty") { value }
          eta: metafield(namespace: "b2b", key: "restock_eta") { value }
          inventoryItem {
            id
            inventoryLevel(locationId: $loc) {
              quantities(names: ["available", "incoming"]) { name quantity }
            }
          }
        }
      }
    }
    pageInfo { hasNextPage endCursor }
  }
}`;

export async function buildSnapshot() {
  await loadConfig();
  const products = [];
  const availability = new Map();
  const invItemToVariant = new Map();
  let cursor = null;

  do {
    const data = await shopifyGraphQL(PRODUCTS_QUERY, { cursor, loc: cfg.sellableLocationIds[0] });
    const conn = data.products;
    for (const p of conn.nodes) {
      // Exclude products with "B2B" in the title or any tag (internal/B2B-only SKUs).
      if (/b2b/i.test(p.title || '') || (p.tags || []).some((t) => /b2b/i.test(t))) continue;
      const variants = p.variants.nodes.map((v) => {
        // We fetch only the sellable (Miami) location's level, so that IS available-to-sell.
        // `incoming` = units on order / on the way to us (BackOrder flag).
        const lvl = v.inventoryItem?.inventoryLevel;
        const qn = (name) => lvl?.quantities?.find((q) => q.name === name)?.quantity ?? 0;
        const available = qn('available');
        const incoming = qn('incoming');
        availability.set(v.id, available);
        if (v.inventoryItem?.id) {
          invItemToVariant.set(String(v.inventoryItem.id).split('/').pop(), v.id);
        }
        return {
          id: v.id,
          sku: v.sku,
          title: v.title,
          barcode: v.barcode,
          retailPrice: Number(v.price),
          wholesaleOverride: parseMoney(v.wholesale?.value),
          casePack: v.casePack?.value ? Number(v.casePack.value) : null,
          moq: v.moq?.value ? Number(v.moq.value) : null,
          restockEta: v.eta?.value || null,
          available,
          incoming,
        };
      });
      products.push({
        id: p.id,
        title: p.title,
        handle: p.handle,
        productType: p.productType || null,
        design: deriveDesign(p.title),
        materials: deriveMaterials(p.tags, deriveDesign(p.title)),
        collections: (p.collections?.nodes || [])
          .filter((c) => !cfg.excludedCollectionHandles.includes(c.handle))
          .map((c) => ({ handle: c.handle, title: c.title })),
        image: p.featuredImage?.url || null,
        substitutes: parseList(p.substitutes?.value),
        binLocation: parseList(p.binLoc?.value),
        countryOfOrigin: p.origin?.value || null,
        variants,
      });
    }
    cursor = conn.pageInfo.hasNextPage ? conn.pageInfo.endCursor : null;
  } while (cursor);

  cache.products = products;
  cache.availability = availability;
  cache.invItemToVariant = invItemToVariant;
  cache.version = Date.now();
  cache.builtAt = new Date().toISOString();
  cache.showcase = false;
  console.log(
    `[snapshot] built v${cache.version}: ${products.length} products, ${availability.size} variants`
  );
  return cache;
}

// Order-form sections in the printed catalogue's order, with display titles resolved from the
// curated main-collections list (fallback: prettified handle for anything not in it).
function formCollections() {
  const titles = new Map(cfg.mainCollections.map((c) => [c.handle, c.title]));
  return cfg.orderFormCollections.map((handle) => ({
    handle,
    title: titles.get(handle) || handle.replace(/-/g, ' ').replace(/\b\w/g, (m) => m.toUpperCase()),
  }));
}

// Overlay set by the inbound-shipments module (admin back office): per-variant incoming totals
// + earliest ETA from open shipments. Shopify-native incoming/restock_eta still show when
// present; our shipment data fills the gaps so BackOrder info on the floor is reliable even
// before anything is entered in Shopify itself.
let inboundOverlay = { incoming: new Map(), eta: new Map() };
export function setInboundOverlay(o) {
  if (o) inboundOverlay = o;
}

function overlaidProducts() {
  if (!inboundOverlay.incoming.size && !inboundOverlay.eta.size) return cache.products;
  return cache.products.map((p) => ({
    ...p,
    variants: p.variants.map((v) => {
      const inc = inboundOverlay.incoming.get(v.id) || 0;
      const eta = inboundOverlay.eta.get(v.id) || null;
      if (!inc && !eta) return v;
      return {
        ...v,
        incoming: Math.max(v.incoming || 0, inc),
        restockEta: v.restockEta || eta,
      };
    }),
  }));
}

export function snapshotResponse() {
  return {
    version: cache.version,
    builtAt: cache.builtAt,
    showcase: cache.showcase,
    config: { ...cache.config, leadTime: cfg.leadTimeText, mainCollections: cfg.mainCollections, formCollections: formCollections() },
    products: overlaidProducts(),
  };
}

// What the PUBLIC (QR) order form gets: same catalog + unit-pricing inputs, but WITHOUT the
// rep-only negotiation levers (volume ladder, deposit tiers) — those never render on the form.
export function publicFormResponse() {
  const r = snapshotResponse();
  const { tiers, depositPct, ...safe } = r.config;
  return { ...r, config: { ...safe, tiers: [] } };
}

export function availabilityResponse() {
  return { version: cache.version, availability: Object.fromEntries(cache.availability) };
}

// Showcase fallback: when no Shopify token is configured, serve a baked real-data snapshot
// (server/seed-snapshot.json) so the UI is fully browsable for demos. Live data overrides this.
export function loadSeed() {
  const url = new URL('../seed-snapshot.json', import.meta.url);
  if (!fs.existsSync(url)) return false;
  const seed = JSON.parse(fs.readFileSync(url, 'utf8'));
  cache.products = (seed.products || []).filter((p) => !/b2b/i.test(p.title || ''));
  if (seed.config) {
    cache.config = {
      depositPct: { new_customer: cfg.defaultDepositNewPct, repeat_customer: cfg.defaultDepositRepeatPct },
      ...seed.config,
    };
  }
  const availability = new Map();
  for (const p of cache.products) for (const v of p.variants) availability.set(v.id, v.available ?? 0);
  cache.availability = availability;
  cache.version = Date.now();
  cache.builtAt = seed.builtAt || new Date().toISOString();
  cache.showcase = true;
  return true;
}
