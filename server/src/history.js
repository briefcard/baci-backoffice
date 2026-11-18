// History import: bring this year's supplier and freight paperwork into the app.
//
// Sources: the Drive order folders (B2B / ... / "Order 111-2026") and the Baci mailbox's
// attachments. Every file is fetched once (its source id and its content hash are both
// remembered), read by the app's own parser or by Claude, stored, and then the whole batch is
// filed in the order the paperwork was issued.
//
// What it will never do: add stock, show anything as incoming, or promise units to a client
// order. Shipments it creates are PAST shipments. A supplier document too recent to be safely
// called "past" is left in the inbox for a person.
//
// One run at a time, in this process. A run that is interrupted (a deploy, a restart) loses
// nothing: everything read so far is already stored, and starting again continues from there.
import crypto from 'node:crypto';
import { pool, q } from './db.js';
import { cfg } from './config.js';
import { googleConfigured, whoAmI, listMailWithDocuments, mailAttachments, mailAttachmentBytes, listDriveDocuments, driveFileBytes } from './google.js';
import { aiConfigured, readDocument, ReaderUnavailable } from './reader.js';
import { ingestDocument, knownSourceIds, fileHistorical } from './intakeDocs.js';

const MAX_FILE_BYTES = 24 * 1024 * 1024; // larger files are catalogues, not paperwork
const isDate = (v) => /^20\d{2}-\d{2}-\d{2}$/.test(v || '');
const today = () => new Date().toISOString().slice(0, 10);
const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);

let run = null; // the current or most recent run
let stopRequested = false;

async function persist() {
  if (!pool || !run) return;
  await q(
    `INSERT INTO import_runs (id, status, params, progress, started_by, started_at, finished_at) VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (id) DO UPDATE SET status=$2, progress=$4, finished_at=$7`,
    [run.id, run.status, JSON.stringify(run.params), JSON.stringify(run.progress), run.startedBy, run.startedAt, run.finishedAt]
  ).catch(() => {});
}

// A run left "running" by a restart is over; say so rather than show a frozen progress bar.
export async function recoverRuns() {
  if (!pool) return;
  await q("UPDATE import_runs SET status='stopped', finished_at=now() WHERE status='running'").catch(() => {});
}

export async function lastRun() {
  if (run) return run;
  if (!pool) return null;
  const { rows } = await q('SELECT * FROM import_runs ORDER BY started_at DESC LIMIT 1').catch(() => ({ rows: [] }));
  const r = rows[0];
  return r ? { id: r.id, status: r.status, params: r.params, progress: r.progress, startedBy: r.started_by, startedAt: r.started_at, finishedAt: r.finished_at } : null;
}

// What is connected, for the import panel. Never returns a secret.
export async function connections() {
  const google = { configured: googleConfigured(), email: null, error: null, driveRoot: cfg.google.driveRoot };
  if (google.configured) {
    try {
      google.email = await whoAmI();
    } catch (err) {
      google.error = String(err?.message || err);
    }
  }
  return { google, ai: { configured: aiConfigured(), model: cfg.intakeModel } };
}

// Everything the sources hold since `since`, as fetchable candidates (no bytes yet).
async function collect({ since, gmail, drive }, note) {
  const out = [];
  if (drive) {
    note('Listing the Drive folders');
    for (const f of await listDriveDocuments(since)) {
      out.push({
        sourceId: `drive:${f.id}`, source: 'drive', filename: f.filename, size: f.size, url: f.url, path: f.path, hint: f.hint,
        // Outside an order / shipment / inbound folder, Drive holds sales material: those files
        // are only taken in when the app's own parser recognises them.
        allowAI: !!f.hint || /inbound/i.test(f.path),
        receivedAt: f.modifiedAt, bytes: () => driveFileBytes(f),
      });
    }
  }
  if (gmail) {
    note('Listing emails with attachments');
    const ids = await listMailWithDocuments(since);
    let done = 0;
    for (const id of ids) {
      if (stopRequested) break;
      const m = await mailAttachments(id).catch(() => null);
      if (++done % 25 === 0) note(`Listing emails with attachments: ${done} of ${ids.length}`);
      if (!m) continue;
      for (const a of m.files) {
        out.push({
          sourceId: `gmail:${m.id}:${a.partId || a.filename}`, source: 'email', filename: a.filename, size: a.size, url: m.url,
          sender: m.sender, subject: m.subject, receivedAt: m.receivedAt, hint: null, allowAI: true,
          bytes: () => mailAttachmentBytes(m.id, a.attachmentId),
        });
      }
    }
  }
  return out;
}

async function pooled(items, size, worker) {
  let i = 0;
  await Promise.all(
    Array.from({ length: size }, async () => {
      while (i < items.length && !stopRequested) await worker(items[i++]);
    })
  );
}

async function execute() {
  const p = run.progress;
  const { since, pastBefore, maxAi, countOnly } = run.params;
  const note = (step) => {
    p.step = step;
  };
  const timer = setInterval(persist, 5000);
  try {
    p.account = await whoAmI();
    const all = await collect(run.params, note);
    const known = await knownSourceIds(all.map((c) => c.sourceId));
    const fresh = all.filter((c) => !known.has(c.sourceId));
    Object.assign(p, {
      found: all.length, alreadyIn: all.length - fresh.length, toRead: fresh.length,
      fromDrive: fresh.filter((c) => c.source === 'drive').length, fromEmail: fresh.filter((c) => c.source === 'email').length,
    });
    if (countOnly) {
      note('Counted');
      return;
    }

    note('Reading documents');
    let aiOff = aiConfigured() ? null : 'AI reading is not set up';
    await pooled(fresh, 3, async (c) => {
      const by = run.startedBy;
      const base = { filename: c.filename, source: c.source, driveUrl: c.url, sender: c.sender, subject: c.subject, receivedAt: c.receivedAt };
      const opts = { historical: true, sourceId: c.sourceId, hold: true };
      try {
        if (c.size > MAX_FILE_BYTES) {
          await ingestDocument({ ...base, hash: `size:${c.sourceId}` }, by, { ...opts, status: 'skipped', read: { how: 'skipped', reason: 'file too large to be paperwork' } });
          p.skipped++;
          return;
        }
        const buffer = await c.bytes();
        const context = { sender: c.sender, subject: c.subject, path: c.path };
        // Read only once the file is known to be new. Claude reads while the run's allowance
        // lasts; a file it would have read after that is left untouched for the next run.
        const read = async () => {
          const allowAI = c.allowAI && !aiOff && p.ai < maxAi;
          const r = await readDocument(c.filename, buffer, context, { gate: true, allowAI });
          if (r.how === 'skipped' && r.needsAI && c.allowAI) return { defer: true };
          if (r.how === 'ai') {
            p.ai++;
            p.tokensIn += r.usage.input;
            p.tokensOut += r.usage.output;
          }
          if (r.how === 'parser') p.parsed++;
          return r;
        };
        const res = await ingestDocument({ ...base, buffer, refs: c.hint ? [c.hint] : [] }, by, { ...opts, read });
        if (res.deferred) p.waiting++;
        else if (res.document.status === 'duplicate') p.duplicates++;
        else if (res.document.status === 'skipped') p.skipped++;
        else p.taken++;
      } catch (err) {
        if (err instanceof ReaderUnavailable) {
          aiOff = err.message;
          p.aiStopped = err.message;
          p.waiting++;
          return;
        }
        p.failed++;
        if (p.errors.length < 40) p.errors.push({ file: c.filename, error: String(err?.message || err).slice(0, 200) });
      } finally {
        p.done++;
      }
    });

    note('Filing documents on shipments');
    const filed = await fileHistorical({ pastBefore }, run.startedBy, (f) => Object.assign(p, { filed: f.filed, shipmentsCreated: f.created, applied: f.applied }));
    Object.assign(p, { filed: filed.filed, shipmentsCreated: filed.created, applied: filed.applied, leftInInbox: filed.left });
    note(stopRequested ? 'Stopped' : 'Finished');
  } finally {
    clearInterval(timer);
  }
}

// Start a run. params: { since, gmail, drive, pastBefore, maxAi, countOnly }.
export async function startImport(params = {}, by) {
  if (run?.status === 'running') throw new Error('An import is already running');
  const since = isDate(params.since) ? params.since : `${new Date().getFullYear()}-01-01`;
  if (since > today()) throw new Error('The start date is in the future');
  stopRequested = false;
  run = {
    id: crypto.randomUUID(),
    status: 'running',
    params: {
      since,
      gmail: params.gmail !== false,
      drive: params.drive !== false,
      // Supplier documents dated before this become past shipments; newer ones wait for a person.
      pastBefore: isDate(params.pastBefore) ? params.pastBefore : daysAgo(60),
      maxAi: Math.max(0, Math.min(2000, Math.floor(Number(params.maxAi ?? 200)) || 0)),
      countOnly: params.countOnly === true,
    },
    progress: { step: 'Connecting to Google', found: 0, alreadyIn: 0, toRead: 0, fromDrive: 0, fromEmail: 0, done: 0, taken: 0, parsed: 0, ai: 0, tokensIn: 0, tokensOut: 0, skipped: 0, duplicates: 0, waiting: 0, failed: 0, filed: 0, shipmentsCreated: 0, applied: 0, leftInInbox: 0, errors: [] },
    startedBy: by || null,
    startedAt: new Date().toISOString(),
    finishedAt: null,
  };
  await persist();
  const mine = run;
  execute()
    .then(() => {
      mine.status = stopRequested ? 'stopped' : 'done';
    })
    .catch((err) => {
      mine.status = 'failed';
      mine.progress.step = String(err?.message || err);
    })
    .finally(async () => {
      mine.finishedAt = new Date().toISOString();
      await persist();
    });
  return run;
}

export function stopImport() {
  if (run?.status === 'running') stopRequested = true;
  return run;
}
