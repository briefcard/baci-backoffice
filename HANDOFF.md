# Baci Milano — B2B Backoffice ("Baci Reps") · Handoff / Context Document

_Last updated: 2026-07-10. Share this whole file with a new Claude thread to continue._
_Project memory also lives at the Claude memory dir (`baci-b2b-rep-salesfloor-app.md`) with per-commit forensics._

---

## 0. TL;DR — where things stand

A single offline-first PWA + Fastify API ("baci-backoffice") that now runs Baci Milano USA's whole
wholesale motion: rep sales floor, customer order forms (kiosk + QR), client quoting with
adjustments, POS checkout queue, and an admin back office for inbound shipments (supplier RFQs,
document import, QA receiving, payments, kanban). Shopify is the single source of truth for
catalog/stock/orders.

**CRITICAL: ~28 commits are LOCAL-ONLY on `main` (through `34655b0`).** Everything below is built
+ verified locally but NOT deployed. Go-live = §12 (push → Render deploy → one OAuth re-auth).

**NEXT TASK (specced, not started): WhatsApp-agent integration — §13.** The owner's existing
WhatsApp agent (the "gomehagent" system, also on Render) must log inbound shipments/RFQs, attach
& track customs/freight documents (7501, BL, commercial invoice, packing list, POA…) synced with
Google Drive, and use THIS system as the per-shipment context store.

- **Repo:** https://github.com/briefcard/baci-backoffice (branch `main`) · local `~/Documents/baci-rep-app`
- **Live URL:** https://baci-backoffice.onrender.com · **Health:** `GET /api/health`
- **Store:** bacimilanousa.com = `769684-2.myshopify.com`, standard plan (NOT Plus). Shop gid `76919931192`.
- **Sellable location:** Miami Warehouse `gid://shopify/Location/104277705016` ONLY.

## 1. Business rules (all owner-locked)

- **Wholesale = 50% of MSRP** (shop metafield `b2b.wholesale_discount_pct` = 50, LIVE since
  2026-07-01; per-variant `b2b.wholesale_price` overrides win). MSRP always shown alongside
  (NOT struck through on the order form — owner wants it plainly readable).
- **Volume ladder** (only rep negotiation lever, order-level, capped): +2%/each $10k band of
  wholesale subtotal, cap +10% at $50k (shop metafield `b2b.volume_discount_tiers`).
- **Backorder deposits:** new customer **40%**, repeat customer **30%** (shop metafield
  `b2b.deposit_pct`). "Repeat" = Shopify customer tag matching `/b2b/i`, resolved SERVER-side.
- **Oversell guard:** per-line split by live Miami stock → up to TWO draft orders
  (ready-to-ship + backorder/deposit). Ready drafts set `reserveInventoryUntil` (+72h,
  `RESERVE_INVENTORY_HOURS`) so confirmed units are held in Shopify.
- **OOS lead time:** "6–10 weeks" (`OOS_LEADTIME_TEXT`) shown on rep cards, customer form, quote.
- **Low stock** < 10; B2B-titled/tagged products excluded from catalog.
- **Brand:** logo `https://bacimilanousa.com/cdn/shop/files/Baci_Logo_-_White.png` (WHITE — must
  sit on the brand band), site theme color **rgb(43 26 254) / #2B1AFE electric blue**. All print
  docs open with blue band + white logo; app `--accent` matches.

## 2. The app, tab by tab

- **Browse** (all reps): collection→type→material drill-down, search, live stock w/ SSE,
  BackOrder/incoming + restock ETA, substitutes, add-to-cart. Cart → `POST /api/orders` →
  ready/backorder split draft orders (tags `b2b-app`, `rep:<name>`, `ready-to-ship` /
  `backorder`+`deposit-required`+`deposit-pct:<n>`, `card-on-file`; deposit $ stamped in attrs).
- **📋 Form (kiosk) + `/?form=<code>` (QR):** the digitized paper order form
  (ORDER_FORM_US_DRAFT_3 layout: catalogue-ordered collection sections → product-type subgroups;
  unit price + plain MSRP; qty inputs; over-stock qty flagged "+N on deposit"; **totals NEVER
  computed in customer mode**). Kiosk locks the tablet (exit = rep password); offline-queues
  submissions. QR path is gated by `ORDER_FORM_CODE` (unset = disabled) and strips volume/deposit
  config. Submissions land in `pending_orders` (shared pool, SSE ping).
- **Pending** (all reps): the client-RFQ→quote workflow. Review seeds the normal cart with the
  client attached; **editable including ADDING items** (closing the drawer does NOT wipe the
  review — browse, add, cart-bar reopens same review; explicit "Discard review" link);
  **"🖨 Quote PDF for customer" pre-confirm**; Confirm → `/api/pending/:id/confirm` → same
  createOrders pipeline; audit (handled_by, 409 double-handle, failed confirm stays pending).
- **Checkout** (captain(s), `CAPTAIN_EMAILS`; empty = everyone): live queue of the app's draft
  orders w/ EXACT amount to collect now (full total vs deposit), 💳 save-card flag, Shopify admin
  deep link, completed greying. Friendly explainer when Shopify not connected.
- **Inbound** (admins ONLY, `ADMIN_EMAILS`; empty = nobody but dev): two modes —
  - **Shipments board:** kanban `RFQ draft → Ordered → In transit → Arrived → Receiving →
    Received` (drag + ◀▶, every move confirm+timeline-stamped; drops into Receiving/Received
    open the QA flow instead). Cards: origin, ref, ETA + days-late, units, payment badge
    (UNPAID/DEP €x/PAID), ⚠ sync-pending. Editor: header fields, payment (unpaid/deposit/paid +
    amounts, timeline-audited), lines (SKU add row), timeline, **Export/share RFQ** (supplier PO
    doc w/ fill-in `$____` cost lines + supplier T&C) + **Copy CSV**. **📄 Import ORD/PKLIST**
    (PDF/XLSX → parsed lines/ref/origin/date/FOB/madeIn/linked-refs/invoice-total → prefilled
    editor; packing list imports as In transit, pro-forma as Ordered).
  - **Items on the way:** per-item view (photo, collection, stock #, expected, per-shipment
    status chips → tap opens shipment; status pills "Arriving <date>" / "Ordered — no ETA"(+Set
    ETA btn) / "🛒 In cart · N" / "Needs ordering"); filters On-the-way / **Low-out-of-stock
    (items stay listed when carted!)** / All; sorts. **"+ Order"** adds to THE active RFQ draft
    (creates if none) — the supplier order form; draft lines do NOT feed rep-facing incoming.
  - **QA receive** (replaces the Google Sheet): counted / damaged / multi-bin (bin+qty; type-ahead
    of known bins incl. Shopify `warehouse.bin_location` values; NEW location IDs typed freely,
    normalized UPPER; current Shopify bins shown as placeholders). Good units →
    `inventoryAdjustQuantities` at Miami + bins → `warehouse.bin_location` metafield; failures
    recorded per line (`shopify_synced=false` + error) for retry — needs re-auth scopes to write.
- **Print documents** (all via the PrintDoc preview overlay — portal outside the app; WYSIWYG;
  explicit Print/Save-as-PDF; @media print hides #root):
  - **Customer quote / order copy** (`OrderCopyDoc`): blue band+logo, PREPARED FOR block, line
    THUMBNAILS, MSRP/Unit/Total, ready + "Backorder — ships in approx. 6–10 weeks" sections,
    Subtotal/Total then **DUE TODAY = ready + deposit** (blue, w/ indented breakdown) and **"Due
    before shipment (backorder balance)"**, NOTES, full T&C (cost exclusions, 14-day validity,
    3–5 day ship, deposit terms — `quoteTerms(leadTime)` in PrintDocs.jsx; owner should legal-review
    wording), **"Show country of origin" toggle (OFF by default,** screen-only control) adds
    "Made in X" per line from `custom.country_of_origin`. Reachable: header 🖨 w/ cart (DRAFT
    watermark), Pending review drawer (pre-confirm), done-screen (with draft refs + server figures).
  - **Supplier RFQ** (`RFQDoc`): PO-RFQ w/ photos, qty, `$____` fill-ins (starred + explained),
    supplier T&C (currency+incoterms, packing/ETA confirm, binding on PO only).
  - **Blank order form** (`BlankFormDoc`): header 🖨 with EMPTY cart; paper-form cover blanks +
    full catalog MSRP/Wholesale/qty-boxes.

## 3. Architecture & files

Single Render web service serves API + built PWA; Postgres for reps/tokens/pending/inbound;
IndexedDB (Dexie v2 incl. `queuedForms`) on-device; SSE live push; 10-min snapshot rebuild
(inventory webhook registration still TODO).

Server (`server/src/`): `config.js` (all envs/gates: `isCaptainEmail`, `isAdminEmail` — empty
admin list = NOBODY except dev@local), `snapshot.js` (catalog+Miami available/incoming+metafields
incl `binLocation`, `countryOfOrigin`; `setInboundOverlay` merges shipment rollup into
incoming/ETA; `publicFormResponse` strips negotiation config; **query is cost-budgeted — validate
any addition live, MAX_COST limit 1000**), `orders.js` (`createOrders`: split/price/deposit/
reserve/tags), `customers.js` (search/upsert w/ b2b.* profile metafields + default address),
`checkout.js` (captain queue parse), `pending.js` + `inbound.js` (pg stores w/ in-memory dev
fallback; inbound: shipments+lines+payment+timeline, `refreshRollup`, `receiveShipment` →
Shopify), `intake.js` (ORD/PKLIST PDF **coordinate-based** row rebuild + XLSX header parse +
letterhead origin/meta extraction), `oauth.js`/`tokens.js` (OAuth install; token in pg),
`server.js` (all routes; multipart), `schema.sql` (idempotent, incl ALTERs).

Web (`web/src/`): `App.jsx` (tabs, kiosk/QR entry, pending review lifecycle
closeCart/finishReview/discardReview, print wiring), `components/` `ProductCard` `BrowseView`
`Cart` (split view, deposit preview, CustomerPicker, card-on-file, pendingId branch, Quote PDF,
discard) `CustomerPicker` (typeahead + full wholesale profile: location/ONLINE ONLY, specialty,
collections chips, ship-to address) `CheckoutView` `PendingView` `OrderFormView` (+ReviewSheet,
ExitGate) `InboundView` (kanban, ItemsView, ShipmentEditor, ReceiveModal, QuickAddSheet, import)
`PrintDocs.jsx` (PrintDoc portal + BlankFormDoc/RFQDoc/OrderCopyDoc + `quoteTerms`), `formSections.js`
(section/type-group builder + offline submit queue), `sync.js`, `db.js`, `domain.js`
(`splitByAvailability` shared), `cart.js` (lines carry `msrp`, `origin`, `image`).

## 4. Shopify data (namespace `b2b` unless noted; all pinned)

Variant: `wholesale_price`, `case_pack`, `min_order_qty`, `restock_eta`. Product: `substitutes`,
**`warehouse.bin_location`** (list, pre-existing — the warehouse "Location IDs"),
**`custom.country_of_origin`** (pre-existing; live values China/Bangladesh/…). Customer:
`location`, `specialty`, `collections_of_interest` (created 2026-07-01). Shop:
`wholesale_discount_pct`=50, `volume_discount_tiers`, `deposit_pct`={40,30}.

## 5. Env vars (Render)

`SHOPIFY_STORE`, `SHOPIFY_API_KEY/SECRET`, `SHOPIFY_SCOPES` (unset → code default INCLUDING the
new `write_products,write_inventory`), `APP_URL`, `AUTH_DISABLED=false`, `REP_LOGINS`,
`JWT_SECRET`, `DATABASE_URL`, `RESEND_API_KEY` (unset), `CAPTAIN_EMAILS`, `ADMIN_EMAILS`,
`ORDER_FORM_CODE`, `ORDER_FORM_COLLECTION_HANDLES`, `OOS_LEADTIME_TEXT` (6–10 weeks),
`RESERVE_INVENTORY_HOURS` (72), `LOW_STOCK_THRESHOLD`, `DEFAULT_WHOLESALE_PCT` (50),
`DEFAULT_DEPOSIT_NEW_PCT/REPEAT_PCT` (40/30), `SELLABLE_LOCATION_IDS`.

## 6. Gotchas / debug traps (all hit at least once — read before changing things)

- Snapshot GraphQL cost: validate additions with a live query (MCP) — 1346>1000 broke prod once.
- PWA service worker: `/auth /api /webhooks` stay in `navigateFallbackDenylist`; when testing new
  builds ALWAYS unregister SW + clear caches first.
- `node --check` misses Fastify runtime errors (dup routes) — boot the server.
- **Stale server processes**: server-side edits need a preview_stop/preview_start (the preview
  watchdog respawns killed processes; a stale server coerced 'draft'→'ordered' once and looked
  like a code bug). Test parsers by importing the module directly, not via the port.
- Preview evals: clicking a React control and reading the result in the SAME eval returns stale
  DOM — split click and read; `?.click()` with unconditional return strings LIES on failure.
- `@fastify/multipart` must stay on **v8** (fastify 4).
- Postgres DATE rejects '' — empty ETA must be null (was the /api/inbound 400).
- CREATE TABLE IF NOT EXISTS can't add columns — use ALTER TABLE ADD COLUMN IF NOT EXISTS.
- Git identity is repo-local (`Gomeh Saias <gomehsaias@gmail.com>`) — global config is empty.
- `gh`/`jq` NOT installed. PDFKit-via-osascript extracts PDFs locally (no poppler).
- ORD/PKLIST PDFs: raw text is column-scrambled — parse by pdf.js coordinates; origin from
  LETTERHEAD tokens (Dekorasyon/Istanbul vs S.R.L./Corridoni), never "Made In" columns.
- Seed (`server/seed-snapshot.json`, gitignored) now carries discountPct 50 + countryOfOrigin.

## 7. GO-LIVE checklist (blocking everything)

1. `git push` (~28 commits). 2. `npx @shopify/cli@latest app deploy` (scopes incl.
read/write_customers + write_products + write_inventory). 3. Render auto-deploys; set new envs
(§5, esp. ADMIN_EMAILS/CAPTAIN_EMAILS/ORDER_FORM_CODE). 4. Re-auth once:
`https://baci-backoffice.onrender.com/?shop=769684-2.myshopify.com` in a fresh/incognito window →
Approve. 5. Verify `/api/health` (installed:true, products ~250), then: order-form QR, a pending
review→quote→confirm, captain queue, inbound import w/ real ORD PDF, QA receive → Shopify stock.
6. Register `inventory_levels/update` webhook (still TODO) for true-live push.

## 8. NEXT TASK — WhatsApp-agent integration (specced 2026-07-10, NOT started)

**Goal:** the owner's existing WhatsApp agent system ("gomehagent", separate Render service)
becomes the conversational front-end for inbound logistics: it logs shipments/RFQs, attaches and
tracks the per-shipment DOCUMENT SET synced with Google Drive, answers "what's the status/what's
missing for 131/2026", and updates this system as the single context store per order.

**Document reality (owner examples, not exhaustive):** CBP Form **7501** (customs entry),
**Bill of Lading**, **Commercial Invoice**, **Packing List**, **Power of Attorney** (freight
forwarder/customs broker; likely company-scoped, not per-shipment), plus typical extras (Arrival
Notice, ISF/10+2, Delivery Order, freight invoice). Each needs states: required → received →
approved → filed.

**Architecture decisions (proposed, confirm with owner in next thread):**
1. **Files live in Google Drive** (system of record for documents); baci-backoffice stores ONLY
   metadata + links (`drive_file_id`, `drive_url`). The AGENT owns Drive I/O (it receives the
   PDFs via WhatsApp, uploads to a folder convention like
   `Baci Inbound/<year>/<shipment ref>/<doctype>_<filename>`), then registers the link here.
2. **Machine auth:** new `AGENT_API_TOKEN` env → `Authorization: Bearer` accepted by an
   agent-scoped route group; synthetic identity `{email:'agent@whatsapp', isAdmin:true}` so every
   write lands in the existing timelines/audit as the agent. Allowlist ONLY inbound+documents
   endpoints (NOT customers/orders/checkout).
3. **New table `inbound_documents`:** id, shipment_id (nullable for company-scoped docs like
   POA — add `scope` company|shipment), doc_type, status (required|received|approved|filed),
   drive_file_id, drive_url, filename, notes, created_by, approved_by/at, timestamps. Checklist:
   per-shipment required set seeded from a configurable default
   (`REQUIRED_DOCS=commercial_invoice,packing_list,bill_of_lading,7501` env or JSON per origin
   type); UI later shows checklist chips on the ShipmentEditor + ⚠ on cards until complete.
4. **Agent API surface (add to server.js):**
   - `GET /api/agent/shipments` — open shipments + doc checklist status (the agent's context).
   - `GET /api/agent/match?q=<ref|container|tracking>` — resolve which shipment a doc belongs to
     (searches reference, linked refs in notes, tracking, origin).
   - `POST /api/inbound` / `POST /api/inbound/:id` — reuse (create RFQ/shipment, update
     status/ETA/notes — timeline entries say who).
   - `POST /api/inbound/parse` — reuse (agent forwards ORD/PKLIST → parsed lines).
   - `POST /api/inbound/:id/documents` + `POST .../documents/:docId` — register doc / update
     status; auto-timeline ("Bill of Lading received via WhatsApp", "7501 approved by Gomeh").
5. **Conversation flows to support:** (a) forwarder sends BL PDF → agent extracts refs → match →
   register received → notify owner → owner replies "approve" → approved → agent moves file to
   final Drive folder → filed; (b) "status of 168/2026?" → shipment + payment + doc gaps;
   (c) supplier ORD PDF → parse → create/ordered shipment; (d) "mark 131 arrived" → status move
   (same confirm semantics as the board); (e) daily digest: past-ETA shipments + missing docs.
6. **Build order:** (i) AGENT_API_TOKEN auth + documents table/endpoints + match endpoint (all
   testable via curl, no agent changes); (ii) gomehagent side: Drive upload + ref extraction +
   the API calls (that repo has its own deploy — see `gomehagent-whatsapp-audit` memory);
   (iii) ShipmentEditor documents checklist UI; (iv) digests/nudges.
7. **Open questions for owner:** approve-via-WhatsApp OK or app-only? required-doc set per
   origin/shipment type? POA handling (standing company doc w/ expiry?); should the agent be
   allowed to CREATE shipments (recommend yes for ORD parse) or update-only?

## 9. Post-agent backlog (in rough priority)

Post-confirm quote editing (reload draft order → cart → `draftOrderUpdate` in place — spec in
memory), inventory webhook registration, sales velocity/days-of-cover + "sells out before ETA",
free-incoming (incoming minus promised backorders), barcode backfill from ORD docs → scan
receiving, publish shipments as native Shopify Transfers (API verified present), quote-terms
legal review, Resend magic-link auth, supplier-RFQ add-SKU polish (datalist + target picker —
parked), per-rep analytics.
