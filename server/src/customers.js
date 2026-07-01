// Customer search + resolve + profile upsert, so reps pick an existing Shopify customer instead
// of retyping their info (avoids duplicates) and can fill out a wholesale profile — location,
// specialty, collections of interest, plus the real ship-to address — right from the order flow.
//
// "Repeat"/B2B tier (for the backorder deposit) is decided SERVER-SIDE from the customer's live
// Shopify tags — never trusted from the client.
import { shopifyGraphQL } from './shopify.js';

const ONLINE_ONLY = 'ONLINE ONLY';

const CUSTOMER_FIELDS = `id displayName firstName lastName tags
  defaultEmailAddress { emailAddress }
  defaultPhoneNumber { phoneNumber }
  defaultAddress { address1 address2 city provinceCode zip countryCodeV2 }
  loc: metafield(namespace: "b2b", key: "location") { value }
  spec: metafield(namespace: "b2b", key: "specialty") { value }
  coi: metafield(namespace: "b2b", key: "collections_of_interest") { value }`;

const SEARCH_CUSTOMERS = `query($q: String!) {
  customers(first: 8, query: $q) { nodes { ${CUSTOMER_FIELDS} } }
}`;

const GET_CUSTOMER_BY_ID = `query($id: ID!) { customer(id: $id) { ${CUSTOMER_FIELDS} } }`;

const FIND_CUSTOMER_BY_EMAIL = `query($q: String!) {
  customers(first: 1, query: $q) { nodes { ${CUSTOMER_FIELDS} } }
}`;

const CUSTOMER_CREATE = `mutation($input: CustomerInput!) {
  customerCreate(input: $input) { customer { ${CUSTOMER_FIELDS} } userErrors { field message } }
}`;

const CUSTOMER_UPDATE = `mutation($input: CustomerInput!) {
  customerUpdate(input: $input) { customer { ${CUSTOMER_FIELDS} } userErrors { field message } }
}`;

const ADDRESS_CREATE = `mutation($customerId: ID!, $address: MailingAddressInput!) {
  customerAddressCreate(customerId: $customerId, address: $address, setAsDefault: true) {
    address { id } userErrors { field message }
  }
}`;

function parseList(value) {
  try {
    const v = JSON.parse(value || '[]');
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function toClientShape(c) {
  if (!c) return null;
  const a = c.defaultAddress || {};
  return {
    id: c.id,
    name: c.displayName || [c.firstName, c.lastName].filter(Boolean).join(' ') || '',
    email: c.defaultEmailAddress?.emailAddress || '',
    phone: c.defaultPhoneNumber?.phoneNumber || '',
    isB2B: isRepeatCustomer(c.tags),
    location: c.loc?.value || '',
    specialty: c.spec?.value || '',
    collectionsOfInterest: parseList(c.coi?.value),
    onlineOnly: (c.loc?.value || '').trim().toUpperCase() === ONLINE_ONLY,
    address: {
      address1: a.address1 || '',
      address2: a.address2 || '',
      city: a.city || '',
      province: a.provinceCode || '',
      zip: a.zip || '',
      country: a.countryCodeV2 || 'US',
    },
  };
}

// "Repeat"/B2B tier = the Shopify customer record carries a tag containing "b2b" (owner's rule).
export function isRepeatCustomer(tags) {
  return Array.isArray(tags) && tags.some((t) => /b2b/i.test(String(t)));
}

export async function searchCustomers(q) {
  const data = await shopifyGraphQL(SEARCH_CUSTOMERS, { q });
  return (data.customers?.nodes || []).map(toClientShape);
}

// Split a "First Last" style name into Shopify's first/last fields.
function splitName(name, input) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length > 1) {
    input.firstName = parts.slice(0, -1).join(' ');
    input.lastName = parts[parts.length - 1];
  } else if (parts.length === 1) {
    input.firstName = parts[0];
  }
}

// Build the b2b.* metafield inputs from a profile, only for the fields actually provided.
function profileMetafields(profile) {
  const mf = [];
  const loc = profile.onlineOnly ? ONLINE_ONLY : (profile.location || '').trim();
  if (loc) mf.push({ namespace: 'b2b', key: 'location', type: 'single_line_text_field', value: loc });
  if ((profile.specialty || '').trim())
    mf.push({ namespace: 'b2b', key: 'specialty', type: 'single_line_text_field', value: profile.specialty.trim() });
  if (Array.isArray(profile.collectionsOfInterest) && profile.collectionsOfInterest.length)
    mf.push({
      namespace: 'b2b',
      key: 'collections_of_interest',
      type: 'list.single_line_text_field',
      value: JSON.stringify(profile.collectionsOfInterest),
    });
  return mf;
}

// If the rep entered a real street address (and the customer isn't online-only), write it as the
// customer's default Shopify address so orders ship there. Best-effort: never fails the upsert.
async function maybeSetAddress(customerId, profile) {
  const a = profile.address || {};
  if (profile.onlineOnly || !a.address1 || !a.city) return;
  const address = {
    address1: a.address1,
    city: a.city,
    zip: a.zip || undefined,
    provinceCode: a.province || undefined,
    countryCode: (a.country || 'US').toUpperCase(),
  };
  if (a.address2) address.address2 = a.address2;
  try {
    await shopifyGraphQL(ADDRESS_CREATE, { customerId, address });
  } catch {
    /* address is best-effort; the profile itself is already saved */
  }
}

async function findByEmail(email) {
  const found = await shopifyGraphQL(FIND_CUSTOMER_BY_EMAIL, { q: `email:${String(email).trim()}` });
  return found.customers?.nodes?.[0] || null;
}

// Create or update a full customer profile from the order flow. Matches an existing customer by
// id (rep picked one) or email (dedupe) before creating. Returns the saved customer client shape.
export async function upsertCustomer(profile = {}) {
  const email = String(profile.email || '').trim();
  let existing = null;
  if (profile.id) {
    existing = { id: profile.id };
  } else if (email) {
    const rec = await findByEmail(email);
    if (rec) existing = rec;
  }

  const input = { metafields: profileMetafields(profile) };
  if (email) input.email = email;
  if (profile.phone) input.phone = String(profile.phone).trim();
  splitName(profile.name, input);

  let saved;
  if (existing?.id) {
    input.id = existing.id;
    let res = await shopifyGraphQL(CUSTOMER_UPDATE, { input });
    if (res.customerUpdate?.userErrors?.length && input.phone) {
      delete input.phone; // phone formats are often rejected — retry without it
      res = await shopifyGraphQL(CUSTOMER_UPDATE, { input });
    }
    if (res.customerUpdate?.userErrors?.length) {
      throw new Error(res.customerUpdate.userErrors.map((e) => e.message).join('; '));
    }
    saved = res.customerUpdate?.customer;
  } else {
    let res = await shopifyGraphQL(CUSTOMER_CREATE, { input });
    if (res.customerCreate?.userErrors?.length && input.phone) {
      delete input.phone;
      res = await shopifyGraphQL(CUSTOMER_CREATE, { input });
    }
    if (res.customerCreate?.userErrors?.length) {
      throw new Error(res.customerCreate.userErrors.map((e) => e.message).join('; '));
    }
    saved = res.customerCreate?.customer;
  }

  if (saved?.id) await maybeSetAddress(saved.id, profile);
  // Re-fetch so the returned shape reflects the freshly-written address too.
  if (saved?.id) {
    const fresh = await shopifyGraphQL(GET_CUSTOMER_BY_ID, { id: saved.id }).catch(() => null);
    if (fresh?.customer) saved = fresh.customer;
  }
  return toClientShape(saved);
}

// Resolve a cart's `customer` field to a real Shopify customer for the draft order,
// server-authoritative. Returns { customerId, isRepeat } — isRepeat drives the deposit tier.
export async function resolveCustomer(customer) {
  if (!customer) return { customerId: null, isRepeat: false };
  if (customer.id) {
    try {
      const data = await shopifyGraphQL(GET_CUSTOMER_BY_ID, { id: customer.id });
      if (data.customer) return { customerId: data.customer.id, isRepeat: isRepeatCustomer(data.customer.tags) };
    } catch {
      /* fall through to email path */
    }
  }
  if (!customer.email) return { customerId: null, isRepeat: false };
  try {
    const rec = await findByEmail(customer.email);
    if (rec) return { customerId: rec.id, isRepeat: isRepeatCustomer(rec.tags) };
  } catch {
    /* ignore */
  }
  return { customerId: null, isRepeat: false };
}
