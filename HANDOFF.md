# Baci Milano — B2B Rep "Sales Floor" App · Handoff / Context Document

_Last updated: 2026-07-01. Share this whole file with a new Claude thread to continue._

---

## 0. TL;DR — where things stand

An offline-first PWA that lets ~10 Baci Milano B2B sales reps, on tradeshow floors / calls,
see live stock + wholesale pricing and capture orders as **Shopify draft orders**. It's built
(M1 lookup + M2 order capture + customer matching + BackOrder) and deployed to Render, but the
**live Shopify catalog sync has been the hard part** — a chain of 5 bugs, all now fixed in code.

**Right now:** all fixes are committed locally (HEAD = `ab04334`). The owner needs to **push +
redeploy + re-authorize** (a scope change was added). After that, verify the live catalog syncs
and test order capture. See §8 (Immediate next steps).

- **Repo:** https://github.com/briefcard/baci-backoffice (branch `main`)
- **Local path:** `~/Documents/baci-rep-app`
- **Live URL:** https://baci-backoffice.onrender.com
- **Health/diagnostics:** `GET https://baci-backoffice.onrender.com/api/health` →
  `{ installed, products, snapshotVersion, apiVersion, lastError, streamClients }` (unauthenticated)

---

## 1. The business & the goal

- **Company:** Baci Milano (Italian-**designed**, mass-manufactured tableware/home décor; NOT
  made-in-Italy/handmade — never claim that). Store: bacimilanousa.com.
- **Problem being solved:** reps use a paper SKU/price order form; when a customer wants an
  out-of-stock item they lose momentum. This app gives instant live stock + wholesale price +
  out-of-stock playbook + on-the-spot order capture — **without giving reps Shopify admin access**
  and **without a giant spreadsheet**.
- **Reps:** ~10 to start, individual logins.

## 2. Shopify account facts (important constraints)

- **Plan: standard Shopify, NOT Plus** → native Shopify B2B (companies/wholesale catalogs/price
  lists) is unavailable. That's why we built custom.
- **Store domains:** public `bacimilanousa.com`; **.myshopify = `769684-2.myshopify.com`**.
- **Shop gid:** `gid://shopify/Shop/76919931192`.
- **App:** a Shopify app named "Baci Backoffice". The owner has **only the Client ID + Client
  Secret** (Partner-style app) — no pre-made Admin API token — so we use the **OAuth install flow**.
  - **Client ID (API key, public/safe):** `359ebdfd44d98e0ccf430f1110298b0e`
  - Client Secret is NOT in the repo (env var only; also doubles as the webhook HMAC secret).
- **Locations** (3):
  - `gid://shopify/Location/104277705016` — **Miami Warehouse** = the ONLY "sellable" location
    (available-to-sell + incoming are read from here).
  - `gid://shopify/Location/107087429944` — B2B Virtual Warehouse (excluded from sellable).
  - `gid://shopify/Location/84262060344` — 1835 E Hallandale Beach Blvd (office; excluded).
- **Catalog:** 268 products total; ~250 after B2B exclusion (see §4). ~1 variant per product mostly.

## 3. Architecture

Single Render **web service** serves BOTH the API and the built PWA (one origin, mobile-reachable),
plus a Render Postgres. Shopify is the single source of truth.

```
 SHOPIFY  ──(OAuth token)──▶  RENDER (Node/Fastify)  ──serves──▶  PWA (React/Vite, offline-first)
  products/variants/inv        /api/snapshot (catalog+stock)       IndexedDB cache (Dexie)
  b2b.* metafields             /api/inventory?since= (deltas)      SSE live updates
  inventory_levels/update ───▶ /api/stream (SSE live push)         search + Collection/Type/Material
  draftOrderCreate ◀────────── /api/orders (draft orders)          cart → draft order
                               /auth/shopify/* (OAuth)             rep login (password or magic link)
                               Postgres: shop_tokens, reps, audit
```

- **Backend:** Node + **Fastify**, ESM. `@fastify/static` serves `web/dist` in production with an
  SPA fallback (excludes `/api /auth /webhooks`). Shopify Admin **GraphQL**.
- **Frontend:** **React + Vite + vite-plugin-pwa (Workbox)** + **Dexie** (IndexedDB). Mobile-first.
- **Live sync design:** snapshot cached on device; SSE push on `inventory_levels/update`; instant
  re-sync on reconnect; polling backstop. (Webhook registration itself is not yet wired — periodic
  10-min rebuild + SSE scaffold are in place; see §7 pending.)

## 4. Locked business rules

- **Wholesale price** (rep-facing, they can't edit a line): per-variant `b2b.wholesale_price`
  metafield if set, else **50% of MSRP / retail − 50%** (global `b2b.wholesale_discount_pct` shop
  metafield = 50, changed from 35 on 2026-07-01 per owner — "all products at 50% MSRP base").
- **MSRP** = retail (shown struck-through next to the B2B price).
- **Volume discount ladder** (the ONLY negotiation lever; order-level, capped by wholesale
  subtotal): 0 under $10k, **+2% per $10k band, cap +10% at $50k+**. Stored in shop metafield
  `b2b.volume_discount_tiers` (JSON). Rep can apply 0→cap in the cart.
- **Low stock:** available `< 10`. **Out:** `<= 0`.
- **Sellable location:** Miami Warehouse only (`104277705016`).
- **Design** (the pattern line) = the **last dash-separated segment of the product title**
  (e.g. "…- Aqua"). Reliable heuristic.
- **Main collections** (the ONLY ones shown at top of browse, in this order): Mamma Mia,
  Sagrada Familia, Aqua, Zodiac Cups (`zodiac-vibe`), Dolce Far Niente (`dolce-far-niente` — VERIFY
  this handle exists), Portofino, Crystal Touch, Firenze, Teste Matte, Baroque & Rock, Joke.
  All other collections (SEO/system: `all`, `appplaza-best-sellers`, the 4 `baci-milano-*` megas,
  `for-shopify-performance-tracking`, `featured-items`, `baci-summer-collections`) are excluded.
- **Materials** (filter; derived from product **tags**): Acrylic, Melamine, Porcelain, Polyresin,
  Polycarbonate, Bamboo, Cotton, Stainless Steel. **NO Glass, NO Crystal.** "CPC" and the
  "Crystal Touch" line map to **Polycarbonate**. (They don't carry glass; cups are Acrylic or
  Porcelain; Crystal Touch is CPC/Polycarbonate.)
- **B2B exclusion:** products whose **title or tags contain "B2B"** are excluded from the catalog
  (owner's rule — e.g. "(B2B Only)" items are internal). Applied in `buildSnapshot` + seed loader.
- **"BackOrder"** = **units on order / on the way to US** (incoming inventory), NOT a customer
  backordering. Read from Shopify's native **`incoming`** quantity at the Miami location.
  ASSUMPTION to confirm: incoming lands at Miami; if POs/transfers target another location,
  change `$loc` accordingly.
- **Ready-vs-backorder order split (owner, 2026-07-01):** a cart with both in-stock and
  out-of-stock quantity is submitted as **two separate Shopify draft orders** — a "ready to
  ship" one (in-stock lines, full price) and a "backorder" one (the shortfall, deposit required)
  — rather than one mixed order. Split is **per line**: if a rep orders 15 and only 8 are
  available, 8 goes on the ready order and 7 on the backorder one. The volume-discount cap is
  computed off the **combined** subtotal of both (so splitting can't change the tier), then the
  same rep-chosen % is applied to each draft independently.
- **Backorder deposit tiers (owner, 2026-07-01):** **40%** deposit for a **new customer**, **30%**
  for a **repeat/B2B customer** — defined as a Shopify customer record carrying a tag matching
  `/b2b/i` (owner tags trusted wholesale accounts "B2B" in Shopify Admin). Checked **server-side**
  from the resolved customer's live tags — never trusted from the client, so a rep can't
  influence their own deposit tier. If no customer is attached, defaults to the new-customer
  (40%) tier. Stored in shop metafield `b2b.deposit_pct` (JSON, editable in Admin without a
  redeploy — see §5). We do **not** attempt to make Shopify's draft-order total literally equal
  the deposit (no negative custom line-item hacks); standard Shopify draft orders have no clean
  partial-payment primitive. Instead the backorder draft order carries the *real* line items at
  full wholesale price, tagged `backorder` + `deposit-required` + `deposit-pct:<n>`, with the
  deposit %, deposit $, and balance $ stamped as **customAttributes** (visible on the order page)
  and in the note — office/POS collects the deposit as a manual/custom-amount charge against that
  draft, guided by those numbers.

## 5. Shopify metafields (all created live, namespace `b2b`)

Product-variant: `wholesale_price` (money, def 238377402680), `case_pack` (int, 238377435448),
`min_order_qty` (int, 238377468216), `restock_eta` (date, 238377500984).
Product: `substitutes` (list.product_reference, 238377533752).
Customer (created 2026-07-01, all pinned, for the wholesale profile captured during order
drafting): `location` (single_line_text_field, def 238846804280 — City/State/full address or
"ONLINE ONLY"), `specialty` (single_line_text_field, def 238847394104 — Gift Store / High End
Tabletop / Home Decor / etc.), `collections_of_interest` (list.single_line_text_field, def
238847426872 — the app's main design-line collections). Written via `customerCreate`/`customerUpdate`
(CustomerInput.metafields); the real ship-to **address** is set separately via `customerAddressCreate`
(setAsDefault). Card-on-file is NOT a metafield — it's a per-order flag (see §4 / §9a).
Shop: `wholesale_discount_pct` (number_decimal = **35**, def 238407680312),
`volume_discount_tiers` (json, def 238407713080),
`deposit_pct` (json = `{"new_customer":40,"repeat_customer":30}`, def 74254784856376, created
2026-07-01). Most are unpopulated (pricing works off the 50% default with zero data entry;
overrides/ETAs/substitutes are optional polish).

## 6. Auth model

- Reps authenticate to the PWA only (never Shopify). Session = JWT in an httpOnly cookie.
- **`AUTH_DISABLED=true`** bypasses login (LOCAL DEV ONLY — set in `server/.env`; Render = false).
- **Interim password auth:** `REP_LOGINS` env var = JSON, e.g.
  `[{"email":"jane@bacimilanousa.com","name":"Jane","password":"..."}]` (or `{"email":"pw"}` map).
  Plaintext, env-only, fine for an internal tool. `POST /api/auth/login`.
- **Magic-link** path exists (`/api/auth/request` + `/auth/callback`) but needs a `RESEND_API_KEY`
  (not set yet). Switch to it later with no code changes.
- The **Shopify Admin token** lives only server-side (obtained via OAuth, stored in Postgres
  `shop_tokens`; falls back to a static `SHOPIFY_ADMIN_TOKEN` env if ever set).

## 7. What's built & working vs pending

**Built (committed):**
- M1 lookup: offline-first PWA, snapshot, search, **Collection → Product Type → Material** filter
  rows (products always visible), big color-coded stock number, MSRP + B2B price, out-of-stock
  sorted to the bottom, mobile-first, "Showcase · N" pill when serving seed data.
- OAuth install (Client ID/Secret → token), password auth, `/api/health` diagnostics.
- **M2 order capture:** "+ Add to order" + qty stepper per SKU → floating cart bar → cart drawer
  (line items @ wholesale, subtotal, capped volume-discount input, customer name/email/phone,
  notes) → `POST /api/orders` → `draftOrderCreate`. Per-line `appliedDiscount` = wholesale %,
  order-level `appliedDiscount` = capped volume %, `note`, tags `b2b-app`+`rep:<name>`,
  customAttributes (Sales rep / Rep email / Customer / Phone). Returns draft name + invoiceUrl.
- **Customer matching:** find existing customer by email (dedupe) or create; attach via
  `purchasingEntity.customerId`; graceful fallback to email-on-draft. (Needs the scope re-auth.)
- **BackOrder:** reads `incoming` qty; card shows "+N incoming" and "BackOrder · ETA".
- **Customer lookup + profile (2026-07-01):** `CustomerPicker.jsx` — debounced search-as-you-type
  against real Shopify customers (`GET /api/customers/search?q=`), so a rep selects an existing
  customer instead of retyping info and risking a duplicate. "Add new" / "Edit" opens a full
  **wholesale profile form**: name, email, phone, an **Online-only** toggle, ship-to **address**
  (street/city/state/zip), **Specialty** (datalist suggestions), and **Collections of interest**
  (multi-select chips from the app's main collections). Saving `POST`s to `/api/customers`
  (`upsertCustomer` — create or dedupe-by-email/id, writes the b2b.* customer metafields, and sets
  the default Shopify address when a full physical address is given & not online-only). The picked
  customer's `id` is sent to `/api/orders`; the server re-resolves it and reads that customer's
  **live tags** itself — the deposit tier can't be spoofed by the client.
- **Card on file (2026-07-01):** a "Card on file — save at the register (POS)" checkbox in the
  cart. Checking it stamps the draft order(s) with a `card-on-file` tag + "Card on file"
  customAttribute; the checkout captain sees a **💳 Save card** badge on that queue row and vaults
  the card via the POS reader when the customer is present. **No card number is ever entered into
  or stored by this app** — that's a deliberate PCI/compliance decision (Shopify's API has no
  raw-card store; cards can only be vaulted through secure checkout or a card reader).
- **Ready/backorder order split + deposit (2026-07-01):** `createOrders()` in `orders.js` (renamed
  from `createDraftOrder`) splits each line by live stock, prices both groups, and submits up to
  two draft orders. `Cart.jsx` shows the split live (as the rep builds the cart) with a deposit
  preview box, defaulting to the 40% new-customer tier until a customer is picked. See §4 for the
  full rule and §9 for why we didn't try to fake a deposit-sized total on the draft order itself.

**Pending / not yet done:**
- **The live sync has never successfully completed in production yet** — it's now unblocked by the
  fixes but requires the deploy + re-auth (§8). Until then Render shows 0 products.
- Register the `inventory_levels/update` **webhook** for true real-time push (currently periodic
  10-min rebuild + SSE scaffold only).
- Confirm BackOrder `incoming` location assumption.
- Later/optional: quote PDF, reserve-against-incoming, per-rep analytics, order_audit DB writes,
  barcode camera scan (variant barcodes are empty; boxes have codes — backfill needed).

## 8. IMMEDIATE NEXT STEPS (do these first)

1. **Update app scopes in Shopify** (customer matching added `read_customers`/`write_customers`):
   ```bash
   cd ~/Documents/baci-rep-app && npx @shopify/cli@latest app deploy
   ```
2. **Push** so Render redeploys (HEAD `ab04334` must be on GitHub):
   ```bash
   git push
   ```
3. **Re-authorize:** open `https://baci-backoffice.onrender.com/?shop=769684-2.myshopify.com`
   in a browser logged into the store. The server auto-detects the missing scopes and redirects to
   Shopify's Approve screen (now including customer access). Approve.
   - IMPORTANT: do this in a context WITHOUT a stale service worker (incognito, OR DevTools →
     Application → Service Workers → Unregister) the first time, because a cached old SW can
     intercept the `/auth` navigation.
4. **Verify:** `curl https://baci-backoffice.onrender.com/api/health` → expect
   `installed:true`, `products` ~250, `lastError:null`, `apiVersion:"2026-04"`.
5. **Test order capture** on the live app: add items → Review order → fill customer + notes →
   Create draft order → confirm it appears in Shopify → Orders → Drafts, priced at wholesale,
   tagged with the rep, and that an existing-customer email attaches (no duplicate).

## 9. The bug-fix chain (so you don't re-litigate "why doesn't it work live")

Live sync showed 0 products for a long time. The data + query were always fine (verified: 268
products). Root causes, ALL FIXED:
1. **App URL didn't initiate OAuth** — Shopify loads `/?shop=...` after install; the server just
   served the PWA. Fix: onRequest hook redirects `/?shop=...`→`/auth/shopify/install` when no token
   or missing scopes (commit 2291b52).
2. **API version `2025-01` out of Shopify support** → bumped to `2026-04` (58a9c75).
3. **Production service worker intercepted `/auth`** (Workbox served cached shell, OAuth never hit
   server — "works in curl/local, fails in browser"). Fix: `navigateFallbackDenylist` for
   `/auth /api /webhooks` in `web/vite.config.js` + made `/install` idempotent (359e2f8).
4. **Snapshot query MAX_COST_EXCEEDED** (cost 1346 > 1000). Fix: shrink to `products(30)` /
   `variants(40)` / `collections(12)` and fetch **only Miami** via `inventoryLevel(locationId:$loc)`
   (single, not the `inventoryLevels` connection) — validated < 1000 (5fe0abb).
5. **Duplicate `/api/orders` route** (old M2 placeholder + new route) crashed boot with
   `FST_ERR_DUPLICATED_ROUTE` — only trips at runtime, not `node --check`. Fixed (ab04334).

Diagnosis tool: `/api/health.lastError` surfaces the exact sync error. Use it.

## 9a. Using this app alongside Shopify POS (owner question, 2026-07-01)

**Recommendation: don't build payment capture into this app — let it feed Shopify POS, don't
replace it.** The two tools solve different problems and the handoff between them is already a
first-class Shopify feature:

- This app is the **quoting/lookup/cart-builder**: live stock, wholesale pricing, the OOS
  playbook, offline capability, the volume-discount ladder, and now the ready/backorder split —
  none of which POS knows how to do for this catalog. Its job ends at creating a draft order.
- **Shopify POS has a native "Draft orders" screen** that lists/searches every draft order on the
  shop (not just POS-created ones). A rep builds the cart on this PWA → creates the draft
  order(s) → **any staff member with the POS app on a register/tablet at the booth can open that
  exact draft order and check the customer out** (card swipe, tap, or cash), which converts it to
  a real completed order and decrements inventory the normal Shopify way. That *is* the "actual
  order-taking" step — we don't need to reimplement it.
- For the **backorder/deposit** draft order specifically: POS can still open it, but standard
  (non-Plus) Shopify draft orders have no built-in "charge X now, invoice the rest later"
  primitive. Practical flow: staff opens the backorder draft in POS/Admin and takes a
  **custom-amount payment** for just the deposit (the exact %, $, and balance are stamped on the
  draft's tags/customAttributes/note by this app, so the number to charge is unambiguous) — then
  either invoice the balance when the item ships, or complete the order for the full remaining
  amount at that time.
- **What we deliberately did NOT do:** build Stripe/Payments-API charge logic into this PWA, or
  fake a deposit-sized total via a negative custom line item on the draft order. Both add
  complexity/compliance surface for no real benefit — POS already has payment collection solved,
  and a draft order's true total should reflect the real sale for accounting.
- **Unverified — confirm once live:** whether POS's "Draft orders" list is scoped to a specific
  register/location, and whether a draft order created with `purchasingEntity.customerId` but no
  explicit location behaves as expected in POS at a tradeshow (vs. the online-only context this
  API token operates in). Worth a dry run with the actual POS device before the first live event.

**Customer order form (BUILT 2026-07-02):** the digitized version of the paper tradeshow order
form (`ORDER_FORM_US_DRAFT_3.pdf` — sections per collection in the printed catalogue's order:
Mamma Mia → Zodiac → Joke → Crystal Touch → Baroque&Rock → Aqua → Sagrada Familia → Teste Matte
→ Firenze → Portofino → Dolce Far Niente → "Everything else" catch-all). Customers browse,
punch in quantities, submit. **Unit wholesale prices show; totals are NEVER rendered in customer
mode** (nothing sums client-side). Only items in Shopify appear; new products show up in their
collection automatically on the next snapshot sync.
- **Two entry paths → one shared pool:** (1) *Kiosk* — rep taps "📋 Form" in the header; the
  tablet locks into form mode (no rep UI; exit needs the rep's password, dev bypasses); runs off
  the cached snapshot, so it works offline and queues submissions in IndexedDB (flushed on
  reconnect). (2) *QR/public* — customers open `/?form=<code>` on their own phone;
  `ORDER_FORM_CODE` env gates `/api/form/catalog` + `/api/form/submit` (the public catalog strips
  the volume-tier + deposit config; UNSET code = public form disabled). Friendly code re-entry
  screen on 401.
- **Pending pool:** submissions land in `pending_orders` (Postgres; in-memory fallback when no
  DATABASE_URL) via `server/src/pending.js`, broadcast over SSE (`type:pending`). Every rep sees
  the **Pending** tab (badge count, 60s poll + SSE push). Open → seeds the normal Cart review
  (live totals, volume discount, deposit preview, CustomerPicker prefilled with the buyer's
  company/contact/email/phone, card-on-file) → **Confirm** hits `/api/pending/:id/confirm`, which
  runs the standard `createOrders` pipeline (ready/backorder split + deposits + captain queue)
  and closes the row (audit: handled_by/at + draft names). Dismiss also audited; conflict-guarded
  (409 if already handled). Confirm failures leave the row pending (retry-safe).
- **Print:** 🖨 button renders `PrintOrderForm` (cover page with company-info blanks like the
  paper form's page 1, then per-collection tables: photo, item, SKU, unit price, blank qty box)
  and calls `window.print()` — print it the morning of a show and it's automatically current.
- Files: `server/src/pending.js`, `web/src/components/{OrderFormView,PendingView,PrintOrderForm}.jsx`,
  `web/src/formSections.js` (shared section builder + offline submit queue), routes in server.js,
  `ORDER_FORM_COLLECTION_HANDLES`/`orderFormCode` in config.js, Dexie v2 `queuedForms`.

**Checkout-captain queue (BUILT 2026-07-01, in the app):** a dedicated **Checkout** tab in this
same PWA, so one person running POS doesn't have to hunt drafts or do deposit math. It lists the
draft orders this app created (`GET /api/checkout/queue` → Shopify `draftOrders(query:"tag:b2b-app",
sortKey:UPDATED_AT, reverse:true)`, parsed in `server/src/checkout.js`), each row showing: draft #,
**Ready vs Deposit** badge, customer, rep, and **the exact amount to collect now** (full total for
ready, the stamped deposit $ for backorders — with the balance shown too). "Take payment ▸"
deep-links straight to that draft's **Shopify Admin page** (`admin.shopify.com/store/<handle>/
draft_orders/<legacyResourceId>`) where the captain collects payment / sends it to POS. Auto-refreshes
every 20s; open orders on top, "Completed" (draft has `completedAt`) greyed below. Gated by
`CAPTAIN_EMAILS` env (comma list; **empty = every logged-in rep sees it**, which is the current
default and what dev/AUTH_DISABLED uses) — set it to lock the tab to one person. `isCaptain` comes
back on `/api/me`; the queue route also hard-checks it server-side (403 otherwise).
- **Possible scope follow-up:** the draftOrders read validated as also wanting `read_quick_sale`.
  Our existing `read_draft_orders` almost certainly covers it (the create mutation already works),
  but if `/api/checkout/queue` ever 403/scope-errors live, add `read_quick_sale` to `cfg.scopes`
  and re-auth. Not added pre-emptively to avoid risking the OAuth install URL with an unverified
  scope name.

## 10. File map (server/src + web/src)

- `server/src/config.js` — env config; `MATERIALS`, `MAIN_COLLECTIONS`, `scopes`, `scopesSatisfied()`,
  excluded collections, sellable location, discount %.
- `server/src/snapshot.js` — `buildSnapshot()` (paginates products, Miami inventory available+incoming,
  materials/design/collections, B2B exclusion), `loadSeed()` (serves `seed-snapshot.json` when no
  token), `snapshotResponse()` (+ mainCollections), in-memory `cache`.
- `server/src/orders.js` — `createOrders(rep, body)` (renamed from `createDraftOrder`, 2026-07-01):
  splits lines into ready/backorder by live stock, prices both, computes the shared volume-discount
  cap + the deposit tier, submits up to two `draftOrderCreate` calls. Returns `{ready, backorder}`.
- `server/src/customers.js` (new 2026-07-01, expanded same day) — `searchCustomers(q)` (returns
  profile fields + address), `upsertCustomer(profile)` (create/dedupe + b2b.* metafields +
  `customerAddressCreate` default address), `resolveCustomer(customer)` (fetches fresh tags
  server-side; never trusts client tier info), `isRepeatCustomer(tags)` (tag matching `/b2b/i`).
- `server/src/checkout.js` (new, 2026-07-01) — `listCheckoutQueue()`: reads `tag:b2b-app` draft
  orders and parses each into the captain-facing row (type, rep, customer, dueNow, deposit/balance,
  Admin deep link). Amount-to-collect prefers the stamped deposit $, falls back to total×pct.
- `server/src/oauth.js` — install URL, HMAC verify, code→token exchange. `SHOP_RE` regex.
- `server/src/tokens.js` — token + granted-scope storage (Postgres `shop_tokens`, memory-cached);
  `getToken`, `getGrantedScopes`, `saveToken`.
- `server/src/server.js` — Fastify app, all routes (incl. `/api/customers/search`), onRequest OAuth
  entry hook, static serving, `ensureLiveSync()`, boot.
- `server/src/domain.js` — pricing/availability/rank helpers (server copy).
- `server/src/{auth,db,shopify,stream,webhooks}.js` — magic-link/password auth, pg pool + migrate,
  Admin GraphQL client (uses token from tokens.js), SSE broadcast, webhook HMAC + inventory handler.
- `server/schema.sql` — reps, magic_links, sessions, order_audit, webhook_events, shop_tokens.
- `web/src/App.jsx` — shell, login, search vs BrowseView, cart bar + Cart overlay (passes
  `s.availability` into `<Cart>`); captures `me` from `/api/me` and, for captains, shows a
  Browse/Checkout tab toggle (2026-07-01).
- `web/src/components/{BrowseView,ProductCard,Cart,CustomerPicker,CheckoutView}.jsx` — browse
  filters, product card (+ AddControl, stock, BackOrder), cart drawer (ready/backorder sections +
  deposit preview, 2026-07-01), customer search-or-add typeahead (2026-07-01), captain checkout
  queue with amount-to-collect + Admin deep link (2026-07-01, new file).
- `web/src/{cart,sync,api,db,domain}.js` — cart store, sync engine (snapshot/SSE/offline), fetch
  wrapper (+ `searchCustomers`, `checkoutQueue`), Dexie, client domain mirror (`maxAdditionalPct`,
  `money`, `productRank`, etc.).
- `web/vite.config.js` — PWA config incl. the critical `navigateFallbackDenylist`.
- `render.yaml` — Blueprint (web service `baci-backoffice` + Postgres `baci-backoffice-db` + env).
- `shopify.app.toml` — app config (scopes, redirect_urls, App URL, embedded=false,
  use_legacy_install_flow=true). Deployed via `shopify app deploy`.
- `server/seed-snapshot.json` — 24-product real showcase seed (Aqua + Sagrada Familia), gitignored,
  served when no token. `BUILD-SPEC.md` — the fuller original spec.

## 11. Env vars (Render web service)

`SHOPIFY_STORE=769684-2.myshopify.com`, `SHOPIFY_API_KEY`=Client ID, `SHOPIFY_API_SECRET`=Client
Secret (also webhook HMAC), `SHOPIFY_SCOPES` (now includes read_customers,write_customers — or
leave unset to use the code default which includes them), `APP_URL=https://baci-backoffice.onrender.com`,
`AUTH_DISABLED=false`, `REP_LOGINS` (JSON), `JWT_SECRET` (auto), `DATABASE_URL` (from DB),
`RESEND_API_KEY` (not set yet), `SHOPIFY_API_VERSION` (optional; code default 2026-04),
`CAPTAIN_EMAILS` (optional comma list; empty = every rep sees the Checkout tab; set to lock POS
checkout to one dedicated person), `DEFAULT_DEPOSIT_NEW_PCT`/`DEFAULT_DEPOSIT_REPEAT_PCT`
(optional; fallbacks if the `b2b.deposit_pct` shop metafield is missing — 40/30),
`ORDER_FORM_CODE` (per-event code for the public QR order form at `/?form=<code>`; unset =
public form disabled, kiosk mode unaffected; rotate per show),
`ORDER_FORM_COLLECTION_HANDLES` (optional; overrides the printed-catalogue section order).

## 12. Run locally

```bash
cd server && cp .env.example .env   # set AUTH_DISABLED=true to skip login; SHOPIFY creds optional
npm install && npm start            # :8080, serves seed if no token
# separate terminal:
cd web && npm install && npm run dev -- --host   # :5173, proxies /api → :8080
```
Local uses NO service worker (Vite dev), which is why OAuth issues only appear in production.
`server/.env` and `server/seed-snapshot.json` are gitignored.

## 13. Gotchas that bit us (read before changing things)

- Adding fields/connections to the snapshot query risks MAX_COST_EXCEEDED. Validate cost with a
  test query via the Shopify MCP before deploying (single-location `inventoryLevel` keeps it cheap).
- The PWA service worker WILL intercept navigations in production — keep `/auth /api /webhooks` in
  `navigateFallbackDenylist`, and clear the old SW (incognito/unregister) when testing OAuth.
- `node --check` does NOT catch Fastify duplicate-route or runtime errors — actually boot the
  server (`npm start`) after route changes.
- `Customer.email` output field is deprecated (use `defaultEmailAddress.emailAddress`); the
  `customers(query:"email:...")` filter still works and we only select `id`.
- Scope changes require `shopify app deploy` (tells Shopify) + re-auth; the server auto-triggers
  re-auth via `getGrantedScopes` + `scopesSatisfied`.
- `gh` CLI and `jq` are NOT installed on the owner's machine; use `git`/`node` directly. Pushing to
  GitHub needs a PAT (password auth is disabled) or the Claude GitHub connector authorized on the
  `briefcard` org.

## 14. Commit history (most recent first)

**NOT YET COMMITTED (2026-07-01):** ready/backorder order split + deposit tiers + customer
lookup (§4, §7, §9a above) — `server/src/customers.js` (new), `server/src/orders.js` (rewritten,
`createDraftOrder`→`createOrders`), `server/src/server.js` (+`/api/customers/search`),
`server/src/{config,snapshot}.js` (deposit config), `web/src/components/CustomerPicker.jsx` (new),
`web/src/components/Cart.jsx` (rewritten), `web/src/{api,App}.jsx`, `web/src/styles.css`. Verified:
`npm run build` (web) passes; server boots clean (no dup-route errors); `/api/health`,
`/api/customers/search`, and `/api/orders` (empty/all-ready/all-backorder/mixed carts) all hit the
expected code path against seed data (fails at the live Shopify call as expected — no token in
this dev env). **Needs a real device/browser test with a live token before going live**, plus
still has the pre-existing pending push from §8 below. Not committed — ask before committing.

`ab04334` fix duplicate /api/orders route · `fd6905a` BackOrder (incoming qty) · `3441e07` customer
matching + scope upgrade · `798551d` M2 order capture · `000dda6` materials fix · `5fe0abb` query
cost fix · `359e2f8` SW denylist · `2291b52` OAuth from App URL · `58a9c75` health diagnostics +
API version · `31e4745`/`764fa53` browse redesign · `5630781` showcase pill · `da3fe0b` password
auth · `0b95383` OAuth install · `e582269` M1 scaffold.
