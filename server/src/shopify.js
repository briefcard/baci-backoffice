// Thin Shopify Admin GraphQL client. The access token lives ONLY server-side.
import { cfg } from './config.js';
import { getToken } from './tokens.js';

export async function shopifyGraphQL(query, variables = {}) {
  const token = await getToken();
  if (!token) {
    throw new Error('No Shopify access token — app not installed. Visit /auth/shopify/install.');
  }
  const url = `https://${cfg.shopifyStore}/admin/api/${cfg.apiVersion}/graphql.json`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': token,
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) {
    throw new Error(`Shopify ${res.status}: ${await res.text()}`);
  }
  const json = await res.json();
  if (json.errors) {
    throw new Error(`Shopify GraphQL errors: ${JSON.stringify(json.errors)}`);
  }
  return json.data;
}
