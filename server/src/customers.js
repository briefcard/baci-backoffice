// Customer search + resolve, so reps pick an existing Shopify customer instead of retyping
// their info and accidentally creating a duplicate. "Repeat" customers (for deposit tiering)
// are identified server-side by a "B2B" tag on the Shopify customer record — never trust the
// client's word for this, since it affects how much deposit is required.
import { shopifyGraphQL } from './shopify.js';

const CUSTOMER_FIELDS = `id displayName firstName lastName tags
  defaultEmailAddress { emailAddress }
  defaultPhoneNumber { phoneNumber }`;

const SEARCH_CUSTOMERS = `query($q: String!) {
  customers(first: 8, query: $q) { nodes { ${CUSTOMER_FIELDS} } }
}`;

const GET_CUSTOMER_BY_ID = `query($id: ID!) { customer(id: $id) { ${CUSTOMER_FIELDS} } }`;

const FIND_CUSTOMER_BY_EMAIL = `query($q: String!) {
  customers(first: 1, query: $q) { nodes { ${CUSTOMER_FIELDS} } }
}`;

const CREATE_CUSTOMER = `mutation($input: CustomerInput!) {
  customerCreate(input: $input) { customer { ${CUSTOMER_FIELDS} } userErrors { field message } }
}`;

function toClientShape(c) {
  if (!c) return null;
  return {
    id: c.id,
    name: c.displayName || [c.firstName, c.lastName].filter(Boolean).join(' ') || '',
    email: c.defaultEmailAddress?.emailAddress || '',
    phone: c.defaultPhoneNumber?.phoneNumber || '',
    isB2B: isRepeatCustomer(c.tags),
  };
}

// "Repeat"/B2B tier = the Shopify customer record carries a tag containing "b2b" (owner's rule,
// 2026-07-01). Checked here, server-side, so a rep can't influence their own deposit tier.
export function isRepeatCustomer(tags) {
  return Array.isArray(tags) && tags.some((t) => /b2b/i.test(String(t)));
}

export async function searchCustomers(q) {
  const data = await shopifyGraphQL(SEARCH_CUSTOMERS, { q });
  return (data.customers?.nodes || []).map(toClientShape);
}

async function findOrCreateCustomer({ email, name, phone }) {
  const e = String(email).trim();
  const found = await shopifyGraphQL(FIND_CUSTOMER_BY_EMAIL, { q: `email:${e}` });
  if (found.customers?.nodes?.[0]) return found.customers.nodes[0];

  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  const input = { email: e };
  if (parts.length > 1) {
    input.firstName = parts.slice(0, -1).join(' ');
    input.lastName = parts[parts.length - 1];
  } else if (parts.length === 1) {
    input.firstName = parts[0];
  }
  if (phone) input.phone = String(phone).trim();

  let res = await shopifyGraphQL(CREATE_CUSTOMER, { input });
  if (res.customerCreate?.userErrors?.length && input.phone) {
    delete input.phone; // phone formats are often rejected — retry without it
    res = await shopifyGraphQL(CREATE_CUSTOMER, { input });
  }
  return res.customerCreate?.customer || null;
}

// Resolve a cart's `customer` field to a real Shopify customer, server-authoritative.
// - `customer.id` (rep picked an existing match from search) → fetch fresh (don't trust cached tags).
// - otherwise → dedupe-by-email or create, same as before.
// Returns { customerId, isRepeat } — isRepeat drives the backorder deposit tier.
export async function resolveCustomer(customer) {
  if (!customer) return { customerId: null, isRepeat: false };
  if (customer.id) {
    try {
      const data = await shopifyGraphQL(GET_CUSTOMER_BY_ID, { id: customer.id });
      if (data.customer) return { customerId: data.customer.id, isRepeat: isRepeatCustomer(data.customer.tags) };
    } catch {
      /* fall through to email path below */
    }
  }
  if (!customer.email) return { customerId: null, isRepeat: false };
  try {
    const rec = await findOrCreateCustomer(customer);
    return { customerId: rec?.id || null, isRepeat: isRepeatCustomer(rec?.tags) };
  } catch {
    return { customerId: null, isRepeat: false };
  }
}
