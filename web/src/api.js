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
};
