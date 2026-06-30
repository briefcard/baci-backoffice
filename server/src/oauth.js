// Shopify OAuth (Authorization Code grant). Exchanges the app's Client ID + Secret for a
// permanent offline Admin API access token by installing the app on the store once.
import crypto from 'node:crypto';
import { cfg } from './config.js';

export const SHOP_RE = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;

export function buildInstallUrl(shop, state) {
  const params = new URLSearchParams({
    client_id: cfg.apiKey,
    scope: cfg.scopes,
    redirect_uri: `${cfg.appUrl}/auth/shopify/callback`,
    state,
  });
  return `https://${shop}/admin/oauth/authorize?${params.toString()}`;
}

// Verify the HMAC Shopify appends to the OAuth callback (signed with the app's Client Secret).
export function verifyOAuthHmac(query) {
  const { hmac, signature, ...rest } = query;
  const message = Object.keys(rest)
    .sort()
    .map((k) => `${k}=${rest[k]}`)
    .join('&');
  const digest = crypto.createHmac('sha256', cfg.apiSecret).update(message).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(digest, 'utf8'), Buffer.from(String(hmac || ''), 'utf8'));
  } catch {
    return false;
  }
}

// Exchange the authorization code for a permanent offline access token.
export async function exchangeToken(shop, code) {
  const res = await fetch(`https://${shop}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: cfg.apiKey, client_secret: cfg.apiSecret, code }),
  });
  if (!res.ok) throw new Error(`Token exchange failed ${res.status}: ${await res.text()}`);
  return res.json(); // { access_token, scope }
}
