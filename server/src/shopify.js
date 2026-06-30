// Thin Shopify Admin GraphQL client. The Admin token lives ONLY here, server-side.
import { cfg } from './config.js';

export async function shopifyGraphQL(query, variables = {}) {
  const url = `https://${cfg.shopifyStore}/admin/api/${cfg.apiVersion}/graphql.json`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': cfg.shopifyToken,
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
