import React, { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api.js';

// Import history: bring this year's supplier and freight paperwork in from the Drive order
// folders and the Baci mailbox. Count first, then import. It only ever creates PAST shipments.
const n = (v) => Number(v || 0).toLocaleString('en-US');
const yearStart = () => `${new Date().getFullYear()}-01-01`;
const daysAgo = (d) => new Date(Date.now() - d * 86400000).toISOString().slice(0, 10);

export function HistoryImport({ onChanged }) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState(null); // { connections, run }
  const [err, setErr] = useState('');
  const [since, setSince] = useState(yearStart());
  const [pastBefore, setPastBefore] = useState(daysAgo(60));
  const [gmail, setGmail] = useState(true);
  const [drive, setDrive] = useState(true);
  const [maxAi, setMaxAi] = useState(200);
  const wasRunning = useRef(false);

  const load = useCallback(async () => {
    try {
      const r = await api.intakeHistory();
      setState(r);
      const running = r.run?.status === 'running';
      if (wasRunning.current && !running) onChanged?.(); // a run just ended: refresh the inbox
      wasRunning.current = running;
    } catch (e) {
      setErr(e?.message || 'Could not load the import status');
    }
  }, [onChanged]);

  useEffect(() => {
    if (!open) return undefined;
    load();
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [open, load]);

  const start = async (countOnly) => {
    setErr('');
    try {
      await api.intakeHistoryStart({ since, pastBefore, gmail, drive, maxAi, countOnly });
      wasRunning.current = true;
      await load();
    } catch (e) {
      setErr(e?.message || 'Could not start');
    }
  };

  if (!open) {
    return (
      <button className="link hist-open" onClick={() => setOpen(true)}>
        Import past documents from Drive and email…
      </button>
    );
  }

  const c = state?.connections;
  const run = state?.run;
  const p = run?.progress || {};
  const running = run?.status === 'running';
  const ready = c?.google?.configured && !c?.google?.error;
  const counted = run && !running && run.params?.countOnly && run.status === 'done';

  return (
    <div className="hist">
      <div className="hist-head">
        <strong>Import past documents</strong>
        <button className="link" onClick={() => setOpen(false)}>Close</button>
      </div>
      <div className="muted small">
        Reads supplier and freight paperwork from the Drive order folders and the mailbox, and files it on shipments. Shipments it creates are
        marked as past: they never add stock, never show as on the way and are never promised to a client order.
      </div>

      {!state && !err && <div className="muted small">Checking connections…</div>}
      {c && (
        <div className="hist-conn small">
          <span className={ready ? 'badge ready' : 'badge back'}>
            {ready ? `Google: ${c.google.email}` : c.google.configured ? 'Google: not working' : 'Google: not connected'}
          </span>
          <span className={c.ai.configured ? 'badge ready' : 'badge back'}>{c.ai.configured ? 'AI reading: on' : 'AI reading: off'}</span>
        </div>
      )}
      {c?.google?.error && <div className="err-inline small">{c.google.error}</div>}
      {c && !c.google.configured && (
        <div className="err-inline small">Google is not connected yet. It needs GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and GOOGLE_REFRESH_TOKEN set on this service.</div>
      )}
      {c && !c.ai.configured && (
        <div className="muted small">
          Without AI reading only Baci orders, invoices and packing lists are taken in. Forwarder, customs and freight papers wait until
          ANTHROPIC_API_KEY is set.
        </div>
      )}
      {err && <div className="err-inline small">{err}</div>}

      {!running && (
        <div className="hist-form">
          <label className="inbound-field">
            <span>Documents since</span>
            <input type="date" value={since} onChange={(e) => setSince(e.target.value)} />
          </label>
          <label className="inbound-field">
            <span>Treat as past if dated before</span>
            <input type="date" value={pastBefore} onChange={(e) => setPastBefore(e.target.value)} />
          </label>
          <label className="inbound-field">
            <span>AI reads at most</span>
            <input type="number" min="0" max="2000" value={maxAi} onChange={(e) => setMaxAi(e.target.value)} />
          </label>
          <label className="hist-check small">
            <input type="checkbox" checked={drive} onChange={(e) => setDrive(e.target.checked)} /> Drive folders
          </label>
          <label className="hist-check small">
            <input type="checkbox" checked={gmail} onChange={(e) => setGmail(e.target.checked)} /> Email attachments
          </label>
          <div className="doc-btns">
            <button className="secondary small-btn" disabled={!ready || (!gmail && !drive)} onClick={() => start(true)}>Count first</button>
            <button className="primary small" disabled={!ready || (!gmail && !drive)} onClick={() => start(false)}>Start import</button>
          </div>
          <div className="muted small">
            Newer supplier documents are left in the inbox for you to decide, because they may be shipments still on their way.
          </div>
        </div>
      )}

      {run && (
        <div className="hist-run small">
          <div>
            <strong>{running ? p.step || 'Working…' : run.status === 'failed' ? `Stopped with an error: ${p.step}` : counted ? 'Count finished' : run.status === 'stopped' ? 'Stopped before the end' : 'Import finished'}</strong>
            {running && p.toRead > 0 && ` · ${n(p.done)} of ${n(p.toRead)}`}
            {running && <button className="link hist-stop" onClick={() => api.intakeHistoryStop().then(load)}>Stop</button>}
          </div>
          {p.found > 0 && (
            <div>
              {n(p.found)} files found since {run.params.since}: {n(p.alreadyIn)} already taken in, {n(p.toRead)} new ({n(p.fromDrive)} from Drive, {n(p.fromEmail)} from email).
            </div>
          )}
          {counted && p.toRead > 0 && <div className="muted">Nothing has been read yet. Start import to read and file them.</div>}
          {!run.params?.countOnly && p.done > 0 && (
            <>
              <div>
                Taken in {n(p.taken)} ({n(p.parsed)} read exactly, {n(p.ai)} read by AI) · set aside {n(p.skipped)} that are not import paperwork
                {p.duplicates > 0 && ` · ${n(p.duplicates)} repeats of a file already in`}
                {p.failed > 0 && ` · ${n(p.failed)} could not be read`}
              </div>
              {(p.filed > 0 || p.shipmentsCreated > 0 || !running) && (
                <div>
                  Filed {n(p.filed)} on shipments · {n(p.shipmentsCreated)} past shipment{p.shipmentsCreated === 1 ? '' : 's'} created
                  {!running && ` · ${n(p.leftInInbox)} waiting in the inbox for a decision`}
                </div>
              )}
              {p.waiting > 0 && (
                <div className="err-inline">
                  {n(p.waiting)} files still need AI reading{p.aiStopped ? `: ${p.aiStopped}` : ' (this run reached its limit)'}. Start the import again to continue with them.
                </div>
              )}
              {p.ai > 0 && <div className="muted">AI reading used {n(p.tokensIn)} input and {n(p.tokensOut)} output tokens.</div>}
            </>
          )}
          {p.errors?.length > 0 && (
            <details>
              <summary>Files that could not be read ({p.errors.length})</summary>
              {p.errors.map((e, i) => (
                <div key={i} className="muted">{e.file}: {e.error}</div>
              ))}
            </details>
          )}
        </div>
      )}
    </div>
  );
}
