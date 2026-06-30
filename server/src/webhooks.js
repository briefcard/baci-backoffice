// Shopify webhook verification + inventory live-update handling.
import crypto from 'node:crypto';
import { cfg, sellableNumericLocationIds } from './config.js';
import { cache } from './snapshot.js';
import { broadcast } from './stream.js';
import { stockState } from './domain.js';

export function verifyShopifyHmac(rawBody, hmacHeader) {
  if (!cfg.webhookSecret) return false;
  const digest = crypto
    .createHmac('sha256', cfg.webhookSecret)
    .update(rawBody, 'utf8')
    .digest('base64');
  try {
    return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(hmacHeader || ''));
  } catch {
    return false;
  }
}

// Payload: { inventory_item_id, location_id, available }
// Only the Miami Warehouse counts toward sellable stock, so we ignore other locations.
// With a single sellable location, available-to-sell == that location's available.
export function handleInventoryLevelUpdate(payload) {
  if (!sellableNumericLocationIds.includes(String(payload.location_id))) return;
  const variantId = cache.invItemToVariant.get(String(payload.inventory_item_id));
  if (!variantId) return;
  const available = Number(payload.available) || 0;
  cache.availability.set(variantId, available);
  broadcast({
    type: 'inventory',
    variantId,
    available,
    state: stockState(available, cache.config.lowThreshold),
  });
}
