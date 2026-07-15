import React, { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import * as sync from './sync.js';
import { api } from './api.js';
import { ProductCard } from './components/ProductCard.jsx';
import { BrowseView } from './components/BrowseView.jsx';
import { productRank, money, unitWholesalePrice, splitByAvailability } from './domain.js';
import { Cart } from './components/Cart.jsx';
import { CheckoutView } from './components/CheckoutView.jsx';
import { OrderFormView } from './components/OrderFormView.jsx';
import { PendingView } from './components/PendingView.jsx';
import { InboundView } from './components/InboundView.jsx';
import { PrintDoc, BlankFormDoc, OrderCopyDoc } from './components/PrintDocs.jsx';
import { Lookbook } from './components/Lookbook.jsx';
import { cart, useCart, cartCount, cartSubtotal } from './cart.js';

function useSync() {
  return useSyncExternalStore(sync.subscribe, sync.getState);
}

export default function App() {
  // PUBLIC entry: a customer scanned the booth QR (/?form=<event code>). No rep login — the
  // code gates a stripped catalog and the form submits into the shared pending pool.
  const formCode = new URLSearchParams(window.location.search).get('form');
  if (formCode != null) return <PublicOrderForm initialCode={formCode} />;
  return <RepApp />;
}

function RepApp() {
  const [auth, setAuth] = useState('checking'); // checking | in | out
  const [me, setMe] = useState(null);
  const loadMe = () =>
    api
      .me()
      .then((r) => {
        setMe(r.rep);
        setAuth('in');
        sync.init();
      })
      .catch(() => setAuth('out'));
  useEffect(() => {
    loadMe();
  }, []);

  if (auth === 'checking') return <div className="center muted">Loading…</div>;
  if (auth === 'out') return <Login onLoggedIn={loadMe} />;
  return <Shell me={me} />;
}

// Customer's own phone, via QR. Fetches the code-gated catalog; wrong/rotated code shows a
// friendly re-entry screen instead of an error wall.
function PublicOrderForm({ initialCode }) {
  const [code, setCode] = useState(initialCode);
  const [entry, setEntry] = useState(initialCode);
  const [catalog, setCatalog] = useState(null);
  const [state, setState] = useState('loading'); // loading | ready | badcode | error
  const [stage, setStage] = useState('auto'); // personalized links open on the lookbook first

  useEffect(() => {
    let dead = false;
    setState('loading');
    api
      .publicFormCatalog(code)
      .then((snap) => {
        if (dead) return;
        setCatalog(snap);
        setState('ready');
      })
      .catch((e) => {
        if (dead) return;
        setState(/401/.test(String(e?.message)) ? 'badcode' : 'error');
      });
    return () => {
      dead = true;
    };
  }, [code]);

  if (state === 'loading') return <div className="center muted">Loading the order form…</div>;

  if (state !== 'ready') {
    return (
      <div className="center">
        <div className="login">
          <h1>Baci Milano · Order Form</h1>
          <p className="muted small">
            {state === 'badcode'
              ? 'That show code isn’t valid — grab the current one from the booth.'
              : 'Could not load the form — check your signal and try again.'}
          </p>
          <input placeholder="Show code" value={entry} onChange={(e) => setEntry(e.target.value)} />
          <button className="primary" onClick={() => setCode(entry.trim())}>
            Open order form
          </button>
        </div>
      </div>
    );
  }

  const availability = {};
  for (const p of catalog.products || []) for (const v of p.variants) availability[v.id] = v.available ?? 0;

  // Personalized links open on the lookbook (curated collections, big imagery), then flow into
  // the order form with the customer's info prefilled. Plain event codes go straight to the form.
  if (catalog.link && stage !== 'form') {
    return <Lookbook catalog={catalog} onStart={() => setStage('form')} />;
  }

  return (
    <OrderFormView
      snapshot={catalog}
      config={catalog.config}
      availability={availability}
      mode="public"
      code={code}
      prefill={catalog.link || null}
    />
  );
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

function Shell({ me }) {
  const s = useSync();
  const [query, setQuery] = useState('');
  const [showCart, setShowCart] = useState(false);
  const [view, setView] = useState('browse'); // browse | pending | checkout | form (kiosk)
  const [pending, setPending] = useState(null);
  const [reviewing, setReviewing] = useState(null); // { pendingId, customer, notes }
  const [printing, setPrinting] = useState(null); // null | 'blank' | { order } (copy of current cart)
  const cartItems = useCart();
  const isCaptain = !!me?.isCaptain;
  const isAdmin = !!me?.isAdmin;

  const loadPending = useCallback(() => {
    api
      .pendingList()
      .then((r) => setPending(r.pending || []))
      .catch(() => {});
  }, []);

  // Refresh the pool on login, on SSE ping (a form just landed), and every 60s as a backstop.
  useEffect(() => {
    loadPending();
    window.addEventListener('pending-order', loadPending);
    const t = setInterval(loadPending, 60000);
    return () => {
      window.removeEventListener('pending-order', loadPending);
      clearInterval(t);
    };
  }, [loadPending]);

  const productIndex = useMemo(() => {
    const m = new Map();
    for (const p of s.snapshot?.products || []) m.set(p.id, p);
    return m;
  }, [s.snapshot]);

  const variantIndex = useMemo(() => {
    const m = new Map();
    for (const p of s.snapshot?.products || []) for (const v of p.variants) m.set(v.id, { product: p, variant: v });
    return m;
  }, [s.snapshot]);

  const results = useMemo(() => {
    const products = s.snapshot?.products || [];
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const lowT = s.config?.lowThreshold ?? 10;
    return products
      .filter(
        (p) =>
          p.title.toLowerCase().includes(q) ||
          (p.productType || '').toLowerCase().includes(q) ||
          (p.materials || []).some((m) => m.toLowerCase().includes(q)) ||
          p.variants.some((v) => (v.sku || '').toLowerCase().includes(q))
      )
      .sort((a, b) => productRank(a, s.availability, lowT) - productRank(b, s.availability, lowT))
      .slice(0, 60);
  }, [query, s.snapshot, s.availability, s.config]);

  if (!s.snapshot) return <div className="center muted">Syncing catalog…</div>;

  // Kiosk form mode replaces the whole shell — nothing rep-facing is reachable until exit.
  if (view === 'form') {
    return (
      <OrderFormView
        snapshot={s.snapshot}
        config={s.config}
        availability={s.availability}
        mode="kiosk"
        me={me}
        onExit={() => setView('browse')}
      />
    );
  }

  const pendingCount = (pending || []).filter((p) => p.status === 'pending').length;
  const showCheckout = isCaptain && view === 'checkout';
  const showPending = view === 'pending';
  const showInbound = isAdmin && view === 'inbound';

  // A rep opened a submitted form: seed the normal cart with its lines (priced from the live
  // snapshot) and open the standard review drawer with the buyer's info prefilled.
  const openPending = (p) => {
    const pct = s.config?.discountPct ?? 50;
    cart.clear();
    let skipped = 0;
    for (const l of p.lines || []) {
      const hit = variantIndex.get(l.variantId);
      if (!hit) {
        skipped++;
        continue;
      }
      const { product, variant } = hit;
      cart.add({
        variantId: variant.id,
        productId: product.id,
        title: product.title,
        sku: variant.sku,
        image: product.image,
        unit: unitWholesalePrice(variant, pct),
        msrp: variant.retailPrice,
        origin: product.countryOfOrigin,
        qty: Number(l.quantity) || 1,
      });
    }
    if (skipped > 0) window.alert(`${skipped} submitted item(s) are no longer in the catalog and were skipped.`);
    const c = p.customer || {};
    const hasCustomer = c.company || c.contact || c.email || c.phone;
    setReviewing({
      pendingId: p.id,
      customer: hasCustomer
        ? {
            id: null,
            name: c.company || c.contact || '',
            email: c.email || '',
            phone: c.phone || '',
            isB2B: false,
            location: '',
            specialty: '',
            collectionsOfInterest: [],
            onlineOnly: false,
            address: { address1: '', address2: '', city: '', province: '', zip: '', country: 'US' },
          }
        : null,
      notes: [c.contact && c.company ? `Contact: ${c.contact}` : '', p.notes || ''].filter(Boolean).join('\n'),
    });
    setShowCart(true);
  };

  const dismissPending = async (p) => {
    if (!window.confirm('Dismiss this order form? It will not become an order.')) return;
    try {
      await api.dismissPending(p.id);
    } catch {
      /* list refresh will reconcile */
    }
    loadPending();
  };

  // Closing the drawer does NOT end a pending review — the rep can browse, ADD more items
  // (client asked for adjustments), and reopen via the cart bar with the client still attached.
  // The review ends only on confirm (finishReview) or an explicit discard.
  const closeCart = () => setShowCart(false);

  const finishReview = () => {
    setShowCart(false);
    if (reviewing) {
      setReviewing(null);
      loadPending();
    }
  };

  const discardReview = () => {
    cart.clear();
    setReviewing(null);
    setShowCart(false);
  };

  return (
    <div className="app">
      <header>
        <div className="hrow">
          <strong>Baci Reps</strong>
          <span className="badges">
            <button
              className="hbtn"
              title={cartItems.length ? 'Print a copy of the current order' : 'Print the blank order form'}
              onClick={() =>
                setPrinting(
                  cartItems.length
                    ? { order: { lines: splitByAvailability(cartItems, s.availability), customer: null, notes: '', appliedPct: 0, result: null } }
                    : 'blank'
                )
              }
            >
              🖨
            </button>
            <button className="hbtn" onClick={() => setView('form')} title="Hand the tablet to a customer">
              📋 Form
            </button>
            {s.snapshot.showcase && (
              <span className="showcase-pill">Showcase · {s.snapshot.products.length}</span>
            )}
            <FreshnessBadge status={s.status} syncedAt={s.syncedAt} />
          </span>
        </div>
        <div className="tabs">
          <button className={view === 'browse' ? 'tab active' : 'tab'} onClick={() => setView('browse')}>
            Browse
          </button>
          <button className={showPending ? 'tab active' : 'tab'} onClick={() => setView('pending')}>
            Pending{pendingCount > 0 ? ` · ${pendingCount}` : ''}
          </button>
          {isCaptain && (
            <button className={view === 'checkout' ? 'tab active' : 'tab'} onClick={() => setView('checkout')}>
              Checkout
            </button>
          )}
          {isAdmin && (
            <button className={view === 'inbound' ? 'tab active' : 'tab'} onClick={() => setView('inbound')}>
              Inbound
            </button>
          )}
        </div>
        {!showCheckout && !showPending && !showInbound && (
          <input
            className="search"
            placeholder="Search SKU, name, or type…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            autoFocus
          />
        )}
      </header>
      <main>
        {showInbound ? (
          <InboundView snapshot={s.snapshot} />
        ) : showCheckout ? (
          <CheckoutView config={s.config} />
        ) : showPending ? (
          <PendingView pending={pending} onOpen={openPending} onDismiss={dismissPending} />
        ) : query.trim() ? (
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

      {!showCheckout && !showPending && !showInbound && cartItems.length > 0 && (
        <button className="cartbar" onClick={() => setShowCart(true)}>
          <span>
            {cartCount(cartItems)} item{cartCount(cartItems) !== 1 ? 's' : ''}
          </span>
          <span>Review order · {money(cartSubtotal(cartItems), s.config?.currency || 'USD')}</span>
        </button>
      )}
      {showCart && (
        <Cart
          config={s.config}
          availability={s.availability}
          pendingId={reviewing?.pendingId}
          initialCustomer={reviewing?.customer}
          initialNotes={reviewing?.notes}
          onClose={closeCart}
          onFinished={finishReview}
          onDiscard={reviewing ? discardReview : undefined}
        />
      )}
      {printing === 'blank' && (
        <PrintDoc title="Blank order form" onClose={() => setPrinting(null)}>
          <BlankFormDoc snapshot={s.snapshot} config={s.config} />
        </PrintDoc>
      )}
      {printing && printing !== 'blank' && (
        <PrintDoc title="Order copy" onClose={() => setPrinting(null)}>
          <OrderCopyDoc order={printing.order} currency={s.config?.currency || 'USD'} leadTime={s.config?.leadTime} depositPctHint={s.config?.depositPct?.new_customer} />
        </PrintDoc>
      )}
    </div>
  );
}
