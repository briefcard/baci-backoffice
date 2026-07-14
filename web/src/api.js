async function jget(url) {
  const r = await fetch(url, { credentials: 'include' });
  if (!r.ok) throw new Error(`${url} → ${r.status}`);
  return r.json();
}
async function jpost(url, body) {
  const r = await fetch(url, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  if (!r.ok) throw new Error(`${url} → ${r.status}`);
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
  // Customer order form: kiosk submits under the rep session; QR uses the per-event code.
  submitOrderForm: (payload) => jpost('/api/order-forms', payload),
  publicFormCatalog: (code) => jget(`/api/form/catalog?code=${encodeURIComponent(code)}`),
  publicFormSubmit: (code, payload) => jpost(`/api/form/submit?code=${encodeURIComponent(code)}`, payload),
  pendingList: () => jget('/api/pending'),
  inboundList: () => jget('/api/inbound'),
  inboundCreate: (body) => jpost('/api/inbound', body),
  inboundUpdate: (id, body) => jpost(`/api/inbound/${encodeURIComponent(id)}`, body),
  inboundReceive: (id, body) => jpost(`/api/inbound/${encodeURIComponent(id)}/receive`, body),
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
