import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import { cfg, scopesSatisfied, isCaptainEmail, isAdminEmail } from './config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
import { buildSnapshot, snapshotResponse, publicFormResponse, availabilityResponse, loadSeed, cache } from './snapshot.js';
import { createOrders } from './orders.js';
import { searchCustomers, upsertCustomer } from './customers.js';
import { listCheckoutQueue } from './checkout.js';
import { createPendingRow, savePending, listPending, getPending, markHandled } from './pending.js';
import {
  createShipment,
  listShipments,
  getShipment,
  updateShipment,
  receiveShipment,
  refreshRollup,
  SHIPMENT_STATUSES,
} from './inbound.js';
import multipart from '@fastify/multipart';
import { parseIntakeFile } from './intake.js';
import { addClient, clientCount, broadcast } from './stream.js';
import { verifyShopifyHmac, handleInventoryLevelUpdate } from './webhooks.js';
import {
  signSession,
  verifySession,
  requestMagicLink,
  consumeMagicLink,
  passwordLogin,
} from './auth.js';
import crypto from 'node:crypto';
import { pool, runMigrations } from './db.js';
import { getToken, saveToken, getGrantedScopes } from './tokens.js';
import { buildInstallUrl, verifyOAuthHmac, exchangeToken, SHOP_RE } from './oauth.js';

const app = Fastify({ logger: true });

await app.register(cors, { origin: cfg.appUrl, credentials: true });
await app.register(cookie);
await app.register(multipart, { limits: { fileSize: 25 * 1024 * 1024, files: 1 } });

// Keep the raw body for webhook HMAC verification while still parsing JSON.
app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
  req.rawBody = body;
  try {
    done(null, body ? JSON.parse(body) : {});
  } catch (err) {
    done(err);
  }
});

// App entry point: Shopify loads the App URL as "/?shop=...&hmac=..." right after install.
// If we don't have a token for that shop yet, kick off OAuth instead of serving the PWA.
app.addHook('onRequest', async (req, reply) => {
  if (req.method !== 'GET') return;
  const url = req.raw.url || '';
  if (!url.startsWith('/?')) return;
  const shop = new URLSearchParams(url.slice(2)).get('shop');
  if (!shop || !SHOP_RE.test(shop)) return;
  const token = await getToken(shop).catch(() => null);
  const granted = await getGrantedScopes(shop).catch(() => null);
  if (!token || !scopesSatisfied(granted)) {
    return reply.redirect(`/auth/shopify/install?shop=${encodeURIComponent(shop)}`);
  }
});

function requireAuth(req, reply, done) {
  if (cfg.authDisabled) {
    req.rep = { id: 0, email: 'dev@local', name: 'Dev Rep' };
    return done();
  }
  const payload = req.cookies?.session && verifySession(req.cookies.session);
  if (!payload) {
    reply.code(401).send({ error: 'unauthorized' });
    return;
  }
  req.rep = { id: payload.sub, email: payload.email, name: payload.name };
  done();
}

// ---- Health & identity ----
let lastSyncError = null;

app.get('/api/health', async () => ({
  ok: true,
  snapshotVersion: cache.version,
  products: cache.products.length,
  installed: !!(await getToken(cfg.shopifyStore).catch(() => null)),
  apiVersion: cfg.apiVersion,
  lastError: lastSyncError,
  streamClients: clientCount(),
}));

app.get('/api/me', { preHandler: requireAuth }, async (req) => ({
  rep: { ...req.rep, isCaptain: isCaptainEmail(req.rep.email), isAdmin: isAdminEmail(req.rep.email) },
}));

// ---- Inbound shipments (back-office, ADMIN ONLY — reps never see this) ----
app.get('/api/inbound', { preHandler: requireAuth }, async (req, reply) => {
  if (!isAdminEmail(req.rep.email)) return reply.code(403).send({ error: 'admin only' });
  return { shipments: await listShipments(), statuses: SHIPMENT_STATUSES };
});

app.post('/api/inbound', { preHandler: requireAuth }, async (req, reply) => {
  if (!isAdminEmail(req.rep.email)) return reply.code(403).send({ error: 'admin only' });
  try {
    const ship = await createShipment(req.rep.email, req.body || {});
    await refreshRollup();
    return { ok: true, shipment: ship };
  } catch (err) {
    return reply.code(400).send({ error: String(err?.message || err) });
  }
});

app.post('/api/inbound/:id', { preHandler: requireAuth }, async (req, reply) => {
  if (!isAdminEmail(req.rep.email)) return reply.code(403).send({ error: 'admin only' });
  const ship = await updateShipment(req.params.id, req.rep.email, req.body || {});
  if (!ship) return reply.code(404).send({ error: 'not found' });
  await refreshRollup();
  return { ok: true, shipment: ship };
});

// Parse a supplier ORD/PKLIST document (PDF or XLSX) into shipment lines for review.
app.post('/api/inbound/parse', { preHandler: requireAuth }, async (req, reply) => {
  if (!isAdminEmail(req.rep.email)) return reply.code(403).send({ error: 'admin only' });
  const file = await req.file();
  if (!file) return reply.code(400).send({ error: 'no file' });
  try {
    const buf = await file.toBuffer();
    return { ok: true, parsed: await parseIntakeFile(file.filename, buf) };
  } catch (err) {
    req.log.error({ err }, 'intake parse failed');
    return reply.code(400).send({ error: `Could not parse ${file.filename}: ${err?.message || err}` });
  }
});

// QA receive: counted / damaged / bins per line → good units up in Shopify (or queued on error).
app.post('/api/inbound/:id/receive', { preHandler: requireAuth }, async (req, reply) => {
  if (!isAdminEmail(req.rep.email)) return reply.code(403).send({ error: 'admin only' });
  const ship = await receiveShipment(req.params.id, req.rep.email, req.body || {});
  if (!ship) return reply.code(404).send({ error: 'not found' });
  await refreshRollup();
  return { ok: true, shipment: ship };
});

// ---- Auth ----
app.post('/api/auth/request', async (req, reply) => {
  const email = (req.body?.email || '').trim();
  if (!email) return reply.code(400).send({ error: 'email required' });
  try {
    await requestMagicLink(email);
  } catch (err) {
    req.log.error(err);
  }
  return { ok: true }; // never reveal whether the email exists
});

app.get('/auth/callback', async (req, reply) => {
  const token = req.query?.token;
  const rep = token && (await consumeMagicLink(token).catch(() => null));
  if (!rep) return reply.code(401).send('Invalid or expired link.');
  reply.setCookie('session', signSession(rep), {
    httpOnly: true,
    sameSite: 'lax',
    secure: !cfg.appUrl.startsWith('http://'),
    path: '/',
    maxAge: 60 * 60 * 24 * 30,
  });
  return reply.redirect(cfg.appUrl);
});

// Interim email + password login (no email service needed). Reads REP_LOGINS env JSON.
app.post('/api/auth/login', async (req, reply) => {
  const { email, password } = req.body || {};
  const rep = passwordLogin(email, password);
  if (!rep) return reply.code(401).send({ error: 'invalid credentials' });
  reply.setCookie('session', signSession(rep), {
    httpOnly: true,
    sameSite: 'lax',
    secure: !cfg.appUrl.startsWith('http://'),
    path: '/',
    maxAge: 60 * 60 * 24 * 30,
  });
  return { ok: true, rep: { email: rep.email, name: rep.name } };
});

app.post('/api/auth/logout', async (req, reply) => {
  reply.clearCookie('session', { path: '/' });
  return { ok: true };
});

// ---- Shopify OAuth install (Client ID + Secret → access token) ----
app.get('/auth/shopify/install', async (req, reply) => {
  const shop = String(req.query?.shop || cfg.shopifyStore || '').toLowerCase();
  if (!SHOP_RE.test(shop)) return reply.code(400).send('Add ?shop=your-store.myshopify.com');
  if (!cfg.apiKey || !cfg.apiSecret) {
    return reply.code(500).send('SHOPIFY_API_KEY / SHOPIFY_API_SECRET not configured');
  }
  const existing = await getToken(shop).catch(() => null);
  const granted = await getGrantedScopes(shop).catch(() => null);
  if (existing && scopesSatisfied(granted) && req.query?.reauth !== '1') {
    return reply.redirect(cfg.appUrl); // already installed with all required scopes
  }
  const state = crypto.randomBytes(16).toString('hex');
  reply.setCookie('oauth_state', state, {
    httpOnly: true,
    sameSite: 'lax',
    secure: !cfg.appUrl.startsWith('http://'),
    path: '/',
    maxAge: 600,
  });
  return reply.redirect(buildInstallUrl(shop, state));
});

app.get('/auth/shopify/callback', async (req, reply) => {
  const { shop, code, state } = req.query || {};
  if (!shop || !code) return reply.code(400).send('Missing shop or code');
  if (!SHOP_RE.test(String(shop))) return reply.code(400).send('Invalid shop');
  if (!state || state !== req.cookies?.oauth_state) return reply.code(403).send('OAuth state mismatch');
  if (!verifyOAuthHmac(req.query)) return reply.code(401).send('HMAC verification failed');
  try {
    const { access_token, scope } = await exchangeToken(String(shop), String(code));
    await saveToken(String(shop), access_token, scope);
    reply.clearCookie('oauth_state', { path: '/' });
    ensureLiveSync().catch((err) => req.log.error(err));
    return reply.redirect(cfg.appUrl);
  } catch (err) {
    req.log.error(err);
    return reply.code(500).send(`Install failed: ${err.message}`);
  }
});

// ---- Order capture ----
// Returns up to two draft orders: `ready` (in-stock lines, fulfillable now) and `backorder`
// (out-of-stock lines, flagged with the required deposit) — either may be null.
app.post('/api/orders', { preHandler: requireAuth }, async (req, reply) => {
  try {
    const result = await createOrders(req.rep, req.body || {});
    return { ok: true, ...result };
  } catch (err) {
    req.log.error({ err }, 'draft order failed');
    return reply.code(400).send({ error: String(err?.message || err) });
  }
});

// ---- Customer order form (the digitized paper form) ----
// Two entry paths, one shared pool:
//   kiosk — a rep's booth tablet in locked form mode (rep session cookie) → POST /api/order-forms
//   QR    — a customer's own phone via /?form=<code> (no session; per-event code) → /api/form/*
// Submissions never create Shopify objects directly; they land in pending_orders for rep review.

function formCodeOk(req) {
  const code = String(req.query?.code || '');
  return !!cfg.orderFormCode && code === cfg.orderFormCode;
}

async function acceptSubmission(reply, fields) {
  try {
    const row = createPendingRow(fields);
    await savePending(row);
    broadcast({ type: 'pending', id: row.id, at: Date.now() });
    return { ok: true, id: row.id };
  } catch (err) {
    return reply.code(400).send({ error: String(err?.message || err) });
  }
}

// Kiosk submission (rep-attributed, shared pool).
app.post('/api/order-forms', { preHandler: requireAuth }, async (req, reply) =>
  acceptSubmission(reply, {
    source: 'kiosk',
    repEmail: req.rep.email,
    repName: req.rep.name,
    customer: req.body?.customer,
    lines: req.body?.lines,
    notes: req.body?.notes,
  })
);

// Public (QR) catalog — code-gated; strips the rep-only negotiation config.
app.get('/api/form/catalog', async (req, reply) => {
  if (!formCodeOk(req)) return reply.code(401).send({ error: 'invalid form code' });
  return publicFormResponse();
});

// Public (QR) submission — code-gated, unattributed (rep: none; the pool routes it).
app.post('/api/form/submit', async (req, reply) => {
  if (!formCodeOk(req)) return reply.code(401).send({ error: 'invalid form code' });
  return acceptSubmission(reply, {
    source: 'qr',
    customer: req.body?.customer,
    lines: req.body?.lines,
    notes: req.body?.notes,
  });
});

// Shared pending pool — every rep (and the captain) sees all submissions.
app.get('/api/pending', { preHandler: requireAuth }, async () => ({ pending: await listPending() }));

// Confirm: the reviewing rep's (possibly edited) payload goes through the NORMAL order pipeline
// (wholesale pricing, ready/backorder split, deposit tiers) and the pending row is closed out.
app.post('/api/pending/:id/confirm', { preHandler: requireAuth }, async (req, reply) => {
  const row = await getPending(req.params.id);
  if (!row) return reply.code(404).send({ error: 'not found' });
  if (row.status !== 'pending') return reply.code(409).send({ error: `already ${row.status}` });
  try {
    const result = await createOrders(req.rep, req.body || {});
    await markHandled(row.id, { status: 'confirmed', by: req.rep.email, result });
    return { ok: true, ...result };
  } catch (err) {
    req.log.error({ err }, 'pending confirm failed');
    return reply.code(400).send({ error: String(err?.message || err) });
  }
});

app.post('/api/pending/:id/dismiss', { preHandler: requireAuth }, async (req, reply) => {
  const row = await getPending(req.params.id);
  if (!row) return reply.code(404).send({ error: 'not found' });
  if (row.status !== 'pending') return reply.code(409).send({ error: `already ${row.status}` });
  await markHandled(row.id, { status: 'dismissed', by: req.rep.email });
  return { ok: true };
});

// ---- Checkout-captain queue: the draft orders this app created, parsed with the amount to
// collect now + a deep link to the Shopify draft, for the one person running POS payments. ----
app.get('/api/checkout/queue', { preHandler: requireAuth }, async (req, reply) => {
  if (!isCaptainEmail(req.rep.email)) return reply.code(403).send({ error: 'not a checkout captain' });
  // The queue reads REAL draft orders from Shopify — without an installed token (local dev /
  // pre-OAuth) there's nothing to read; say so instead of erroring.
  if (!(await getToken(cfg.shopifyStore).catch(() => null))) {
    return { queue: [], notInstalled: true };
  }
  try {
    return { queue: await listCheckoutQueue() };
  } catch (err) {
    req.log.error({ err }, 'checkout queue failed');
    return reply.code(500).send({ error: String(err?.message || err) });
  }
});

// ---- Customer lookup (so reps can pick an existing customer instead of retyping their info
// and risking a duplicate Shopify customer record) ----
app.get('/api/customers/search', { preHandler: requireAuth }, async (req, reply) => {
  const q = String(req.query?.q || '').trim();
  if (q.length < 2) return { customers: [] };
  try {
    return { customers: await searchCustomers(q) };
  } catch (err) {
    req.log.error({ err }, 'customer search failed');
    return reply.code(500).send({ error: 'search failed' });
  }
});

// Create/update a wholesale customer profile (name/email/phone + b2b location/specialty/
// collections-of-interest + ship-to address). Returns the saved customer for the cart to attach.
app.post('/api/customers', { preHandler: requireAuth }, async (req, reply) => {
  const body = req.body || {};
  if (!body.email && !body.id) return reply.code(400).send({ error: 'email or id required' });
  try {
    return { customer: await upsertCustomer(body) };
  } catch (err) {
    req.log.error({ err }, 'customer upsert failed');
    return reply.code(400).send({ error: String(err?.message || err) });
  }
});

// ---- Catalog + live inventory ----
app.get('/api/snapshot', { preHandler: requireAuth }, async () => snapshotResponse());

app.get('/api/inventory', { preHandler: requireAuth }, async () => availabilityResponse());

// SSE live stream
app.get('/api/stream', { preHandler: requireAuth }, (req, reply) => {
  reply.hijack();
  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  reply.raw.write(`data: ${JSON.stringify({ type: 'hello', version: cache.version })}\n\n`);
  addClient(reply.raw);
  const hb = setInterval(() => {
    try {
      reply.raw.write(': ping\n\n');
    } catch {
      /* closed */
    }
  }, 25000);
  reply.raw.on('close', () => clearInterval(hb));
});

// ---- Shopify webhook: inventory_levels/update ----
app.post('/webhooks/shopify/inventory-levels', async (req, reply) => {
  const hmac = req.headers['x-shopify-hmac-sha256'];
  if (!verifyShopifyHmac(req.rawBody || '', hmac)) {
    return reply.code(401).send({ error: 'bad hmac' });
  }
  try {
    handleInventoryLevelUpdate(req.body);
  } catch (err) {
    req.log.error(err);
  }
  return reply.code(200).send({ ok: true });
});

// Build the snapshot + start the periodic rebuild once a token is available
// (on boot if already installed, or right after the OAuth callback).
let liveSyncStarted = false;
async function ensureLiveSync() {
  const token = await getToken(cfg.shopifyStore);
  if (!cfg.shopifyStore || !token) return false;
  try {
    await buildSnapshot();
    lastSyncError = null;
  } catch (err) {
    lastSyncError = String(err?.message || err).slice(0, 500);
    app.log.error({ err }, 'snapshot failed');
  }
  if (!liveSyncStarted) {
    liveSyncStarted = true;
    setInterval(() => {
      buildSnapshot()
        .then(() => { lastSyncError = null; })
        .catch((err) => {
          lastSyncError = String(err?.message || err).slice(0, 500);
          app.log.error({ err }, 'snapshot rebuild failed');
        });
    }, 10 * 60 * 1000);
  }
  return true;
}

// ---- Boot ----
async function start() {
  // In production, the same service serves the built PWA → one URL, mobile-reachable, same-origin.
  const webDist = path.resolve(__dirname, '../../web/dist');
  if (fs.existsSync(webDist)) {
    await app.register(fastifyStatic, { root: webDist });
    app.setNotFoundHandler((req, reply) => {
      const u = req.raw.url || '';
      if (u.startsWith('/api') || u.startsWith('/auth') || u.startsWith('/webhooks')) {
        return reply.code(404).send({ error: 'not found' });
      }
      return reply.sendFile('index.html'); // SPA fallback
    });
    app.log.info('Serving built PWA from web/dist');
  }

  if (pool) {
    await runMigrations()
      .then(() => app.log.info('db schema ensured'))
      .catch((err) => app.log.error({ err }, 'migration failed'));
  }

  // Prime the inbound-shipments overlay so the sales floor sees incoming/ETA from day one.
  await refreshRollup().catch((err) => app.log.warn({ err }, 'inbound rollup failed'));

  if (await ensureLiveSync()) {
    app.log.info('Live Shopify sync active.');
  } else if (cfg.shopifyStore && cfg.apiKey && cfg.apiSecret) {
    app.log.warn(`App not installed yet — open ${cfg.appUrl}/auth/shopify/install to authorize and start syncing.`);
    if (loadSeed()) app.log.info('Serving seed showcase data until installed.');
  } else if (loadSeed()) {
    app.log.info('No Shopify credentials — serving seed showcase data.');
  } else {
    app.log.warn('Shopify not configured — serving empty catalog.');
  }

  await app.listen({ port: cfg.port, host: '0.0.0.0' });
  app.log.info(`Baci rep API on :${cfg.port} (auth ${cfg.authDisabled ? 'DISABLED' : 'enabled'})`);
}

start().catch((err) => {
  app.log.error(err);
  process.exit(1);
});
