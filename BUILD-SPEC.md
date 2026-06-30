# Baci Milano — B2B Rep "Sales Floor" App · Build Spec

_Last updated: 2026-06-30 · Status: Phase 0 complete, spec for build_

---

## 1. Goal

Give ~10 B2B sales reps, on tradeshow floors and sales calls, an instant answer to:
**"Can I get this, at what price, and what do I sell instead if it's out?"** — and let them
capture the order on the spot. Replaces the paper SKU/price form. Reps never touch Shopify admin.

## 2. Locked decisions

- **Build:** custom offline-first PWA (not an off-the-shelf B2B app).
- **V1 scope:** lookup **+** order capture (cart → Shopify draft order).
- **Source of truth:** Shopify. No second catalog DB; server holds only operational data.
- **Pricing:** line prices owner-set; base = retail − **35%**; per-variant `b2b.wholesale_price`
  overrides. Only negotiation lever = **order-volume ladder** (capped, order-level discount).
- **Connectivity:** spotty at venues → offline-first, with stock going **live the instant signal returns**.
- **Hosting:** existing **Render** (no Netlify). ~10 reps, individual magic-link logins.

## 3. Architecture

```
  SHOPIFY (system of record)              RENDER                         REP DEVICE (PWA)
  ┌──────────────────────────┐    ┌───────────────────────────┐    ┌────────────────────────┐
  │ Products / variants / SKU │    │  Web Service (always-on)  │    │  Service worker + cache │
  │ Inventory (3 locations)   │──▶ │  • /api/snapshot          │──▶ │  IndexedDB (full catalog│
  │ b2b.* metafields          │    │  • /api/inventory?since=  │    │   + stock snapshot)     │
  │ Retail prices             │    │  • /api/stream  (WS/SSE)  │◀──▶│  • search / scan        │
  │                           │    │  • /api/auth (magic link) │    │  • product card         │
  │  inventory_levels/update  │──▶ │  • /api/orders (draft)    │◀── │  • cart + queue         │
  │  webhook  ────────────────│    │  Postgres (reps/audit)    │    │  live/stale badge       │
  └──────────────────────────┘    └─────────────┬─────────────┘    └────────────────────────┘
            ▲  draftOrderCreate (tagged)         │ Static Site = PWA bundle
            └────────────────────────────────────┘
```

Shopify stays the single source of truth. The server is a thin read/broadcast layer plus a narrow
write path (**draft orders only**). The heavy catalog cache lives on each device.

## 4. Data model

### 4.1 Shopify metafields — CREATED (Phase 0)
Namespace `b2b`, all pinned.

| Key | Owner | Type | Use |
|---|---|---|---|
| `wholesale_price` | Variant | money | Manual price override (wins over global %) |
| `case_pack` | Variant | integer | Units per case |
| `min_order_qty` | Variant | integer | B2B MOQ |
| `restock_eta` | Variant | date | "Back by" line in OOS playbook |
| `substitutes` | Product | list.product_reference | What to suggest when out |
| `wholesale_discount_pct` | Shop | decimal | Global default % off retail = **35** |
| `volume_discount_tiers` | Shop | json | Negotiation ladder (below) |

`volume_discount_tiers` value:
```json
{ "basis": "wholesale_subtotal", "currency": "USD", "max_additional_pct": 10,
  "tiers": [ {"min_order":10000,"additional_pct":2}, {"min_order":20000,"additional_pct":4},
             {"min_order":30000,"additional_pct":6}, {"min_order":40000,"additional_pct":8},
             {"min_order":50000,"additional_pct":10} ] }
```

### 4.2 Server (Postgres) — operational only
- `reps` (id, email, name, active, created_at)
- `magic_links` (token_hash, rep_id, expires_at, used_at)
- `sessions` (jwt id / refresh, rep_id, device, last_seen)
- `order_audit` (id, rep_id, customer_label, event_label, shopify_draft_order_id, subtotal,
  negotiated_pct, exceeded_cap bool, payload_json, created_at, synced_at)
- `webhook_events` (shopify_event_id, received_at) — dedup
- `kv` (key, value) — cached snapshot version, sellable-location set, etc.

## 5. Availability logic

`available_to_sell(variant) = Σ over SELLABLE locations of inventoryLevel "available"`
(Shopify's "available" already nets committed/online demand → "inbound from Shopify" reflected.)

- **Sellable location (CONFIRMED):** **Miami Warehouse ONLY** (`gid://shopify/Location/104277705016`).
  Availability ignores B2B Virtual Warehouse and the Hallandale office. `kv.sellable_location_ids = [104277705016]`.
- **State bands (CONFIRMED):** `Out` if available ≤ 0; `Low` if available **< 10**; else `In stock`.

## 6. Pricing engine

```
unitPrice(variant):
    if b2b.wholesale_price set → that
    else → round( retail × (1 − wholesale_discount_pct/100) )      # 35% → ×0.65

orderWholesaleSubtotal = Σ unitPrice × qty                          # pre-volume
maxAdditionalPct = highest tier where subtotal ≥ tier.min_order     # 0 under $10k … cap 10%
repAppliedPct ∈ [0, maxAdditionalPct]                               # rep's choice, capped in UI
finalTotal = orderWholesaleSubtotal × (1 − repAppliedPct/100)
if requested > maxAdditionalPct → block in UI; if forced path → flag needs_approval
```
Reps **cannot** edit a line price; the only movable number is `repAppliedPct`, hard-capped by cart size.

## 7. Out-of-stock playbook (card behavior)

When a variant is Low/Out, the card auto-offers, in order:
1. **State** (Low/Out) with live/stale badge.
2. **Back by** `restock_eta` if present ("back in ~3 weeks").
3. **Substitutes** from `b2b.substitutes` (fallback: same product_type / collection).
4. **Backorder/pre-order** capture — write the line with expected ship date.
5. _(Phase 3)_ reserve-against-incoming on B2B Virtual Warehouse.
Degrades gracefully: 1 & 4 work with zero data entry; 2 & 3 are optional polish.

## 8. Offline + live-sync engine (core)

- **Snapshot:** on login/online, `GET /api/snapshot` → full catalog (products, variants, SKU,
  barcode, image, retail, all `b2b.*`, substitutes) + stock by location + `version`. Stored in
  IndexedDB (Dexie). ~268 products → small; images lazy-cached by service worker.
- **Freshness badge:** 🟢 `Live · synced just now` vs 🟡 `as of HH:MM · reconnecting`.
- **Live push:** while online, client holds `/api/stream` (WS or SSE). Server receives Shopify
  `inventory_levels/update` webhook → recomputes availability → broadcasts
  `{variant_id, location_id, available}` → client patches IndexedDB + UI within seconds.
- **Instant on reconnect:** browser `online` event / heartbeat fires an **immediate**
  `GET /api/inventory?since=<lastSyncTs>` delta, then (re)subscribes to the stream — does NOT
  wait for the next poll tick. (This is the explicit owner requirement.)
- **Polling backstop:** if stream is down, poll `/api/inventory?since=` every 20–30s.
- **Cart queue:** carts built offline persist in IndexedDB; on reconnect `POST /api/orders` →
  server **re-checks live stock** per line → any line now short returns `needs_review` with the
  OOS payload → rep resolves (substitute/backorder) → confirm → draft order created.

## 9. Screens (rep app)

1. **Login** — email → magic link → session.
2. **Search** — type SKU / name / product type → results as cards. Search-first, not a list.
   _Camera scan deferred (§15.3): variant GTIN/barcode not populated yet._
3. **Product card** — image, name, SKU, **wholesale price**, **stock state + badge**, case pack/MOQ,
   and (if low/out) the OOS playbook inline. "Add to order" with qty (case-pack aware).
4. **Cart / Quote** — lines at wholesale, subtotal, the **volume-discount slider** (capped to cart
   tier), final total. "Send to office".
5. **Confirmation** — draft order created/queued; optional quote PDF to hand the customer _(Phase 2)_.
6. **My orders** — this rep's recent submissions + sync status.

## 10. Auth & security

- Passwordless **magic-link** email → short-lived token → session JWT (httpOnly cookie). Owner
  provisions the ~10 rep accounts.
- Shopify **Admin API token lives only on the server** (env var); reps never hold credentials.
- Reps can: read snapshot/inventory/stream, submit draft orders. Cannot: see admin, change
  inventory/prices, see margin/cost, or see other reps' orders.
- Webhook HMAC verification; rate limiting; draft-order tag `b2b-app` for clean filtering.

## 11. Shopify integration

- **Custom app** in the store. Scopes: `read_products`, `read_inventory`, `read_locations`,
  `read_draft_orders`, `write_draft_orders`. Webhook: `inventory_levels/update`
  (+ optional `products/update` to catch retail-price/edits).
- **Draft order writeback** (`draftOrderCreate`):
  - Each line = real variant + qty, with a **line `appliedDiscount`** carrying the 35%/override
    (so the quote shows retail → wholesale).
  - **Order-level `appliedDiscount`** = `repAppliedPct` (the volume lever).
  - `tags: ["b2b-app","rep:<name>","customer:<label>","event:<label>"]`; structured detail in note
    / draft-order metafield; `needs-approval` tag if cap exceeded.
  - Customer attach (lookup/create) — Phase 2.
  - _Validate `DraftOrderLineItemInput` discount fields against the live schema at build time._

## 12. Render layout

| Service | Type | Notes |
|---|---|---|
| `baci-rep-api` | Web Service (Node, **always-on**) | **NEW dedicated instance** — API + WS/SSE + webhook + auth + draft writes |
| `baci-rep-pwa` | Static Site (free) | PWA bundle (or serve static from api) |
| `baci-rep-db` | Postgres | **NEW dedicated DB** — reps/audit/dedup |

Env: `SHOPIFY_STORE`, `SHOPIFY_ADMIN_TOKEN`, `SHOPIFY_WEBHOOK_SECRET`, `DATABASE_URL`,
`JWT_SECRET`, `MAGIC_LINK_FROM`, SMTP/Email-API creds.
No Redis needed at 10 reps / single instance (add Render Key-Value only if we scale to >1 web instance).

## 13. Tech stack

- **PWA:** React + Vite + Workbox service worker + Dexie (IndexedDB). Mobile-first, installable.
- **Backend:** Node + Fastify (or Express); `ws`/SSE; Shopify Admin GraphQL; Prisma + Postgres.
- **Email:** Resend / Postmark / SES for magic links.

## 14. Build milestones (toward V1 = lookup + capture)

- **M1 — Lookup:** auth + snapshot + offline cache + search/scan + product card (state, price, ETA,
  substitutes) + live-sync engine + freshness badge. _Reps stop asking "is it in stock?"_
- **M2 — Capture:** cart + capped volume slider + draft-order writeback + offline queue + stock
  re-check on submit. _This completes V1._
- **M3 — Post-V1:** quote PDF, customer attach, backorder/pre-order capture,
  reserve-against-incoming, per-rep analytics, restock push notifications.

## 15. Confirmed settings (2026-06-30)

1. **Sellable location:** Miami Warehouse only (`104277705016`).
2. **Low-stock:** available `< 10` units.
3. **Scanning: DEFERRED.** Variant GTIN/barcode is empty; physical boxes carry barcodes. M1 ships
   search-first (SKU / name / type). To enable camera scan later, backfill the box codes into the
   native variant `barcode` field (preferred — also fixes GTIN) or a `b2b.box_barcode` metafield,
   then add a scan view. No blocker for V1.
4. **Draft-order customer:** text label in V1; attach a real Shopify customer in M2.
5. **Magic-link email:** Resend.
6. **Render:** NEW dedicated instance — `baci-rep-api` web service + `baci-rep-db` Postgres + `baci-rep-pwa` static site.
