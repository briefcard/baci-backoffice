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

-- Personalized customer order-form links (lookbook + prefilled form + curated collections).
CREATE TABLE IF NOT EXISTS form_links (
  token TEXT PRIMARY KEY,
  customer JSONB,                -- { id, company, contact, email, phone }
  collections JSONB NOT NULL DEFAULT '[]', -- collection handles; empty = full catalog
  note TEXT,
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  active BOOLEAN NOT NULL DEFAULT true,
  hits INTEGER NOT NULL DEFAULT 0,
  last_used_at TIMESTAMPTZ
);

-- Price-free sharing (added later; idempotent). 'wholesale' = the link shows wholesale + MSRP
-- and takes orders; 'none' = a price-free catalogue where the customer hearts what interests
-- them and the submission comes back as a quote request.
ALTER TABLE form_links ADD COLUMN IF NOT EXISTS pricing TEXT NOT NULL DEFAULT 'wholesale';

-- Whether a pool row is a firm order form or a request for a quote (added later; idempotent).
ALTER TABLE pending_orders ADD COLUMN IF NOT EXISTS intent TEXT NOT NULL DEFAULT 'order';

-- Supplier-invoice payment tracking on shipments (added later; idempotent).
ALTER TABLE inbound_shipments ADD COLUMN IF NOT EXISTS payment_status TEXT NOT NULL DEFAULT 'unpaid'; -- unpaid | deposit_paid | paid
ALTER TABLE inbound_shipments ADD COLUMN IF NOT EXISTS paid_amount NUMERIC;
ALTER TABLE inbound_shipments ADD COLUMN IF NOT EXISTS invoice_total NUMERIC;

-- Customs/freight documents per shipment (7501, BL, commercial invoice, packing list…) or
-- company-scoped standing docs (customs-broker POA, with expiry). Files live in GOOGLE DRIVE —
-- the WhatsApp agent owns Drive I/O; we keep metadata + links only.
CREATE TABLE IF NOT EXISTS inbound_documents (
  id TEXT PRIMARY KEY,
  shipment_id TEXT REFERENCES inbound_shipments(id) ON DELETE CASCADE, -- NULL for company-scoped
  scope TEXT NOT NULL DEFAULT 'shipment',   -- shipment | company
  doc_type TEXT NOT NULL,                   -- commercial_invoice | packing_list | bill_of_lading | 7501 | poa | …
  status TEXT NOT NULL DEFAULT 'received',  -- required | received | approved | filed
  drive_file_id TEXT,
  drive_url TEXT,
  filename TEXT,
  notes TEXT,
  expires_at DATE,                          -- POA / standing docs
  created_by TEXT,
  approved_by TEXT,
  approved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_inbound_documents_shipment ON inbound_documents(shipment_id);
CREATE INDEX IF NOT EXISTS idx_inbound_documents_scope ON inbound_documents(scope);

-- Seed your ~10 reps (edit, then re-run `npm run migrate` or run manually):
-- INSERT INTO reps (email, name) VALUES
--   ('jane@bacimilanousa.com', 'Jane Doe'),
--   ('rob@bacimilanousa.com',  'Rob Smith')
-- ON CONFLICT (email) DO NOTHING;

-- ---- Order book (added later; idempotent) ----
-- Every order the app creates is recorded here with its lines, so a client's order can be
-- followed after the Shopify drafts are created. Shopify stays the record for payment; this is
-- the record of what was ordered and where each unit is coming from.
CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'open',      -- open | cancelled
  customer JSONB,                           -- { id, name, email, phone, isRepeat }
  rep_email TEXT,
  rep_name TEXT,
  pending_id TEXT,                          -- pending_orders.id when it came from a form
  notes TEXT,
  volume_discount_pct NUMERIC NOT NULL DEFAULT 0,
  subtotal NUMERIC,                         -- wholesale subtotal before the volume discount
  ready_draft JSONB,                        -- { id, name, total, invoiceUrl }
  backorder_draft JSONB,                    -- same + depositPct, depositAmount, balanceAmount
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_orders_created ON orders(created_at DESC);

CREATE TABLE IF NOT EXISTS order_lines (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  variant_id TEXT NOT NULL,
  sku TEXT,
  title TEXT,
  quantity INTEGER NOT NULL,
  unit_price NUMERIC,                       -- wholesale unit price at order time
  ready_qty INTEGER NOT NULL DEFAULT 0,     -- covered by Miami stock at order time
  backorder_qty INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_order_lines_order ON order_lines(order_id);

-- Where each ordered unit comes from. A line can have several rows: some units from stock,
-- some from one shipment, some from another, some not yet sourced. One shipment line can feed
-- many orders. shipment_line_id is deliberately NOT a foreign key: saving a shipment rewrites
-- its lines (same ids), and a removed line must release its reservations, not delete them.
CREATE TABLE IF NOT EXISTS allocations (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  order_line_id TEXT NOT NULL REFERENCES order_lines(id) ON DELETE CASCADE,
  variant_id TEXT NOT NULL,
  quantity INTEGER NOT NULL,
  source TEXT NOT NULL,                     -- stock | shipment | unsourced
  shipment_id TEXT,
  shipment_line_id TEXT,
  firm BOOLEAN NOT NULL DEFAULT false,      -- true once the deposit is paid: not reshuffled
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_allocations_order ON allocations(order_id);
CREATE INDEX IF NOT EXISTS idx_allocations_shipment_line ON allocations(shipment_line_id);

-- Deposits as two Shopify invoices (added later; idempotent). The store is not on Shopify Plus,
-- so a native draft-order deposit is unavailable: a backorder gets a separate deposit draft paid
-- now, and the backorder draft is credited with it when the balance is prepared.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS deposit_draft JSONB;   -- { id, name, amount, pct, invoiceUrl, status: open|paid, paidAt }
ALTER TABLE orders ADD COLUMN IF NOT EXISTS balance JSONB;         -- { amount, credit, preparedAt, preparedBy }
