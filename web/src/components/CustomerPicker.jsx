import React, { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';

const looksLikeEmail = (s) => /\S+@\S+\.\S+/.test(s);

const SPECIALTIES = [
  'Gift Store',
  'High End Tabletop',
  'Home Decor',
  'Boutique',
  'Department Store',
  'Restaurant / Hospitality',
  'Florist',
];

const emptyForm = () => ({
  id: null,
  name: '',
  email: '',
  phone: '',
  onlineOnly: false,
  specialty: '',
  collectionsOfInterest: [],
  address: { address1: '', address2: '', city: '', province: '', zip: '', country: 'US' },
});

function formFromCustomer(c) {
  return {
    id: c.id || null,
    name: c.name || '',
    email: c.email || '',
    phone: c.phone || '',
    onlineOnly: !!c.onlineOnly,
    specialty: c.specialty || '',
    collectionsOfInterest: c.collectionsOfInterest || [],
    address: {
      address1: c.address?.address1 || '',
      address2: c.address?.address2 || '',
      city: c.address?.city || '',
      province: c.address?.province || '',
      zip: c.address?.zip || '',
      country: c.address?.country || 'US',
    },
  };
}

// Pick an existing Shopify customer (search-as-you-type, avoids duplicates) or fill out a full
// wholesale profile — phone, email, location/address, specialty, collections of interest — that's
// saved straight to the customer's Shopify account when the order is drafted.
export function CustomerPicker({ value, onChange, mainCollections = [] }) {
  const [mode, setMode] = useState(value ? 'picked' : 'search');
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [form, setForm] = useState(emptyForm());
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [share, setShare] = useState(false);
  const timer = useRef(null);

  useEffect(() => {
    if (mode !== 'search') return;
    if (query.trim().length < 2) {
      setResults([]);
      return;
    }
    setLoading(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      try {
        const res = await api.searchCustomers(query.trim());
        setResults(res.customers || []);
      } catch {
        setResults([]);
      } finally {
        setLoading(false);
      }
    }, 300);
    return () => clearTimeout(timer.current);
  }, [query, mode]);

  const pick = (c) => {
    onChange(c);
    setMode('picked');
  };

  const startNew = () => {
    const f = emptyForm();
    if (looksLikeEmail(query)) f.email = query.trim();
    else f.name = query.trim();
    setForm(f);
    setErr('');
    setMode('form');
  };

  const editPicked = () => {
    setForm(formFromCustomer(value));
    setErr('');
    setMode('form');
  };

  const setAddr = (k, v) => setForm((f) => ({ ...f, address: { ...f.address, [k]: v } }));
  const toggleCollection = (title) =>
    setForm((f) => ({
      ...f,
      collectionsOfInterest: f.collectionsOfInterest.includes(title)
        ? f.collectionsOfInterest.filter((t) => t !== title)
        : [...f.collectionsOfInterest, title],
    }));

  const save = async () => {
    if (!form.email.trim()) {
      setErr('Email is required to save a customer.');
      return;
    }
    setErr('');
    setBusy(true);
    try {
      const res = await api.upsertCustomer(form);
      onChange(res.customer);
      setMode('picked');
    } catch (e) {
      setErr(e?.message || 'Could not save the customer');
    } finally {
      setBusy(false);
    }
  };

  const change = () => {
    onChange(null);
    setQuery('');
    setResults([]);
    setMode('search');
  };

  // --- Picked summary ---
  if (mode === 'picked' && value) {
    return (
      <div className="cust-picked">
        <div className="cust-picked-info">
          <strong>{value.name || value.email}</strong>{' '}
          {value.isB2B && <span className="badge b2b">B2B</span>}
          {!value.id && <span className="badge new">New</span>}
          <div className="muted small">
            {value.email}
            {value.phone ? ` · ${value.phone}` : ''}
          </div>
          {(value.location || value.specialty || value.collectionsOfInterest?.length > 0) && (
            <div className="muted small cust-profile-line">
              {value.location ? value.location : ''}
              {value.specialty ? `${value.location ? ' · ' : ''}${value.specialty}` : ''}
              {value.collectionsOfInterest?.length ? ` · ♥ ${value.collectionsOfInterest.join(', ')}` : ''}
            </div>
          )}
        </div>
        <div className="cust-picked-actions">
          <button type="button" className="link" onClick={() => setShare(true)}>
            🔗 Share form
          </button>
          <button type="button" className="link" onClick={editPicked}>
            Edit
          </button>
          <button type="button" className="link" onClick={change}>
            Change
          </button>
        </div>
        {share && <ShareFormSheet customer={value} mainCollections={mainCollections} onClose={() => setShare(false)} />}
      </div>
    );
  }

  // --- Profile form (new or edit) ---
  if (mode === 'form') {
    return (
      <div className="cust-form">
        <input placeholder="Customer / company name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        <input type="email" placeholder="Email (required)" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
        <input placeholder="Phone" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />

        <label className="cust-check">
          <input
            type="checkbox"
            checked={form.onlineOnly}
            onChange={(e) => setForm({ ...form, onlineOnly: e.target.checked })}
          />
          Online only (no physical store)
        </label>

        {!form.onlineOnly && (
          <div className="cust-addr">
            <input placeholder="Street address" value={form.address.address1} onChange={(e) => setAddr('address1', e.target.value)} />
            <input placeholder="Suite / unit (optional)" value={form.address.address2} onChange={(e) => setAddr('address2', e.target.value)} />
            <div className="cust-addr-row">
              <input placeholder="City" value={form.address.city} onChange={(e) => setAddr('city', e.target.value)} />
              <input className="st" placeholder="State" value={form.address.province} onChange={(e) => setAddr('province', e.target.value)} />
              <input className="zip" placeholder="ZIP" value={form.address.zip} onChange={(e) => setAddr('zip', e.target.value)} />
            </div>
          </div>
        )}

        <input
          list="specialty-options"
          placeholder="Specialty (e.g. Gift Store, High End Tabletop)"
          value={form.specialty}
          onChange={(e) => setForm({ ...form, specialty: e.target.value })}
        />
        <datalist id="specialty-options">
          {SPECIALTIES.map((s) => (
            <option key={s} value={s} />
          ))}
        </datalist>

        {mainCollections.length > 0 && (
          <div className="cust-collections">
            <div className="muted small">Collections of interest</div>
            <div className="chips">
              {mainCollections.map((c) => {
                const title = c.title || c;
                const on = form.collectionsOfInterest.includes(title);
                return (
                  <button
                    type="button"
                    key={title}
                    className={on ? 'chip on' : 'chip'}
                    onClick={() => toggleCollection(title)}
                  >
                    {title}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {err && <div className="err">{err}</div>}
        <div className="cust-form-actions">
          <button type="button" className="link" onClick={() => setMode(value ? 'picked' : 'search')}>
            ‹ Cancel
          </button>
          <button type="button" className="primary small" disabled={busy} onClick={save}>
            {busy ? 'Saving…' : 'Save customer'}
          </button>
        </div>
      </div>
    );
  }

  // --- Search ---
  return (
    <div className="cust-picker">
      <input
        placeholder="Search customer by name, email, or phone…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      {query.trim().length >= 2 && (
        <div className="cust-dropdown">
          {loading && <div className="cust-row muted">Searching…</div>}
          {!loading &&
            results.map((c) => (
              <button key={c.id} type="button" className="cust-row" onClick={() => pick(c)}>
                <div className="cust-row-main">
                  {c.name || c.email} {c.isB2B && <span className="badge b2b">B2B</span>}
                </div>
                <div className="muted small">
                  {c.email}
                  {c.phone ? ` · ${c.phone}` : ''}
                  {c.location ? ` · ${c.location}` : ''}
                </div>
              </button>
            ))}
          {!loading && results.length === 0 && <div className="cust-row muted">No match.</div>}
          <button type="button" className="cust-row new" onClick={startNew}>
            + Add "{query.trim()}" as a new customer
          </button>
        </div>
      )}
    </div>
  );
}

// Share a personalized order-form link: lookbook + curated collections + prefilled info.
// Two doors in: from a picked customer in the cart (collections preselected from their stored
// interests), or from the rep's Form stage with NO customer (initialSelected carries the curated
// set; the link opens a generic lookbook — logo over the header image — unless the rep fills in
// the optional recipient fields). Submissions credit this rep either way.
export function ShareFormSheet({ customer = null, mainCollections = [], initialSelected, onClose }) {
  const interested = new Set(customer?.collectionsOfInterest || []);
  const [selected, setSelected] = useState(
    () =>
      new Set(
        initialSelected || mainCollections.filter((c) => interested.has(c.title)).map((c) => c.handle)
      )
  );
  const [who, setWho] = useState({ company: '', contact: '', email: '', phone: '' });
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [url, setUrl] = useState('');
  const [copied, setCopied] = useState(false);

  const toggle = (handle) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(handle)) n.delete(handle);
      else n.add(handle);
      return n;
    });

  const create = async () => {
    setBusy(true);
    setErr('');
    try {
      const res = await api.createFormLink({
        customer: customer
          ? { id: customer.id, company: customer.name, email: customer.email, phone: customer.phone }
          : who,
        collections: [...selected],
        note,
      });
      setUrl(res.url);
    } catch (e) {
      setErr(e?.message || 'Could not create the link');
    } finally {
      setBusy(false);
    }
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      window.prompt('Copy the link:', url);
    }
  };

  return (
    <div className="cart-overlay" onClick={onClose}>
      <div className="cart exit-gate" onClick={(e) => e.stopPropagation()}>
        <div className="cart-head">
          <strong>{customer ? `Share form · ${customer.name || customer.email}` : 'Share form link'}</strong>
          <button type="button" className="x" onClick={onClose}>✕</button>
        </div>
        <div className="cart-body">
          {!url ? (
            <>
              <div className="muted small">
                {customer
                  ? 'Pick the collections for their lookbook + form (empty = full catalog). Their info will be prefilled and orders from this link are credited to you.'
                  : 'The link opens this lookbook + form (empty selection = full catalog). Orders from it are credited to you.'}
              </div>
              <div className="chips">
                {mainCollections.map((c) => (
                  <button
                    type="button"
                    key={c.handle}
                    className={selected.has(c.handle) ? 'chip on' : 'chip'}
                    onClick={() => toggle(c.handle)}
                  >
                    {c.title}
                  </button>
                ))}
              </div>
              {!customer && (
                <>
                  <div className="muted small">
                    Recipient (optional) — fill in to personalize the hero ("Curated for …") and
                    prefill their info; leave blank for a general link.
                  </div>
                  <input placeholder="Store / company name" value={who.company} onChange={(e) => setWho({ ...who, company: e.target.value })} />
                  <input placeholder="Contact name" value={who.contact} onChange={(e) => setWho({ ...who, contact: e.target.value })} />
                  <input type="email" placeholder="Email" value={who.email} onChange={(e) => setWho({ ...who, email: e.target.value })} />
                  <input placeholder="Phone" value={who.phone} onChange={(e) => setWho({ ...who, phone: e.target.value })} />
                </>
              )}
              <textarea placeholder="Personal note shown on their lookbook (optional)" rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
              {err && <div className="err">{err}</div>}
              <button type="button" className="primary" disabled={busy} onClick={create}>
                {busy ? 'Creating…' : 'Create personal link'}
              </button>
            </>
          ) : (
            <>
              <div className="muted small">Send this link — it opens their lookbook and order form:</div>
              <div className="share-url">{url}</div>
              <button type="button" className="primary" onClick={copy}>
                {copied ? '✓ Copied' : 'Copy link'}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
