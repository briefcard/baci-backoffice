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
  scopes:
    process.env.SHOPIFY_SCOPES ||
    'read_products,read_inventory,read_locations,read_draft_orders,write_draft_orders',

  // Confirmed business settings (overridable via env)
  sellableLocationIds: (process.env.SELLABLE_LOCATION_IDS ||
    'gid://shopify/Location/104277705016')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  lowStockThreshold: Number(process.env.LOW_STOCK_THRESHOLD || 10),
  defaultDiscountPct: Number(process.env.DEFAULT_WHOLESALE_PCT || 35),
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
  jwtSecret: process.env.JWT_SECRET || 'dev-insecure-secret-change-me',
  databaseUrl: process.env.DATABASE_URL || '',
  resendApiKey: process.env.RESEND_API_KEY || '',
  magicLinkFrom: process.env.MAGIC_LINK_FROM || 'Baci Reps <reps@bacimilanousa.com>',
};

// Numeric Shopify location ids (webhooks send numeric ids, snapshot uses gids).
export const sellableNumericLocationIds = cfg.sellableLocationIds.map((g) =>
  String(g).split('/').pop()
);

export function assertShopifyConfigured() {
  if (!cfg.shopifyStore || !cfg.shopifyToken) {
    throw new Error(
      'Missing SHOPIFY_STORE or SHOPIFY_ADMIN_TOKEN. Copy .env.example to .env and fill them in.'
    );
  }
}
