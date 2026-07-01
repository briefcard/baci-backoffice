// Access-token provider. Prefers a static env token (custom-app case); otherwise uses the
// OAuth token stored in Postgres after install. Cached in memory to avoid per-request DB hits.
import { cfg } from './config.js';
import { pool, q } from './db.js';

let cached = null;
let cachedScope = null;

// The OAuth scopes granted for the stored token (to detect when a re-auth is needed).
export async function getGrantedScopes(shop = cfg.shopifyStore) {
  if (cfg.shopifyToken) return cfg.scopes; // static token assumed to cover configured scopes
  if (cachedScope != null) return cachedScope;
  if (!pool) return null;
  try {
    const { rows } = await q('SELECT scope FROM shop_tokens WHERE shop = $1', [shop]);
    cachedScope = rows[0]?.scope || '';
    return cachedScope;
  } catch {
    return null;
  }
}

export async function getToken(shop = cfg.shopifyStore) {
  if (cfg.shopifyToken) return cfg.shopifyToken; // static Admin API token, if provided
  if (cached) return cached;
  if (!pool) return null;
  try {
    const { rows } = await q('SELECT access_token FROM shop_tokens WHERE shop = $1', [shop]);
    cached = rows[0]?.access_token || null;
    return cached;
  } catch {
    return null;
  }
}

export async function saveToken(shop, accessToken, scope) {
  cached = accessToken;
  cachedScope = scope || '';
  if (!pool) return;
  await q(
    `INSERT INTO shop_tokens (shop, access_token, scope, installed_at)
       VALUES ($1, $2, $3, now())
       ON CONFLICT (shop) DO UPDATE
       SET access_token = EXCLUDED.access_token, scope = EXCLUDED.scope, installed_at = now()`,
    [shop, accessToken, scope]
  );
}
