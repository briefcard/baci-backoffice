import React, { useMemo, useRef, useState } from 'react';
import { unitWholesalePrice, money } from '../domain.js';
import { buildFormSections, submitOrQueue } from '../formSections.js';
import { api } from '../api.js';

// The digitized paper order form. Customers browse collection sections (same order as the
// printed catalogue), punch in quantities, and submit — WITHOUT ever seeing a total: unit
// prices show, but nothing here sums anything. Totals appear only on the rep's review screen.
//
// mode 'kiosk'  — a rep's booth tablet, locked; exit requires the rep's password.
// mode 'public' — a customer's own phone via QR (?form=<code>); no rep UI at all.
export function OrderFormView({ snapshot, config, availability, mode, me, code, onExit }) {
  const currency = config?.currency || 'USD';
  const pct = config?.discountPct ?? 50;
  const [qty, setQty] = useState({}); // variantId -> quantity
  const [query, setQuery] = useState('');
  const [review, setReview] = useState(false);
  const [doneState, setDoneState] = useState(null); // null | 'sent' | 'queued'
  const [exitAsk, setExitAsk] = useState(false);
  const sectionRefs = useRef({});

  const sections = useMemo(
    () => buildFormSections(snapshot?.products || [], config?.formCollections || []),
    [snapshot, config]
  );

  const q = query.trim().toLowerCase();
  const visible = useMemo(() => {
    if (!q) return sections;
    return sections
      .map((s) => ({
        ...s,
        products: s.products.filter(
          (p) =>
            p.title.toLowerCase().includes(q) ||
            p.variants.some((v) => (v.sku || '').toLowerCase().includes(q))
        ),
      }))
      .filter((s) => s.products.length > 0);
  }, [sections, q]);

  const chosen = useMemo(() => {
    const out = [];
    for (const s of sections)
      for (const p of s.products)
        for (const v of p.variants) {
          const n = Math.floor(Number(qty[v.id]) || 0);
          if (n > 0) out.push({ product: p, variant: v, qty: n });
        }
    return out;
  }, [sections, qty]);
  const unitCount = chosen.reduce((s, c) => s + c.qty, 0);

  const setQ = (variantId, value) => {
    const n = Math.max(0, Math.floor(Number(value) || 0));
    setQty((m) => ({ ...m, [variantId]: n }));
  };

  const startOver = () => {
    setQty({});
    setQuery('');
    setReview(false);
    setDoneState(null);
  };

  if (doneState) {
    return (
      <div className="form-app">
        <div className="form-done">
          <div className="big-check">✓</div>
          <h2>Order received!</h2>
          <p className="muted">
            {doneState === 'queued'
              ? 'Saved on this device — it will send automatically the moment signal returns.'
              : 'A Baci Milano rep will review the totals with you shortly.'}
          </p>
          <button className="primary" onClick={startOver}>
            Start a new order form
          </button>
          {mode === 'kiosk' && (
            <button className="link" onClick={() => setExitAsk(true)}>
              Rep: exit form mode
            </button>
          )}
        </div>
        {exitAsk && <ExitGate me={me} onExit={onExit} onCancel={() => setExitAsk(false)} />}
      </div>
    );
  }

  return (
    <div className="form-app">
      <header className="form-head">
        <div className="form-brand">
          <strong>BACI MILANO</strong>
          <span>Curated U.S. Selections · Order Form</span>
        </div>
        {mode === 'kiosk' && (
          <button className="form-exit" onClick={() => setExitAsk(true)} aria-label="Exit form mode">
            🔒
          </button>
        )}
      </header>

      <div className="form-sticky">
        <input
          className="search"
          placeholder="Find an item or SKU…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {!q && (
          <div className="form-nav">
            {sections.map((s) => (
              <button
                key={s.handle}
                className="chip"
                onClick={() => sectionRefs.current[s.handle]?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
              >
                {s.title}
              </button>
            ))}
          </div>
        )}
      </div>

      <main className="form-main">
        {visible.map((s) => (
          <section key={s.handle} ref={(el) => (sectionRefs.current[s.handle] = el)} className="form-section">
            <div className="form-section-head">
              <h2>{s.title}</h2>
              <span className="muted small">CATALOGUE: {s.title.toUpperCase()}</span>
            </div>
            {(s.groups || [{ type: null, products: s.products }]).map((g) => (
              <div key={g.type || 'all'}>
                {g.type && <div className="form-group-head">{g.type}</div>}
                {g.products.map((p) => (
                  <FormRow
                    key={p.id}
                    product={p}
                    availability={availability}
                    pct={pct}
                    currency={currency}
                    qty={qty}
                    setQ={setQ}
                  />
                ))}
              </div>
            ))}
          </section>
        ))}
        {visible.length === 0 && <div className="center muted">No matches.</div>}
        <div className="form-footer-space" />
      </main>

      {unitCount > 0 && (
        <button className="cartbar form-bar" onClick={() => setReview(true)}>
          <span>
            {unitCount} unit{unitCount !== 1 ? 's' : ''} · {chosen.length} item{chosen.length !== 1 ? 's' : ''}
          </span>
          <span>Review &amp; submit ▸</span>
        </button>
      )}

      {review && (
        <ReviewSheet
          chosen={chosen}
          availability={availability}
          currency={currency}
          mode={mode}
          code={code}
          onBack={() => setReview(false)}
          onDone={(state) => setDoneState(state)}
          setQ={setQ}
        />
      )}
      {exitAsk && <ExitGate me={me} onExit={onExit} onCancel={() => setExitAsk(false)} />}
    </div>
  );
}

function FormRow({ product, availability, pct, currency, qty, setQ }) {
  return (
    <div className="frow">
      {product.image ? <img className="fimg" src={product.image} alt="" loading="lazy" /> : <div className="fimg ph" />}
      <div className="fbody">
        <div className="ftitle">{product.title}</div>
        <div className="fmeta muted small">
          {[product.productType, (product.materials || [])[0]].filter(Boolean).join(' · ')}
        </div>
        <div className="fvars">
          {product.variants.map((v) => {
            const avail = Math.max(0, availability?.[v.id] ?? v.available ?? 0);
            const out = avail <= 0;
            // Oversell guard, customer-visible: any quantity beyond current stock is flagged as
            // the deposit portion (without ever showing the raw stock number unprompted).
            const entered = Math.floor(Number(qty[v.id]) || 0);
            const over = Math.max(0, entered - avail);
            return (
              <div className={`fvar ${out ? 'isout' : ''}`} key={v.id}>
                <div className="fvar-main">
                  <span className="fsku">{v.sku || '—'}</span>
                  {v.title && v.title !== 'Default Title' && <span className="fvtitle">{v.title}</span>}
                  {out && <span className="flater">deposit · ~{config?.leadTime || '6–10 weeks'}</span>}
                  {!out && over > 0 && <span className="flater">+{over} on deposit</span>}
                </div>
                <span className="fpricewrap">
                  <span className="fprice">{money(unitWholesalePrice(v, pct), currency)}</span>
                  <span className="fmsrp">MSRP {money(v.retailPrice, currency)}</span>
                </span>
                <input
                  className="fqty"
                  type="number"
                  inputMode="numeric"
                  min="0"
                  placeholder="0"
                  value={qty[v.id] || ''}
                  onChange={(e) => setQ(v.id, e.target.value)}
                />
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function ReviewSheet({ chosen, availability, currency, mode, code, onBack, onDone, setQ }) {
  const [company, setCompany] = useState('');
  const [contact, setContact] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const submit = async () => {
    if (!company.trim() && !contact.trim()) {
      setErr('Please add your store or contact name.');
      return;
    }
    setErr('');
    setBusy(true);
    try {
      const payload = {
        lines: chosen.map((c) => ({
          variantId: c.variant.id,
          quantity: c.qty,
          sku: c.variant.sku,
          title: c.product.title,
        })),
        customer: { company, contact, email, phone },
        notes,
      };
      const { queued } = await submitOrQueue({ kind: mode === 'public' ? 'qr' : 'kiosk', code, payload });
      onDone(queued ? 'queued' : 'sent');
    } catch (e) {
      setErr(e?.message || 'Could not submit — please try again.');
      setBusy(false);
    }
  };

  return (
    <div className="cart-overlay" onClick={onBack}>
      <div className="cart" onClick={(e) => e.stopPropagation()}>
        <div className="cart-head">
          <strong>Your order</strong>
          <button className="x" onClick={onBack}>
            ✕
          </button>
        </div>
        <div className="cart-body">
          {chosen.map((c) => {
            const avail = Math.max(0, availability?.[c.variant.id] ?? c.variant.available ?? 0);
            const now = Math.min(avail, c.qty);
            const dep = c.qty - now;
            return (
              <div className="citem" key={c.variant.id}>
                {c.product.image ? <img src={c.product.image} alt="" /> : <div className="ph" />}
                <div className="cinfo">
                  <div className="ct">{c.product.title}</div>
                  <div className="cs">
                    {c.variant.sku} · qty {c.qty}
                    {dep > 0 && (
                      <span className="cs-dep">
                        {now > 0 ? ` — ${now} now · ${dep} on deposit` : ' — on deposit (ships when available)'}
                      </span>
                    )}
                  </div>
                </div>
                <button className="link" onClick={() => setQ(c.variant.id, 0)}>
                  Remove
                </button>
              </div>
            );
          })}

          {chosen.some((c) => c.qty > Math.max(0, availability?.[c.variant.id] ?? c.variant.available ?? 0)) && (
            <div className="dep-note">
              Quantities beyond what's on hand are <strong>secured with a deposit</strong> and ship
              as soon as stock arrives — so nothing gets oversold. Your rep will go over the details.
            </div>
          )}

          <div className="muted small form-note">
            A Baci Milano rep will go over totals, availability, and any volume pricing with you.
          </div>

          <div className="cfields">
            <input placeholder="Store / company name" value={company} onChange={(e) => setCompany(e.target.value)} />
            <input placeholder="Your name" value={contact} onChange={(e) => setContact(e.target.value)} />
            <input type="email" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} />
            <input placeholder="Phone" value={phone} onChange={(e) => setPhone(e.target.value)} />
            <textarea placeholder="Anything we should know?" value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} />
          </div>

          {err && <div className="err">{err}</div>}
          <button className="primary" disabled={busy || chosen.length === 0} onClick={submit}>
            {busy ? 'Submitting…' : 'Submit order form'}
          </button>
        </div>
      </div>
    </div>
  );
}

// Kiosk lock: leaving form mode requires the signed-in rep's password (dev bypasses).
function ExitGate({ me, onExit, onCancel }) {
  const [pw, setPw] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const isDev = me?.email === 'dev@local';

  const go = async () => {
    if (isDev) return onExit();
    setBusy(true);
    setErr('');
    try {
      await api.login(me?.email, pw);
      onExit();
    } catch {
      setErr('Wrong password');
      setBusy(false);
    }
  };

  return (
    <div className="cart-overlay" onClick={onCancel}>
      <div className="cart exit-gate" onClick={(e) => e.stopPropagation()}>
        <div className="cart-head">
          <strong>Exit form mode</strong>
          <button className="x" onClick={onCancel}>
            ✕
          </button>
        </div>
        <div className="cart-body">
          {isDev ? (
            <div className="muted small">Auth is disabled (dev) — exit freely.</div>
          ) : (
            <>
              <div className="muted small">Enter the rep password for {me?.email}.</div>
              <input
                type="password"
                placeholder="Rep password"
                value={pw}
                onChange={(e) => setPw(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && go()}
                autoFocus
              />
            </>
          )}
          {err && <div className="err">{err}</div>}
          <button className="primary" disabled={busy} onClick={go}>
            Exit form mode
          </button>
        </div>
      </div>
    </div>
  );
}
