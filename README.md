# Baci Milano — B2B Rep "Sales Floor" App

Offline-first PWA that gives B2B reps live stock, wholesale pricing, an out-of-stock playbook,
and on-the-spot order capture (Shopify draft orders). Reps never touch Shopify admin.

Spec: see `BUILD-SPEC.md` in the `miamiironside` repo (`baci-b2b-rep-app/BUILD-SPEC.md`).

## Layout

```
server/   Node + Fastify backend — snapshot API, live-sync (webhook → SSE), magic-link auth, draft orders
web/      React + Vite + Dexie PWA — search → live product card, offline cache, instant resync
```

## Quick start (M1 — lookup + live sync)

```bash
# 1) Backend
cd server
cp .env.example .env          # fill in SHOPIFY_STORE + SHOPIFY_ADMIN_TOKEN
#   For a fast first run with no DB/email, set AUTH_DISABLED=true in .env
npm install
npm run dev                   # http://localhost:8080

# 2) Frontend (separate terminal)
cd web
npm install
npm run dev                   # http://localhost:5173  (proxies /api → :8080)
```

With `AUTH_DISABLED=true` you only need the Shopify token to see the live lookup UI.
Magic-link auth + draft-order capture (M2) need Postgres + Resend (see `server/.env.example`).

## Confirmed settings (baked in, overridable via env)

- Sellable location: **Miami Warehouse only** (`gid://shopify/Location/104277705016`)
- Low stock: available **< 10**
- Wholesale: retail − **35%** (per-variant `b2b.wholesale_price` overrides) — read live from shop metafields
- Volume ladder: read live from shop metafield `b2b.volume_discount_tiers`

## Deploy (Render + Shopify OAuth)

This app authenticates to Shopify via **OAuth** using your app's **Client ID + Client Secret** —
no manual Admin API token needed. Install once and a permanent offline token is stored in Postgres.

1. Push this repo to GitHub and connect it in **Render → New → Blueprint** (`render.yaml` provisions
   one web service + Postgres).
2. Set env vars on the service: `SHOPIFY_API_KEY` (Client ID), `SHOPIFY_API_SECRET` (Client Secret),
   `APP_URL` (the service's `https://…onrender.com` URL), `RESEND_API_KEY`. `SHOPIFY_STORE`,
   `SHOPIFY_SCOPES`, `JWT_SECRET`, and `DATABASE_URL` come from the blueprint.
3. In your Shopify app config, set:
   - **App URL:** `{APP_URL}`
   - **Allowed redirection URL:** `{APP_URL}/auth/shopify/callback`
4. After it deploys, open **`{APP_URL}/auth/shopify/install`** once, approve, and all products sync.
   (A static `SHOPIFY_ADMIN_TOKEN` is also supported and takes precedence if you ever set one.)

## Milestones

- **M1** — lookup + offline cache + live-sync engine  ← _this scaffold_
- **M2** — cart + capped volume discount + Shopify draft-order writeback
- **M3** — quote PDF, backorder/reserve, analytics, barcode scan
