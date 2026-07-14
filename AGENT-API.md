# Baci Backoffice — WhatsApp Agent API Contract

The `gomehagent` WhatsApp system uses this API as its **inbound-logistics context store**: it logs
shipments/RFQs, tracks the customs/freight document set per shipment, and answers status questions.
Think of it as an MCP-style tool surface — a small set of endpoints with hard rules the agent must
follow. Files themselves live in **Google Drive** (the agent owns Drive I/O); this API stores only
metadata + links.

## Auth
Every call sends `Authorization: Bearer <AGENT_API_TOKEN>` (same value in both Render services).
The token acts as the synthetic identity **agent@whatsapp** and is accepted on the inbound +
documents endpoints ONLY. It is rejected (401) on `/api/orders`, `/api/customers/*`,
`/api/checkout/*`, and QA receive (`/api/inbound/:id/receive`) — those need a human session.

Base URL: `https://baci-backoffice.onrender.com`

## The rules (enforce agent-side too)
1. **Never create a duplicate shipment.** Before `POST /api/inbound`, the server checks the
   canonical reference (e.g. `131/2026`, `ORD 131-2026`, `PKLIST_131_2026` all normalize to
   `131/2026`). If one exists you get **409** with `duplicate:true` and the `existing` shipment.
   → Update that shipment instead. Only pass `allowDuplicate:true` after a human confirms it's
   genuinely new.
2. **Match before you write a document.** Extract refs from the PDF, call `/api/agent/match?q=…`,
   and attach the doc to the returned shipment id. If 0 matches → ask the owner which shipment (or
   create one). If >1 → disambiguate with the owner; don't guess.
3. **Approvals are explicit.** A document only becomes `approved`/`filed` when the owner says so
   (e.g. replies "approve"). The agent sets `status:"approved"`; the server stamps
   `approvedBy: agent@whatsapp` + timestamp into the audit trail.
4. **Every write is timeline-stamped** on the shipment ("Bill of Lading received via WhatsApp
   Agent") — no silent changes.

## Endpoints

### Context (reads)
- `GET /api/agent/shipments` — the agent's world model: all live shipments (received drop off
  after 30 days, cancelled never show) each with its document `checklist`, plus company docs +
  `requiredDocs`. Poll this to build daily digests (past-ETA via `daysLate`, `docs.missing`).
- `GET /api/agent/shipments/:id` — one shipment in full: lines + timeline + documents.
- `GET /api/agent/match?q=<ref|container|tracking>` — resolve which shipment a doc/message is
  about. Returns `matches[]` ranked (reference > tracking > notes) with `matchedOn`.

### Shipments (create / update)
- `POST /api/inbound` — create. Body: `{reference, origin, status, eta, carrier, tracking, notes,
  lines:[{sku, expected, title}]}`. Honors the dedup guard above. Use for supplier ORD/pro-forma
  ("ordered") and packing lists ("in_transit").
- `POST /api/inbound/:id` — update header/status/ETA/notes/payment. Status moves are timeline-
  stamped. (Same endpoint the board uses — "mark 131 arrived" = `{status:"arrived"}`.)
- `POST /api/inbound/parse` — multipart file (PDF/XLSX) → parsed lines/ref/origin for review
  before create. The agent forwards a supplier doc here, then creates the shipment from the result.

### Documents (per shipment)
- `GET  /api/inbound/:id/documents` — documents + computed `checklist`.
- `POST /api/inbound/:id/documents` — register. Body: `{docType, status, driveFileId, driveUrl,
  filename, notes}`. `docType` accepts aliases (`"bill of lading"`, `"BL"`, `"7501"`, …).
  `status` defaults to `received`.
- `POST /api/inbound/:id/documents/:docId` — update status (`received`→`approved`→`filed`) /
  Drive link / notes.

### Company-scoped documents (standing docs, e.g. customs-broker POA)
- `GET  /api/documents` — list.
- `POST /api/documents` — create. Body: `{docType, status, expiresAt, driveUrl, …}` (no shipment).
- `POST /api/documents/:docId` — update.

## Document types
Canonical slugs: `commercial_invoice`, `packing_list`, `bill_of_lading`, `7501`, `poa`,
`arrival_notice`, `isf`, `delivery_order`, `freight_invoice`. Unknown types are slugified and kept
(nothing bounces). Required set per shipment = `REQUIRED_DOCS` env
(default `commercial_invoice,packing_list,bill_of_lading,7501`).

## Status ladders
- Shipment: `draft → ordered → in_transit → arrived → receiving → received` (+`cancelled`).
- Document: `required → received → approved → filed`.

## Conversation flows this supports
- Forwarder sends BL PDF → agent extracts refs → `match` → `POST …/documents` (received) → notify
  owner → owner replies "approve" → `POST …/documents/:docId {status:"approved"}` → agent moves the
  Drive file to the final folder → `{status:"filed"}`.
- "Status of 131/2026?" → `match` → `agent/shipments/:id` → report status + payment + `docs.missing`.
- Supplier ORD PDF → `parse` → `POST /api/inbound` (dedup-guarded) as `ordered`.
- "Mark 131 arrived" → `match` → `POST /api/inbound/:id {status:"arrived"}`.
- Daily digest → `GET /api/agent/shipments` → list `daysLate>0` and any `docs.missing`.

## Agent-side build (gomehagent repo — NOT in this repo)
Drive upload (folder convention `Baci Inbound/<year>/<ref>/<doctype>_<filename>`), reference
extraction from PDFs, and the calls above. Set `AGENT_API_TOKEN` + `BACI_BACKOFFICE_URL` in that
service. Build against this contract; every endpoint here is curl-testable without agent changes.
