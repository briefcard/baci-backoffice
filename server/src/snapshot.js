// Builds the catalog + inventory snapshot from Shopify and holds it in memory.
// The PWA downloads this once, caches it on-device, then receives live deltas via SSE.
import fs from 'node:fs';
import { shopifyGraphQL } from './shopify.js';
import { cfg } from './config.js';
import { availableToSell } from './domain.js';

export const cache = {
  version: 0,
  builtAt: null,
  config: {
    discountPct: cfg.defaultDiscountPct,
    tiers: [],
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

async function loadConfig() {
  const data = await shopifyGraphQL(`query {
    shop {
      pct: metafield(namespace: "b2b", key: "wholesale_discount_pct") { value }
      tiers: metafield(namespace: "b2b", key: "volume_discount_tiers") { value }
    }
  }`);
  const pct = data.shop?.pct?.value;
  let tiers = [];
  try {
    tiers = JSON.parse(data.shop?.tiers?.value || '{}').tiers || [];
  } catch {
    /* keep [] */
  }
  cache.config = {
    discountPct: pct != null ? Number(pct) : cfg.defaultDiscountPct,
    tiers,
    lowThreshold: cfg.lowStockThreshold,
    currency: 'USD',
  };
}

const PRODUCTS_QUERY = `
query Snapshot($cursor: String) {
  products(first: 50, after: $cursor) {
    nodes {
      id
      title
      handle
      productType
      featuredImage { url }
      collections(first: 20) { nodes { handle title } }
      substitutes: metafield(namespace: "b2b", key: "substitutes") { value }
      variants(first: 100) {
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
            inventoryLevels(first: 10) {
              nodes {
                location { id }
                quantities(names: ["available"]) { name quantity }
              }
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
    const data = await shopifyGraphQL(PRODUCTS_QUERY, { cursor });
    const conn = data.products;
    for (const p of conn.nodes) {
      const variants = p.variants.nodes.map((v) => {
        const levels = v.inventoryItem?.inventoryLevels?.nodes || [];
        const inv = levels.map((l) => ({
          locationId: l.location.id,
          available: l.quantities?.find((q) => q.name === 'available')?.quantity ?? 0,
        }));
        const available = availableToSell(inv, cfg.sellableLocationIds);
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
        };
      });
      products.push({
        id: p.id,
        title: p.title,
        handle: p.handle,
        productType: p.productType || null,
        design: deriveDesign(p.title),
        collections: (p.collections?.nodes || [])
          .filter((c) => !cfg.excludedCollectionHandles.includes(c.handle))
          .map((c) => ({ handle: c.handle, title: c.title })),
        image: p.featuredImage?.url || null,
        substitutes: parseList(p.substitutes?.value),
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
  console.log(
    `[snapshot] built v${cache.version}: ${products.length} products, ${availability.size} variants`
  );
  return cache;
}

export function snapshotResponse() {
  return {
    version: cache.version,
    builtAt: cache.builtAt,
    config: cache.config,
    products: cache.products,
  };
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
  cache.products = seed.products || [];
  if (seed.config) cache.config = seed.config;
  const availability = new Map();
  for (const p of cache.products) for (const v of p.variants) availability.set(v.id, v.available ?? 0);
  cache.availability = availability;
  cache.version = Date.now();
  cache.builtAt = seed.builtAt || new Date().toISOString();
  return true;
}
