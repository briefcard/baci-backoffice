// Read-only Google access for document intake: Gmail attachments and the Drive order folders.
//
// One account only. The app is given a single refresh token (GOOGLE_REFRESH_TOKEN) for the
// Baci mailbox; when GOOGLE_ACCOUNT_EMAIL is set, every run first checks that the token really
// belongs to that address and refuses otherwise, so another inbox's token can never be read
// here by mistake. Nothing in this file sends, labels, moves or deletes anything.
import { cfg } from './config.js';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';
const DRIVE = 'https://www.googleapis.com/drive/v3';
const FOLDER = 'application/vnd.google-apps.folder';
const SHEET = 'application/vnd.google-apps.spreadsheet';
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

export const googleConfigured = () => !!(cfg.google.clientId && cfg.google.clientSecret && cfg.google.refreshToken);

let token = { value: null, expires: 0 };

async function accessToken() {
  if (token.value && Date.now() < token.expires - 60_000) return token.value;
  if (!googleConfigured()) throw new Error('Google is not connected: set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and GOOGLE_REFRESH_TOKEN');
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: cfg.google.clientId,
      client_secret: cfg.google.clientSecret,
      refresh_token: cfg.google.refreshToken,
      grant_type: 'refresh_token',
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) {
    throw new Error(`Google sign-in failed: ${body.error_description || body.error || res.status}`);
  }
  token = { value: body.access_token, expires: Date.now() + (body.expires_in || 3600) * 1000 };
  return token.value;
}

// GET with the access token. Retries the usual transient answers (429 / 5xx) a few times.
async function g(url, { binary = false } = {}) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${await accessToken()}` } });
    if (res.ok) return binary ? Buffer.from(await res.arrayBuffer()) : res.json();
    if ((res.status === 429 || res.status >= 500) && attempt < 4) {
      await new Promise((r) => setTimeout(r, 800 * 2 ** attempt));
      continue;
    }
    const body = await res.json().catch(() => ({}));
    throw new Error(`Google ${res.status}: ${body?.error?.message || res.statusText}`);
  }
}

// The address the token belongs to. Throws when it is not the configured account.
export async function whoAmI() {
  const profile = await g(`${GMAIL}/profile`);
  const email = String(profile.emailAddress || '').toLowerCase();
  const want = cfg.google.accountEmail;
  if (want && email !== want) {
    throw new Error(`The Google token belongs to ${email}, not ${want}. Nothing was read.`);
  }
  return email;
}

// ---- Gmail ----

const ymd = (iso) => iso.replace(/-/g, '/');
const DOC_FILE = /\.(pdf|xlsx|xls)$/i;

// Ids of every message since `since` (YYYY-MM-DD) carrying a PDF or spreadsheet.
export async function listMailWithDocuments(since) {
  const query = `has:attachment after:${ymd(since)} (filename:pdf OR filename:xlsx OR filename:xls) -in:chats`;
  const ids = [];
  let pageToken = '';
  do {
    const page = await g(`${GMAIL}/messages?maxResults=500&q=${encodeURIComponent(query)}${pageToken ? `&pageToken=${pageToken}` : ''}`);
    for (const m of page.messages || []) ids.push(m.id);
    pageToken = page.nextPageToken || '';
  } while (pageToken);
  return ids;
}

// One message's sender, subject, date and its PDF / spreadsheet attachments (no bytes yet).
export async function mailAttachments(messageId) {
  const msg = await g(`${GMAIL}/messages/${messageId}?format=full`);
  const header = (name) => (msg.payload?.headers || []).find((h) => h.name.toLowerCase() === name)?.value || null;
  const files = [];
  const walk = (part) => {
    if (!part) return;
    if (part.filename && part.body?.attachmentId && DOC_FILE.test(part.filename)) {
      files.push({ filename: part.filename, attachmentId: part.body.attachmentId, partId: part.partId, size: part.body.size || 0 });
    }
    for (const p of part.parts || []) walk(p);
  };
  walk(msg.payload);
  return {
    id: msg.id,
    threadId: msg.threadId,
    sender: header('from'),
    subject: header('subject'),
    receivedAt: msg.internalDate ? new Date(Number(msg.internalDate)).toISOString() : null,
    url: `https://mail.google.com/mail/u/0/#all/${msg.threadId}`,
    files,
  };
}

export async function mailAttachmentBytes(messageId, attachmentId) {
  const att = await g(`${GMAIL}/messages/${messageId}/attachments/${attachmentId}`);
  return Buffer.from(att.data || '', 'base64url');
}

// ---- Drive ----

const driveList = async (q) => {
  const out = [];
  let pageToken = '';
  do {
    const params = new URLSearchParams({
      q,
      fields: 'nextPageToken, files(id, name, mimeType, size, modifiedTime, createdTime, webViewLink)',
      pageSize: '1000',
      supportsAllDrives: 'true',
      includeItemsFromAllDrives: 'true',
      corpora: 'allDrives',
    });
    if (pageToken) params.set('pageToken', pageToken);
    const page = await g(`${DRIVE}/files?${params}`);
    out.push(...(page.files || []));
    pageToken = page.nextPageToken || '';
  } while (pageToken);
  return out;
};

// "Order 111-2026" / "Shipment 131-2026 (Three Way)" -> the reference that folder stands for.
export function folderReference(name) {
  const m = String(name || '').match(/^\s*(order|shipment)\s+(\d{1,5})\s*[-/_ ]\s*(20\d{2})/i);
  if (!m) return null;
  return { kind: m[1].toLowerCase() === 'order' ? 'italy_order' : 'internal', value: `${Number(m[2])}/${m[3]}` };
}

// Every PDF / spreadsheet under the root folder (default "B2B") changed since `since`.
// "OLD VERSIONS" folders are superseded copies and are skipped. Each file carries the path it
// sits in and, when it sits inside an order or shipment folder, that folder's reference.
export async function listDriveDocuments(since, rootName = cfg.google.driveRoot) {
  const safe = rootName.replace(/['\\]/g, '');
  const roots = await driveList(`name = '${safe}' and mimeType = '${FOLDER}' and trashed = false`);
  if (!roots.length) throw new Error(`No Drive folder named "${rootName}" is visible to this account`);
  const files = [];
  const queue = roots.map((r) => ({ id: r.id, path: r.name, hint: null }));
  const seen = new Set();
  while (queue.length) {
    const dir = queue.shift();
    if (seen.has(dir.id)) continue;
    seen.add(dir.id);
    for (const f of await driveList(`'${dir.id}' in parents and trashed = false`)) {
      if (f.mimeType === FOLDER) {
        if (/^old versions?$/i.test(f.name.trim())) continue;
        queue.push({ id: f.id, path: `${dir.path}/${f.name}`, hint: folderReference(f.name) || dir.hint });
        continue;
      }
      const isSheet = f.mimeType === SHEET;
      if (!isSheet && !DOC_FILE.test(f.name)) continue;
      if ((f.modifiedTime || f.createdTime || '') < since) continue;
      files.push({
        id: f.id,
        filename: isSheet ? `${f.name}.xlsx` : f.name,
        isSheet,
        size: Number(f.size) || 0,
        modifiedAt: f.modifiedTime || f.createdTime || null,
        url: f.webViewLink || null,
        path: dir.path,
        hint: dir.hint,
      });
    }
  }
  return files;
}

export async function driveFileBytes(file) {
  if (file.isSheet) return g(`${DRIVE}/files/${file.id}/export?mimeType=${encodeURIComponent(XLSX_MIME)}`, { binary: true });
  return g(`${DRIVE}/files/${file.id}?alt=media&supportsAllDrives=true`, { binary: true });
}
