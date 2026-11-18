// Surface the SERVER's error text, not just the status code. Routes reply `{ error: "..." }`,
// and for orders that string is Shopify's own userError (bad phone, insufficient inventory,
// invalid province…). Swallowing it left reps staring at "/api/orders → 400" with no way to tell
// what to fix, so the real reason now reaches the screen.
async function failure(url, r) {
  let detail = '';
  try {
    const body = await r.clone().json();
    detail = body?.error || body?.message || '';
  } catch {
    try {
      detail = (await r.text()).slice(0, 300);
    } catch {
      /* nothing readable in the body */
    }
  }
  return new Error(detail ? `${detail} (${r.status})` : `${url} → ${r.status}`);
}

async function jget(url) {
  const r = await fetch(url, { credentials: 'include' });
  if (!r.ok) throw await failure(url, r);
  return r.json();
}
async function jpost(url, body) {
  const r = await fetch(url, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  if (!r.ok) throw await failure(url, r);
  return r.json();
}

export const api = {
  me: () => jget('/api/me'),
  snapshot: () => jget('/api/snapshot'),
  inventory: () => jget('/api/inventory'),
  login: (email, password) => jpost('/api/auth/login', { email, password }),
  requestLink: (email) => jpost('/api/auth/request', { email }),
  logout: () => jpost('/api/auth/logout'),
  createOrder: (payload) => jpost('/api/orders', payload),
  searchCustomers: (q) => jget(`/api/customers/search?q=${encodeURIComponent(q)}`),
  upsertCustomer: (profile) => jpost('/api/customers', profile),
  checkoutQueue: () => jget('/api/checkout/queue'),
  createFormLink: (body) => jpost('/api/form-links', body),
  // Customer order form: kiosk submits under the rep session; QR uses the per-event code.
  submitOrderForm: (payload) => jpost('/api/order-forms', payload),
  publicFormCatalog: (code) => jget(`/api/form/catalog?code=${encodeURIComponent(code)}`),
  publicFormSubmit: (code, payload) => jpost(`/api/form/submit?code=${encodeURIComponent(code)}`, payload),
  pendingList: () => jget('/api/pending'),
  inboundList: () => jget('/api/inbound'),
  inboundCreate: (body) => jpost('/api/inbound', body),
  inboundUpdate: (id, body) => jpost(`/api/inbound/${encodeURIComponent(id)}`, body),
  inboundReceive: (id, body) => jpost(`/api/inbound/${encodeURIComponent(id)}/receive`, body),
  orders: () => jget('/api/orders'),
  order: (id) => jget(`/api/orders/${encodeURIComponent(id)}`),
  orderEventReview: (id, eventId) => jpost(`/api/orders/${encodeURIComponent(id)}/events/${encodeURIComponent(eventId)}/review`, {}),
  orderAvailability: (lines) => jpost('/api/orders/availability', { lines }),
  orderBalance: (id, body) => jpost(`/api/orders/${encodeURIComponent(id)}/balance`, body || {}),
  intake: () => jget('/api/intake'),
  intakeUpload: async (file) => {
    const fd = new FormData();
    fd.append('source', 'upload');
    fd.append('file', file);
    const r = await fetch('/api/intake', { method: 'POST', credentials: 'include', body: fd });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(body.error || `Upload failed (${r.status})`);
    return body;
  },
  intakeAssign: (id, body) => jpost(`/api/intake/${encodeURIComponent(id)}/assign`, body),
  intakeApplyPreview: (id) => jget(`/api/intake/${encodeURIComponent(id)}/apply`),
  intakeApply: (id, body) => jpost(`/api/intake/${encodeURIComponent(id)}/apply`, body || {}),
  intakeIgnore: (id) => jpost(`/api/intake/${encodeURIComponent(id)}/ignore`, {}),
  refAdd: (shipmentId, body) => jpost(`/api/inbound/${encodeURIComponent(shipmentId)}/refs`, body),
  refRemove: (shipmentId, refId) => jpost(`/api/inbound/${encodeURIComponent(shipmentId)}/refs/${encodeURIComponent(refId)}/remove`, {}),
  inboundResync: (id) => jpost(`/api/inbound/${encodeURIComponent(id)}/resync`),
  inboundRematch: (id) => jpost(`/api/inbound/${encodeURIComponent(id)}/rematch`),
  inboundDocs: (id) => jget(`/api/inbound/${encodeURIComponent(id)}/documents`),
  inboundDocCreate: (id, body) => jpost(`/api/inbound/${encodeURIComponent(id)}/documents`, body),
  inboundDocUpdate: (id, docId, body) =>
    jpost(`/api/inbound/${encodeURIComponent(id)}/documents/${encodeURIComponent(docId)}`, body),
  inboundParse: async (file) => {
    const fd = new FormData();
    fd.append('file', file);
    const r = await fetch('/api/inbound/parse', { method: 'POST', credentials: 'include', body: fd });
    if (!r.ok) throw new Error((await r.json().catch(() => ({})))?.error || `parse → ${r.status}`);
    return r.json();
  },
  confirmPending: (id, payload) => jpost(`/api/pending/${encodeURIComponent(id)}/confirm`, payload),
  dismissPending: (id) => jpost(`/api/pending/${encodeURIComponent(id)}/dismiss`),
};
