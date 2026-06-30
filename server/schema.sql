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

-- Seed your ~10 reps (edit, then re-run `npm run migrate` or run manually):
-- INSERT INTO reps (email, name) VALUES
--   ('jane@bacimilanousa.com', 'Jane Doe'),
--   ('rob@bacimilanousa.com',  'Rob Smith')
-- ON CONFLICT (email) DO NOTHING;
