// Centralized config from env, with the confirmed defaults baked in.
import 'dotenv/config';

function bool(v, d = false) {
  if (v == null) return d;
  return ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());
}

// Interim password auth (before Resend magic links). REP_LOGINS accepts either:
//   [{"email":"a@x.com","name":"A","password":"pw"}, ...]   or   {"a@x.com":"pw", ...}
function parseLogins(raw) {
  if (!raw) return [];
  let v;
  try {
    v = JSON.parse(raw);
  } catch {
    return [];
  }
  const norm = (email, name, password) => ({
    email: String(email || '').toLowerCase().trim(),
    name: name || email,
    password: String(password ?? ''),
  });
  const list = Array.isArray(v)
    ? v.map((u) => norm(u.email, u.name, u.password))
    : Object.entries(v).map(([email, password]) => norm(email, email, password));
  return list.filter((u) => u.email && u.password);
}

// Known materials (matched against product tags) for the Material filter.
// We don't carry glass. Cups are Acrylic or Porcelain; Crystal Touch is CPC (Polycarbonate).
export const MATERIALS = [
  'Acrylic',
  'Melamine',
  'Porcelain',
  'Polyresin',
  'Polycarbonate',
  'Bamboo',
  'Cotton',
  'Stainless Steel',
];

// Customer order-form section order — mirrors the printed order form's catalogue order
// (ORDER_FORM_US_DRAFT_3: Mamma Mia → Zodiac → Joke → Crystal Touch → Sagrada Familia →
// Teste Matte → Firenze → Portofino), then the remaining design lines. Products not in any of
// these get an "Everything else" section client-side so new Shopify items never vanish.
export const ORDER_FORM_COLLECTION_HANDLES = [
  'mamma-mia',
  'zodiac-vibe',
  'joke',
  'crystal-touch',
  'baroque-rock',
  'aqua',
  'sagrada-familia',
  'teste-matte',
  'firenze',
  'portofino',
  'dolce-far-niente',
];

// Curated "design line" collections shown at the top of the rep browse, in this order.
export const MAIN_COLLECTIONS = [
  { handle: 'mamma-mia', title: 'Mamma Mia' },
  { handle: 'sagrada-familia', title: 'Sagrada Familia' },
  { handle: 'aqua', title: 'Aqua' },
  { handle: 'zodiac-vibe', title: 'Zodiac Cups' },
  { handle: 'dolce-far-niente', title: 'Dolce Far Niente' },
  { handle: 'portofino', title: 'Portofino' },
  { handle: 'crystal-touch', title: 'Crystal Touch' },
  { handle: 'firenze', title: 'Firenze' },
  { handle: 'teste-matte', title: 'Teste Matte' },
  { handle: 'baroque-rock', title: 'Baroque & Rock' },
  { handle: 'joke', title: 'Joke' },
];

export const cfg = {
  port: Number(process.env.PORT || 8080),
  appUrl: process.env.APP_URL || 'http://localhost:5173',

  // Shopify
  shopifyStore: process.env.SHOPIFY_STORE || '', // e.g. baci-milano.myshopify.com
  shopifyToken: process.env.SHOPIFY_ADMIN_TOKEN || '',
  apiVersion: process.env.SHOPIFY_API_VERSION || '2026-04',
  // Webhook HMAC secret. For app-registered webhooks this is the app's API secret key (Client Secret).
  webhookSecret: process.env.SHOPIFY_WEBHOOK_SECRET || process.env.SHOPIFY_API_SECRET || '',
  // OAuth credentials (Client ID / Secret). Used to install the app and obtain an access token.
  apiKey: process.env.SHOPIFY_API_KEY || '',
  apiSecret: process.env.SHOPIFY_API_SECRET || '',
  // write_inventory (receive -> stock up) + write_products (bin/ETA metafields) ride along with
  // the pending customer-scopes re-auth so the owner only approves once.
  scopes:
    process.env.SHOPIFY_SCOPES ||
    'read_products,write_products,read_inventory,write_inventory,read_locations,read_draft_orders,write_draft_orders,read_customers,write_customers',

  // Confirmed business settings (overridable via env)
  sellableLocationIds: (process.env.SELLABLE_LOCATION_IDS ||
    'gid://shopify/Location/104277705016')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  lowStockThreshold: Number(process.env.LOW_STOCK_THRESHOLD || 10),
  // How long a "ready to ship" draft order HOLDS its inventory (Shopify reserveInventoryUntil).
  // This is the oversell guard: once a rep confirms an order, those units stop being sellable
  // by other reps/online until the hold expires or the draft completes. 0 disables.
  reserveHours: Number(process.env.RESERVE_INVENTORY_HOURS || 72),
  defaultDiscountPct: Number(process.env.DEFAULT_WHOLESALE_PCT || 50),
  // Backorder deposit %, owner-set (2026-07-01): new customers put more down than repeat/B2B-tagged ones.
  defaultDepositNewPct: Number(process.env.DEFAULT_DEPOSIT_NEW_PCT || 40),
  defaultDepositRepeatPct: Number(process.env.DEFAULT_DEPOSIT_REPEAT_PCT || 30),
  mainCollections: MAIN_COLLECTIONS,

  // Collections hidden from the rep browse (system/SEO/mega collections, not real nav).
  excludedCollectionHandles: (
    process.env.EXCLUDED_COLLECTION_HANDLES ||
    'for-shopify-performance-tracking,appplaza-best-sellers,all,featured-items,baci-summer-collections,baci-milano-modern-unique-dinnerware-home-decor,baci-milano-unique-dinnerware-home-decor,baci-milano-outdoor-dinnerware-home-decor,baci-milano-italian-indoor-dinnerware-home-decor'
  )
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  // Auth / infra (needed for M2; optional in M1 if AUTH_DISABLED=true)
  authDisabled: bool(process.env.AUTH_DISABLED, false),
  repLogins: parseLogins(process.env.REP_LOGINS), // interim email+password auth
  // Checkout-captain gate. Comma list of emails allowed to see the Checkout queue + take POS
  // payments. Leave EMPTY to let every logged-in rep act as captain (fine for a small team /
  // local dev). Set it to lock the Checkout view to one dedicated person.
  captainEmails: (process.env.CAPTAIN_EMAILS || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
  // Per-event access code for the PUBLIC (QR) order form. Customers scanning the booth QR open
  // /?form=<code>; the code gates the catalog + submit endpoints since they expose wholesale
  // prices without a rep login. UNSET = the public form is disabled (kiosk mode still works,
  // it runs under the rep's session). Rotate per show.
  orderFormCode: (process.env.ORDER_FORM_CODE || '').trim(),
  // Customer-facing lead-time estimate for out-of-stock / backorder items.
  leadTimeText: process.env.OOS_LEADTIME_TEXT || '6–10 weeks',
  // Back-office admins: ONLY these emails see the Inbound (shipments) tab. Unlike CAPTAIN_EMAILS,
  // empty does NOT mean everyone — reps must never be bothered by back-office tooling. The dev
  // rep (AUTH_DISABLED) is always an admin so local work stays frictionless.
  adminEmails: (process.env.ADMIN_EMAILS || '')
    .split(',')
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean),
  // Order-form section order (collection handles); defaults to the printed catalogue's order.
  orderFormCollections: (process.env.ORDER_FORM_COLLECTION_HANDLES || ORDER_FORM_COLLECTION_HANDLES.join(','))
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  jwtSecret: process.env.JWT_SECRET || 'dev-insecure-secret-change-me',
  databaseUrl: process.env.DATABASE_URL || '',
  resendApiKey: process.env.RESEND_API_KEY || '',
  magicLinkFrom: process.env.MAGIC_LINK_FROM || 'Baci Reps <reps@bacimilanousa.com>',
};

// Numeric Shopify location ids (webhooks send numeric ids, snapshot uses gids).
export const sellableNumericLocationIds = cfg.sellableLocationIds.map((g) =>
  String(g).split('/').pop()
);

// Whether an email may act as the checkout captain. No CAPTAIN_EMAILS configured → everyone can
// (keeps dev + small teams frictionless); once set, only those emails.
export function isCaptainEmail(email) {
  if (!cfg.captainEmails.length) return true;
  return cfg.captainEmails.includes(String(email || '').toLowerCase());
}

// Back-office admin gate (Inbound shipments). Dev rep always passes; otherwise allow-list only.
export function isAdminEmail(email) {
  const e = String(email || '').toLowerCase();
  if (e === 'dev@local') return true;
  return cfg.adminEmails.includes(e);
}

// True when the granted OAuth scopes cover everything the app currently needs.
export function scopesSatisfied(granted) {
  if (!granted) return false;
  const have = new Set(String(granted).split(',').map((s) => s.trim()).filter(Boolean));
  return cfg.scopes.split(',').map((s) => s.trim()).filter(Boolean).every((s) => have.has(s));
}

export function assertShopifyConfigured() {
  if (!cfg.shopifyStore || !cfg.shopifyToken) {
    throw new Error(
      'Missing SHOPIFY_STORE or SHOPIFY_ADMIN_TOKEN. Copy .env.example to .env and fill them in.'
    );
  }
}
