import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import { cfg } from './config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
import { buildSnapshot, snapshotResponse, availabilityResponse, loadSeed, cache } from './snapshot.js';
import { addClient, clientCount } from './stream.js';
import { verifyShopifyHmac, handleInventoryLevelUpdate } from './webhooks.js';
import {
  signSession,
  verifySession,
  requestMagicLink,
  consumeMagicLink,
} from './auth.js';

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
app.get('/api/health', async () => ({
  ok: true,
  snapshotVersion: cache.version,
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

app.post('/api/auth/logout', async (req, reply) => {
  reply.clearCookie('session', { path: '/' });
  return { ok: true };
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

  if (cfg.shopifyStore && cfg.shopifyToken) {
    await buildSnapshot().catch((err) => app.log.error({ err }, 'initial snapshot failed — will retry'));
    // Periodic rebuild catches product/price/metafield edits (inventory comes via webhook).
    setInterval(
      () => buildSnapshot().catch((err) => app.log.error({ err }, 'snapshot rebuild failed')),
      10 * 60 * 1000
    );
  } else if (loadSeed()) {
    app.log.info('No Shopify token — serving seed showcase data (server/seed-snapshot.json).');
  } else {
    app.log.warn('SHOPIFY_STORE / SHOPIFY_ADMIN_TOKEN not set — serving empty catalog until configured.');
  }

  await app.listen({ port: cfg.port, host: '0.0.0.0' });
  app.log.info(`Baci rep API on :${cfg.port} (auth ${cfg.authDisabled ? 'DISABLED' : 'enabled'})`);
}

start().catch((err) => {
  app.log.error(err);
  process.exit(1);
});
