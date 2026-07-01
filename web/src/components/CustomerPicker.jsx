import React, { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';

const looksLikeEmail = (s) => /\S+@\S+\.\S+/.test(s);

// Search-as-you-type against real Shopify customers so reps attach the order to an existing
// customer instead of retyping their info and creating a duplicate. Falls back to a manual
// "new customer" form when there's no match.
export function CustomerPicker({ value, onChange }) {
  const [mode, setMode] = useState(value ? 'picked' : 'search');
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [manual, setManual] = useState({ name: '', email: '', phone: '' });
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

  const startManual = () => {
    setManual(
      looksLikeEmail(query) ? { name: '', email: query.trim(), phone: '' } : { name: query.trim(), email: '', phone: '' }
    );
    setMode('manual');
  };

  const confirmManual = () => {
    if (!manual.email.trim()) return;
    onChange({ id: null, name: manual.name.trim(), email: manual.email.trim(), phone: manual.phone.trim(), isB2B: false });
    setMode('picked');
  };

  const change = () => {
    onChange(null);
    setQuery('');
    setResults([]);
    setMode('search');
  };

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
        </div>
        <button type="button" className="link" onClick={change}>
          Change
        </button>
      </div>
    );
  }

  if (mode === 'manual') {
    return (
      <div className="cust-manual">
        <input
          placeholder="Customer / company name"
          value={manual.name}
          onChange={(e) => setManual({ ...manual, name: e.target.value })}
        />
        <input
          type="email"
          placeholder="Email (required)"
          value={manual.email}
          onChange={(e) => setManual({ ...manual, email: e.target.value })}
        />
        <input
          placeholder="Phone (optional)"
          value={manual.phone}
          onChange={(e) => setManual({ ...manual, phone: e.target.value })}
        />
        <div className="cust-manual-actions">
          <button type="button" className="link" onClick={() => setMode('search')}>
            ‹ Back to search
          </button>
          <button type="button" className="primary small" disabled={!manual.email.trim()} onClick={confirmManual}>
            Use this customer
          </button>
        </div>
      </div>
    );
  }

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
                </div>
              </button>
            ))}
          {!loading && results.length === 0 && <div className="cust-row muted">No match.</div>}
          <button type="button" className="cust-row new" onClick={startManual}>
            + Add "{query.trim()}" as a new customer
          </button>
        </div>
      )}
    </div>
  );
}
