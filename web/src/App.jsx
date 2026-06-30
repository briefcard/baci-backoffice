import React, { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import * as sync from './sync.js';
import { api } from './api.js';
import { ProductCard } from './components/ProductCard.jsx';
import { BrowseView } from './components/BrowseView.jsx';

function useSync() {
  return useSyncExternalStore(sync.subscribe, sync.getState);
}

export default function App() {
  const [auth, setAuth] = useState('checking'); // checking | in | out
  useEffect(() => {
    api
      .me()
      .then(() => {
        setAuth('in');
        sync.init();
      })
      .catch(() => setAuth('out'));
  }, []);

  if (auth === 'checking') return <div className="center muted">Loading…</div>;
  if (auth === 'out')
    return <Login onLoggedIn={() => { setAuth('in'); sync.init(); }} />;
  return <Shell />;
}

function Login({ onLoggedIn }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e) => {
    e.preventDefault();
    setErr('');
    setBusy(true);
    try {
      await api.login(email, password);
      onLoggedIn();
    } catch {
      setErr('Invalid email or password');
      setBusy(false);
    }
  };
  return (
    <div className="center">
      <div className="login">
        <h1>Baci Reps</h1>
        <form onSubmit={submit}>
          <input
            type="email"
            required
            placeholder="you@bacimilanousa.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <input
            type="password"
            required
            placeholder="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <button type="submit" disabled={busy}>
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
          {err && <p className="err">{err}</p>}
        </form>
      </div>
    </div>
  );
}

function FreshnessBadge({ status, syncedAt }) {
  const t = syncedAt
    ? new Date(syncedAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
    : '—';
  const map = {
    live: { cls: 'fresh live', text: `Live · synced ${t}` },
    reconnecting: { cls: 'fresh warn', text: `Reconnecting · as of ${t}` },
    offline: { cls: 'fresh off', text: `Offline · as of ${t}` },
  };
  const m = map[status] || map.offline;
  return <span className={m.cls}>{m.text}</span>;
}

function Shell() {
  const s = useSync();
  const [query, setQuery] = useState('');

  const productIndex = useMemo(() => {
    const m = new Map();
    for (const p of s.snapshot?.products || []) m.set(p.id, p);
    return m;
  }, [s.snapshot]);

  const results = useMemo(() => {
    const products = s.snapshot?.products || [];
    const q = query.trim().toLowerCase();
    if (!q) return products.slice(0, 40);
    return products
      .filter(
        (p) =>
          p.title.toLowerCase().includes(q) ||
          (p.productType || '').toLowerCase().includes(q) ||
          p.variants.some((v) => (v.sku || '').toLowerCase().includes(q))
      )
      .slice(0, 60);
  }, [query, s.snapshot]);

  if (!s.snapshot) return <div className="center muted">Syncing catalog…</div>;

  return (
    <div className="app">
      <header>
        <div className="hrow">
          <strong>Baci Reps</strong>
          <FreshnessBadge status={s.status} syncedAt={s.syncedAt} />
        </div>
        <input
          className="search"
          placeholder="Search SKU, name, or type…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          autoFocus
        />
      </header>
      <main>
        {query.trim() ? (
          <>
            {results.map((p) => (
              <ProductCard
                key={p.id}
                product={p}
                availability={s.availability}
                config={s.config}
                productIndex={productIndex}
              />
            ))}
            {results.length === 0 && <div className="center muted">No matches.</div>}
          </>
        ) : (
          <BrowseView
            products={s.snapshot.products}
            availability={s.availability}
            config={s.config}
            productIndex={productIndex}
          />
        )}
      </main>
    </div>
  );
}
