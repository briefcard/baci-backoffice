import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import { cfg, scopesSatisfied } from './config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
import { buildSnapshot, snapshotResponse, availabilityResponse, loadSeed, cache } from './snapshot.js';
import { createDraftOrder } from './orders.js';
import { addClient, clientCount } from './stream.js';
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

app.get('/api/me', { preHandler: requireAuth }, async (req) => ({ rep: req.rep }));

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
app.post('/api/orders', { preHandler: requireAuth }, async (req, reply) => {
  try {
    const result = await createDraftOrder(req.rep, req.body || {});
    return { ok: true, ...result };
  } catch (err) {
    req.log.error({ err }, 'draft order failed');
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

// ---- M2 placeholder ----
app.post('/api/orders', { preHandler: requireAuth }, async (req, reply) =>
  reply.code(501).send({ error: 'draft-order capture lands in M2' })
);

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
