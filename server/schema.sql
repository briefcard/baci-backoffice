CREATE TABLE IF NOT EXISTS reps (
  id SERIAL PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS magic_links (
  id SERIAL PRIMARY KEY,
  token_hash TEXT NOT NULL,
  rep_id INTEGER NOT NULL REFERENCES reps(id),
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_magic_links_token ON magic_links(token_hash);

CREATE TABLE IF NOT EXISTS order_audit (
  id SERIAL PRIMARY KEY,
  rep_id INTEGER REFERENCES reps(id),
  customer_label TEXT,
  event_label TEXT,
  shopify_draft_order_id TEXT,
  subtotal NUMERIC,
  negotiated_pct NUMERIC,
  exceeded_cap BOOLEAN DEFAULT false,
  payload JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  synced_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS webhook_events (
  shopify_event_id TEXT PRIMARY KEY,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Offline Admin API access token obtained via OAuth install.
CREATE TABLE IF NOT EXISTS shop_tokens (
  shop TEXT PRIMARY KEY,
  access_token TEXT NOT NULL,
  scope TEXT,
  installed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Customer order-form submissions (kiosk tablet or QR link) awaiting rep review.
-- A rep opens one, adjusts, then confirms -> Shopify draft order(s) via the normal pipeline.
CREATE TABLE IF NOT EXISTS pending_orders (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'pending', -- pending | confirmed | dismissed
  source TEXT,                            -- kiosk | qr
  rep_email TEXT,                         -- rep whose device captured it (kiosk)
  rep_name TEXT,
  customer JSONB,                         -- { company, contact, email, phone } as typed by the buyer
  lines JSONB NOT NULL,                   -- [{ variantId, quantity, sku, title }]
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  handled_by TEXT,
  handled_at TIMESTAMPTZ,
  result JSONB                            -- draft order names/ids on confirm
);
CREATE INDEX IF NOT EXISTS idx_pending_orders_status ON pending_orders(status);

-- Inbound shipments (back-office / admin only): the logistics truth for stock on the way —
-- origin facility, references, ETA, status timeline, and per-SKU lines with QA'd receiving
-- (counted / damaged / binned). Replaces the Google-Sheet intake process.
CREATE TABLE IF NOT EXISTS inbound_shipments (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'ordered', -- ordered | in_transit | arrived | receiving | received | cancelled
  origin TEXT,                            -- e.g. "Baci Milano HQ (Italy)", "Factory — Guangdong"
  reference TEXT,                         -- PO / invoice / container #
  carrier TEXT,
  tracking TEXT,
  eta DATE,
  notes TEXT,
  timeline JSONB NOT NULL DEFAULT '[]',   -- [{at, status, note, by}]
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_inbound_shipments_status ON inbound_shipments(status);

CREATE TABLE IF NOT EXISTS inbound_lines (
  id TEXT PRIMARY KEY,
  shipment_id TEXT NOT NULL REFERENCES inbound_shipments(id) ON DELETE CASCADE,
  variant_id TEXT,                        -- Shopify variant gid (null if SKU didn't match)
  sku TEXT NOT NULL,
  title TEXT,
  expected INTEGER NOT NULL DEFAULT 0,
  received INTEGER,                       -- counted at intake (null = not yet received)
  damaged INTEGER NOT NULL DEFAULT 0,     -- QA rejects ("items unavailable")
  bins JSONB NOT NULL DEFAULT '[]',       -- [{bin: "1D4", qty: 6}] — multi-bin like the sheet
  shopify_synced BOOLEAN NOT NULL DEFAULT false,
  sync_error TEXT,
  received_at TIMESTAMPTZ,
  received_by TEXT
);
CREATE INDEX IF NOT EXISTS idx_inbound_lines_shipment ON inbound_lines(shipment_id);

-- Seed your ~10 reps (edit, then re-run `npm run migrate` or run manually):
-- INSERT INTO reps (email, name) VALUES
--   ('jane@bacimilanousa.com', 'Jane Doe'),
--   ('rob@bacimilanousa.com',  'Rob Smith')
-- ON CONFLICT (email) DO NOTHING;
