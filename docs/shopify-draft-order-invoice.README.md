# Branded draft-order invoice (Shopify notification template)

Makes app-created wholesale quotes go out looking like our order form instead of a plain
Shopify order, while payment still runs through Shopify's secure checkout.

File to paste: **`shopify-draft-order-invoice.liquid`**

## Install

1. Shopify admin → **Settings → Notifications → Customer notifications → Draft order invoice → Edit code**
2. **Select all and COPY the existing code first.** You need it in step 4.
3. Replace everything with `shopify-draft-order-invoice.liquid`.
4. Paste what you copied in step 2 into the block near the bottom marked
   `RETAIL / NON-APP DRAFTS`.
   ⚠️ **If you leave that block empty, retail draft invoices send a blank email.**
5. Save, then send yourself two test invoices — one from an app-created draft, one from a
   hand-built retail draft — and confirm each renders the right way.

(Shopify's editor has a *Revert to default* button if you ever need the stock code back.)

## How it's scoped

Shopify has **one** draft-order-invoice template for the whole store, so the file guards on the
`b2b-app` tag that the rep app stamps on every draft it creates (`server/src/orders.js`):

| Draft | Renders |
|---|---|
| Created by the rep app (tagged `b2b-app`) | Branded wholesale quote |
| Anything else (hand-built retail drafts, etc.) | Your original template, untouched |

## Liquid gotchas (learned the hard way)

Shopify's notification-template parser is **stricter than a standard Liquid parser** — a template
that renders fine in liquidjs can still be rejected here. Two rules for editing this file:

- **No `{% comment %}` blocks.** A comment nested inside the `{% for line in line_items %}` loop
  made Shopify lose the loop context and reject the template with `Unknown tag 'endfor'`. Keep
  documentation in this README, and use HTML `<!-- -->` comments in the template if you must.
- **`{{ custom_message }}` must appear unconditionally.** Shopify requires that drop present and
  errors with *"Body is missing the {{ custom_message }} drop"* if it's wrapped in a conditional.
- Whitespace-control tags (`{%-` / `-%}`) are also avoided here for maximum compatibility.

## Variables used

Notification templates expose draft-order fields **unprefixed** — `{{ name }}`, not
`{{ order.name }}`.

| Purpose | Variable |
|---|---|
| Pay link | `invoice_url` |
| Order number | `name` |
| Quote validity | `created_at \| date:"%s" \| plus: 604800` (7 days) |
| Line thumbnail | `line \| image_url: width: 120` (`img_url` is deprecated) |
| MSRP vs wholesale | `line.original_price` vs `line.price` |
| Deposit figures | `attributes["Deposit required"]`, `attributes["Balance due at fulfillment"]` |
| Ready vs backorder | `tags contains 'backorder'` |

## Two things to confirm on the first real test send

Both were grounded in Shopify's docs but not verified against a live draft:

1. **MSRP row** relies on `line.original_price` being populated for discounted draft lines. If
   "MSRP $220.00" doesn't appear, source MSRP another way.
2. **Deposit block** relies on the draft's custom attributes. If DUE TODAY is blank on a backorder
   invoice, parse the `deposit-pct:<n>` tag instead.

## Keep in sync

The 7-day validity matches `quoteTerms()` in `web/src/components/PrintDocs.jsx`. If one changes,
change the other.
