# Baci Milano — B2B Backoffice ("Baci Reps") · Handoff / Context Document

_Last updated: 2026-07-16. Share this whole file with a new Claude thread to continue._
_Deep per-commit forensics also live in the Claude memory file `baci-b2b-rep-salesfloor-app.md`._

---

## 0. TL;DR — the system + where we left off

A single offline-first PWA + Fastify API ("baci-backoffice") that runs Baci Milano USA's whole
wholesale motion: rep sales floor, customer order forms (kiosk + QR + **personalized links with a
lookbook**), client quoting with adjustments, POS checkout queue, and an admin back office for
inbound shipments (supplier RFQs, PDF/XLSX import, QA receiving, payments, kanban, **customs-
document checklists + a WhatsApp-agent API**). Shopify is the single source of truth.

**IT IS DEPLOYED AND IN USE.** Live at https://baci-backoffice.onrender.com — health shows
installed:true, ~279 products, reps connected.

### ⛔ WHERE WE LEFT OFF — two live blockers, both actionable (see §7 for the fix)

1. **One unpushed commit `fe0b515` FIXES A LIVE OUTAGE — push it first.** The public/kiosk order
   form currently crashes to a **blank page** whenever any out-of-stock item renders (a
   `FormRow` referenced `config` it never received → ReferenceError → whole page unmounts). The
   local seed has no zero-stock items so it never reproduced locally; the live 279-product catalog
   does. `fe0b515` fixes it (+ adds the image-centric lookbook/form work). **`git push` →
   Render auto-deploys → live form renders again.**

2. **Re-auth for `write_products`/`write_inventory` is blocked by a Render env var, NOT the app.**
   `/api/health` shows `scopesOk:false`, granted =
   `read_products,read_inventory,read_locations,write_draft_orders,write_customers`. The owner
   reported "going to `/?shop=…` isn't working." ROOT CAUSE (diagnosed via curl, §7): the live
   OAuth request is built from a **stale `SHOPIFY_SCOPES` env var on Render** that omits
   `write_products`+`write_inventory`, so even clicking Approve re-grants the same incomplete set.
   Warehouse QA-receive stock writes + bin/ETA metafields stay blocked until this is fixed.
   Customer create/match already works (write_customers is granted). **Fix = §7.**

- **Repo:** https://github.com/briefcard/baci-backoffice (`main`) · local `~/Documents/baci-rep-app`
- **Store:** bacimilanousa.com = `769684-2.myshopify.com`, standard plan (NOT Plus). Shop gid `76919931192`.
- **Shopify app:** "Baci Backoffice", Client ID `359ebdfd44d98e0ccf430f1110298b0e` (public/safe). OAuth install flow.
- **Sellable location:** Miami Warehouse `gid://shopify/Location/104277705016` ONLY.
- **Git identity:** repo-local `Gomeh Saias <gomehsaias@gmail.com>` (global config empty). `gh`/`jq` NOT installed.

## 1. Business rules (all owner-locked)

- **Wholesale = 50% of MSRP** (shop metafield `b2b.wholesale_discount_pct`=50, LIVE; per-variant
  `b2b.wholesale_price` overrides win). MSRP shown alongside, plainly (not struck on the form).
- **Volume ladder** (only rep lever, order-level, capped): +2% per $10k wholesale-subtotal band,
  cap +10% at $50k (shop metafield `b2b.volume_discount_tiers`).
- **Backorder deposits:** new customer **40%**, repeat **30%** (shop metafield `b2b.deposit_pct`).
  "Repeat" = Shopify customer tag matching `/b2b/i`, resolved SERVER-side (never client-trusted).
- **Oversell guard:** each cart line split by live Miami stock → up to TWO draft orders (ready +
  backorder/deposit). Ready drafts set `reserveInventoryUntil` (+72h) to hold stock in Shopify.
- **OOS lead time:** "6–10 weeks" (`OOS_LEADTIME_TEXT`) on rep cards, customer form, quote.
- **Low stock** < 10; products with "B2B" in title/tags excluded from catalog.
- **Brand:** logo `bacimilanousa.com/cdn/shop/files/Baci_Logo_-_White.png` (WHITE — sits on a band),
  theme color **#2B1AFE electric blue** (NOT red — miamiironside's red is a different site). All
  print docs open with a blue band + white logo; app `--accent` = the blue.

## 2. The app, surface by surface

- **Browse** (all reps): collection→type→material drill-down, search, live stock (SSE),
  BackOrder/incoming + restock ETA, substitutes. Cart → `POST /api/orders` → ready/backorder split
  drafts (tags `b2b-app`, `rep:<name>`, `ready-to-ship`/`backorder`+`deposit-required`+
  `deposit-pct:<n>`, `card-on-file`; deposit $/customer tier stamped in customAttributes).
- **Customer order form** — three doors, one component (`OrderFormView`, mode public/kiosk):
  - **📋 Form (kiosk):** rep tablet locks into it; exit = rep password; offline-queues submissions.
  - **QR `/?form=<code>`:** gated by `ORDER_FORM_CODE` (unset = disabled); strips volume/deposit config.
  - **Personalized link `/?form=<token>`** (NEW): a per-customer URL that opens a **Lookbook**
    first (see below), then the form filtered to their curated collections with their info
    prefilled. Rep creates it via **"🔗 Share form"** on a picked customer in the cart.
  - Totals are NEVER computed in customer mode. Over-stock qty flagged "+N on deposit". Product
    photos are tap-to-zoom (gallery lightbox). Submissions land in `pending_orders` (source
    kiosk/qr/link; link submissions credited to the creating rep).
- **Lookbook** (`Lookbook.jsx`, public link landing): blue hero + logo + "Curated for <company>"
  + optional personal note; per-collection **lifestyle hero banners** (from the owner's
  `custom.collection_*` metafields) + a supporting image strip + image-forward product grids at
  wholesale/MSRP with an inline thumbnail gallery; tap any image → fullscreen `ImageLightbox`.
  "Start your order ▸" → the filtered form.
- **Pending** (all reps): the client-RFQ→quote workflow. Review seeds the normal cart with the
  client attached; **editable including ADDING items** (closing the drawer does NOT end the review
  — browse, add, cart-bar reopens it; explicit "Discard review" link); **"🖨 Quote PDF for
  customer" pre-confirm**; Confirm → `/api/pending/:id/confirm` → same createOrders pipeline;
  audited (409 on double-handle, failed confirm stays pending).
- **Checkout** (captain(s), `CAPTAIN_EMAILS`; empty = everyone): live queue of the app's draft
  orders with EXACT amount to collect now (full vs deposit), 💳 save-card flag, Shopify-admin deep
  link. Explainer shown when Shopify not connected.
- **Inbound** (admins only, `ADMIN_EMAILS`; empty = nobody but dev@local) — two modes:
  - **Shipments board:** kanban `RFQ draft → Ordered → In transit → Arrived → Receiving →
    Received` (drag + ◀▶; every move confirm+timeline-stamped; drops into Receiving/Received open
    the QA flow). Cards: origin, ref, ETA + days-late, units, payment badge (UNPAID/DEP €x/PAID),
    ⚠ sync-pending, **customs-doc checklist chips**. Editor: header fields, payment
    (unpaid/deposit/paid + amounts, audited), lines (SKU add w/ live-Shopify match fallback +
    re-match action), timeline, **customs-document checklist**, **Export/share RFQ** (supplier PO
    doc: photos, qty, `$____` fill-in cost lines, supplier T&C) + **Copy CSV**. **📄 Import
    ORD/PKLIST** (PDF/XLSX → parsed lines/ref/origin/date/FOB/madeIn/linked-refs/invoice-total →
    prefilled; packing list imports as In transit, pro-forma as Ordered).
  - **Items on the way:** per-item view (photo, collection, stock #, expected, per-shipment status
    chips → tap opens shipment; pills "Arriving <date>"/"Ordered — no ETA"(+Set ETA)/"🛒 In cart ·
    N"/"Needs ordering"; filters On-the-way / Low-out-of-stock (items STAY when carted) / All;
    sorts). **"+ Order"** adds to THE active RFQ draft (the supplier order form); draft lines do
    NOT feed rep-facing incoming.
  - **QA receive** (replaces the Google Sheet): counted / damaged / multi-bin (type-ahead of known
    bins incl. Shopify `warehouse.bin_location`; NEW location IDs typed freely, normalized UPPER;
    CURRENT Shopify bin shown as placeholder). Good units → `inventoryAdjustQuantities` at Miami +
    bins → `warehouse.bin_location` metafield. **Currently 400s / records `shopify_synced=false`
    because write_inventory/write_products aren't granted yet (§7).**
- **Print documents** (all via `PrintDoc` — a preview overlay portaled outside the app shell;
  WYSIWYG; explicit Print/Save-as-PDF; @media print hides `#root`):
  - **Customer quote / order copy** (`OrderCopyDoc`): blue band+logo, PREPARED FOR block, line
    THUMBNAILS, MSRP/Unit/Total, ready + "Backorder — ships in approx. 6–10 weeks", then
    Subtotal/Total → **DUE TODAY = ready total + deposit** (blue, indented breakdown) → **"Due
    before shipment (backorder balance)"**, NOTES, full T&C (`quoteTerms(leadTime)` — owner should
    legal-review), **"Show country of origin" toggle (OFF by default; screen-only)** adds "Made in
    X" from `custom.country_of_origin`. Reachable: header 🖨 (DRAFT), Pending review (pre-confirm),
    done-screen (with draft refs + server figures).
  - **Supplier RFQ** (`RFQDoc`), **Blank order form** (`BlankFormDoc`).

## 3. Architecture & files

Single Render web service serves API + built PWA; Render Postgres; IndexedDB (Dexie v2, incl.
`queuedForms`) on-device; SSE live push; ~10-min snapshot rebuild (inventory webhook registration
still TODO). Server = Node/Fastify ESM, Shopify Admin GraphQL. Web = React+Vite+vite-plugin-pwa
(Workbox)+Dexie, mobile-first.

Server `server/src/`: `config.js` (all envs/gates; `isCaptainEmail`, `isAdminEmail`,
`scopesSatisfied`, `agentApiToken`), `snapshot.js` (catalog + Miami available/incoming +
metafields incl `binLocation`/`countryOfOrigin`; **collection heroes side-query** +
**per-product gallery paginated pass**; `setInboundOverlay` merges shipment rollup;
`publicFormResponse` strips negotiation config; `personalizedFormResponse` filters to a link's
collections — **the big products query is cost-budgeted; validate any addition live**),
`orders.js` (`createOrders`: split/price/deposit/reserve/tags), `customers.js` (search/upsert w/
b2b.* profile metafields + default address), `checkout.js`, `pending.js` (+ source 'link'),
`links.js` (personalized form links: `form_links` table + create/resolve), `inbound.js`
(shipments+lines+payment+timeline, refreshRollup, receiveShipment→Shopify, SKU match + rematch,
dup-by-reference guard), `documents.js` (customs docs + checklist), `intake.js` (ORD/PKLIST PDF
coordinate-based parse + XLSX + letterhead meta), `oauth.js`/`tokens.js`, `server.js` (all routes;
multipart; `requireAuth`/`requireInboundAccess`/`agentIdentity`), `schema.sql` (idempotent + ALTERs).

Web `web/src/`: `App.jsx` (tabs; kiosk/QR/**link** entry incl. Lookbook stage; pending review
lifecycle closeCart/finishReview/discardReview; print wiring), `components/` `ProductCard`
`BrowseView` `Cart` (split, deposit preview, CustomerPicker, card-on-file, pendingId branch, Quote
PDF, discard) `CustomerPicker` (typeahead + full wholesale profile + **ShareFormSheet**)
`CheckoutView` `PendingView` `OrderFormView` (+ReviewSheet w/ prefill, ExitGate, tap-to-zoom rows)
`InboundView` (kanban, ItemsView, ShipmentEditor + doc checklist, ReceiveModal, QuickAddSheet,
import) `Lookbook.jsx` (Lookbook + GalleryCard + **ImageLightbox**, shared) `PrintDocs.jsx`
(PrintDoc + BlankFormDoc/RFQDoc/OrderCopyDoc + `quoteTerms`), `formSections.js`, `sync.js`,
`db.js`, `domain.js` (`splitByAvailability`), `cart.js` (lines carry msrp/origin/image).
`web/ssr-smoke.jsx` + `npm run smoke` = **SSR render test of Lookbook + OrderFormView against a
real /api/form/catalog payload; run before every deploy** (it's what caught the blank-form crash).

## 4. Shopify data

Metafields (namespace `b2b` unless noted; pinned): Variant `wholesale_price` `case_pack`
`min_order_qty` `restock_eta`. Product `substitutes`, `warehouse.bin_location` (list — the
warehouse "Location IDs"), `custom.country_of_origin` (China/Bangladesh/…),
**`custom.image_and_video`** (curated product gallery, file refs; native `images` as fallback).
Collection **`custom.collection_header`/`collection_image_mobile`/`collection_image_2`/`_3`**
(file refs — lookbook lifestyle heroes; native `image` fallback). Customer `location` `specialty`
`collections_of_interest`. Shop `wholesale_discount_pct`=50, `volume_discount_tiers`,
`deposit_pct`={40,30}.

Postgres tables (all in `schema.sql`, idempotent): `reps`, `magic_links`, `sessions`,
`order_audit`, `webhook_events`, `shop_tokens`, `pending_orders`, `inbound_shipments`,
`inbound_lines`, `inbound_documents`, `form_links`.

## 5. Env vars (Render)

`SHOPIFY_STORE`, `SHOPIFY_API_KEY/SECRET`, **`SHOPIFY_SCOPES` ⚠ SEE §7 — currently stale/blocking**,
`APP_URL`, `AUTH_DISABLED=false`, `REP_LOGINS`, `JWT_SECRET`, `DATABASE_URL`, `CAPTAIN_EMAILS`,
`ADMIN_EMAILS` (empty = nobody), `ORDER_FORM_CODE`, `ORDER_FORM_COLLECTION_HANDLES`,
`OOS_LEADTIME_TEXT` (6–10 weeks), `RESERVE_INVENTORY_HOURS` (72), `LOW_STOCK_THRESHOLD`,
`DEFAULT_WHOLESALE_PCT` (50), `DEFAULT_DEPOSIT_NEW_PCT/REPEAT_PCT` (40/30), `SELLABLE_LOCATION_IDS`,
`RESEND_API_KEY` (unset), `AGENT_API_TOKEN` (for the WhatsApp agent — §9; set to a long random
secret to enable the agent API).

## 6. Gotchas / debug traps (each hit at least once)

- **Blank customer form = a render crash.** Zero-stock items only appear on the LIVE catalog, not
  the seed → run `npm run smoke` (web/) before deploying; it renders the form against real data.
- **Service worker intercepts `/?...` navigations.** `/?shop=…` is a navigation to `/`, which the
  SW's navigateFallback serves from cache (denylist only covers `/auth /api /webhooks`) — so the
  server-side OAuth redirect never fires in a browser. Use `/auth/shopify/install?shop=…` directly
  (denylisted) or incognito. Same reason to unregister the SW when testing new builds.
- **`SHOPIFY_SCOPES` env var overrides the code default.** If set, it wins over cfg.scopes — a
  stale value silently omits scopes from the OAuth request (this is §7's root cause).
- Snapshot GraphQL cost: validate additions live (MCP `graphql_query`); 1346>1000 broke prod once.
  Collection heroes + product galleries are fetched as SEPARATE cheap queries for this reason.
- `node --check` misses Fastify runtime errors (dup routes) — actually boot the server.
- **Stale local server processes** survive `pkill` and the preview watchdog respawns killed ones;
  a stale server serving old code looked like a bug more than once. `kill -9 $(lsof -tnP
  -iTCP:8080 -sTCP:LISTEN)` and health-check before curl tests. Test parsers by importing the
  module directly, not via the port.
- Browser-pane MCP (`mcp__Claude_Browser__*`) replaced Claude_Preview. `preview_start({url})`
  opens a tab on an existing Bash-owned server. The nav/js tools go through a safety classifier
  that was intermittently down 2026-07-16 → use the SSR smoke test as the fallback.
- `@fastify/multipart` pinned to **v8** (fastify 4). Postgres DATE rejects '' (empty ETA → null).
  CREATE TABLE IF NOT EXISTS can't add columns → ALTER TABLE ADD COLUMN IF NOT EXISTS.
- ORD/PKLIST PDFs: raw text is column-scrambled → parse by pdf.js coordinates; origin from
  LETTERHEAD tokens (Dekorasyon/Istanbul vs S.R.L./Corridoni), never the "Made In" column.
- `seed-snapshot.json` gitignored; carries discountPct 50 + countryOfOrigin + real CDN heroes/gallery.

## 7. ⛔ THE RE-AUTH BLOCKER — root cause & exact fix (DO THIS)

**Symptom:** `/api/health` → `scopesOk:false`; granted =
`read_products,read_inventory,read_locations,write_draft_orders,write_customers`. QA-receive stock
writes 400. Owner: "`/?shop=…` isn't working."

**Diagnosis (curl, 2026-07-16):**
- `GET /?shop=769684-2.myshopify.com` → 302 → `/auth/shopify/install?...` (server hook works).
- `GET /auth/shopify/install?shop=…` → 302 → Shopify OAuth with `scope=` =
  `read_products,read_inventory,read_locations,read_draft_orders,write_draft_orders,read_customers,write_customers`
  — **MISSING `write_products` and `write_inventory`.**
- `shopify.app.toml` AND `server/src/config.js` cfg.scopes DO include all 9 scopes. So the live
  OAuth URL is built from a **stale `SHOPIFY_SCOPES` env var on Render** (a 7-scope string) that
  overrides the code default. Re-approving as-is re-grants the same incomplete set → nothing changes.
- Also: in a browser the `/?shop=` link is swallowed by the service worker (gotcha §6), which is
  why it "isn't working" visually.

**FIX (do in order):**
1. **Render → baci-backoffice → Environment:** delete `SHOPIFY_SCOPES` (so the code default is
   used) OR set it exactly to
   `read_products,write_products,read_inventory,write_inventory,read_locations,read_draft_orders,write_draft_orders,read_customers,write_customers`.
2. `git push` (ships `fe0b515`, the blank-form fix) → Render redeploys.
   Optionally `cd ~/Documents/baci-rep-app && npx @shopify/cli@latest app deploy` (toml scopes are
   already correct, so this is belt-and-suspenders / no-op unless Shopify's registered set drifted).
3. In **incognito** (no service worker), open
   `https://baci-backoffice.onrender.com/auth/shopify/install?shop=769684-2.myshopify.com`
   (the `/auth/…` path, NOT `/?shop=…`) → Approve. The approve screen must now list Products +
   Inventory write access.
4. Verify: `curl -s https://baci-backoffice.onrender.com/api/health` → `scopesOk:true`. Then test
   a QA receive → the Miami stock number should move in Shopify.

(Note: `scopesSatisfied` is an exact-set check; if Shopify collapses read/write and reports e.g.
just `write_customers`, health may read false even when functional. The two genuinely-missing
scopes above are the ones that matter — write_products + write_inventory.)

## 8. Deploy status

Live at `aab5b5d`. **1 commit unpushed: `fe0b515`** (live blank-form fix + image-centric lookbook).
Push it. Everything else in §2 is deployed and in use.

## 9. WhatsApp-agent integration — BUILT (Phase 1), owner-side pending

The agent surface is live in code (commits `337ad76`, `594a5b6`, `14e578b`). Design: files live in
Google Drive (agent owns Drive I/O); baci-backoffice stores metadata + links and is the per-order
context store.
- **Auth:** `Authorization: Bearer <AGENT_API_TOKEN>` → synthetic `agent@whatsapp` identity
  (`requireInboundAccess` accepts it; writes land in timelines as the agent). Set `AGENT_API_TOKEN`
  on Render to enable. QA-receive stays session-admin-only (a human at the warehouse).
- **`inbound_documents` table + checklist:** doc_type, status (required→received→approved→filed),
  drive_file_id/url, scope (shipment|company, e.g. POA is company-scoped). ShipmentEditor renders
  the checklist; board cards flag missing docs. Docs so far: 7501, Bill of Lading, Commercial
  Invoice, Packing List, POA (+extensible).
- **Agent endpoints** (server.js): `GET /api/inbound` (shipments + doc checklist), duplicate-by-
  reference guard on agent creates (409 with the existing shipment; `allowDuplicate:true` to
  override), shipment create/update, `POST /api/inbound/parse` (forward ORD/PKLIST → parsed lines),
  document register/status endpoints, SKU rematch.
- **Left to do:** (a) the gomehagent side — Drive upload + reference extraction + these API calls
  (that repo has its own Render deploy; see the `gomehagent-whatsapp-audit` memory); (b) confirm
  with owner: approve-docs-via-WhatsApp vs app-only, required-doc set per shipment type (sea/air),
  POA expiry handling; (c) past-ETA + missing-doc daily digests.

## 10. Backlog (rough priority)

Post-confirm quote editing (reload a confirmed draft order → cart → `draftOrderUpdate` in place —
spec in memory), inventory `inventory_levels/update` webhook registration for true-live push,
sales velocity / days-of-cover + "sells out before ETA", free-incoming (incoming minus promised
backorders), barcode backfill from ORD docs → scan receiving, publish shipments as native Shopify
Transfers (API verified present), quote-terms legal review, Resend magic-link auth, per-rep analytics.

## 11. Recent commit history (newest first)

`fe0b515` blank-form fix + image-centric lookbook/form (UNPUSHED) · `aab5b5d` personalized form
links + lookbook · `14e578b` inbound SKU live-match + re-match · `594a5b6` shipment doc-checklist
UI · `337ad76` inbound documents + WhatsApp-agent API · `3dfcc36` health scopes diagnostics ·
`598a0a6` handoff rewrite · `34655b0` quote thumbnails + Due-Today · `caeaaa6` editable pending
review + pre-confirm quote · `404243e` RFQ fill-in + terms · `c929b7e` branding + lead time +
origin toggle · `842f7fb` bin placeholders · `2cfa8d3` status pills + quick-add · `41dfa7f` items
view · `4c58a6f` inbound tracker · `b28978e` RFQ draft flow · earlier: order form, checkout queue,
customer profile, 50% reprice, deposits — all in memory.
