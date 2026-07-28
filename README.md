# Goods In — Inventory Receiving

A modern, scanner-first web application for the **Goods In** (inbound receiving) workflow used by wholesale device traders, refurbishers, and graders.

## Project Overview
- **Name**: Goods In
- **Goal**: Turn the chaotic process of receiving a pallet of phones into a single, frictionless scan-and-print loop — from supplier ASN through to printed internal label.
- **Stack**: Hono (Cloudflare Pages) · TypeScript · Cloudflare D1 (SQLite) · Tailwind (CDN) · vanilla JS SPA · QRCode.js

## Live URLs
- **Production (Genspark-hosted Cloudflare)**: https://d6aea290-bd61-4f82-aa8d-94378b9f2fec.vip.gensparksite.com
- **Master Checklist tracker**: https://d6aea290-bd61-4f82-aa8d-94378b9f2fec.vip.gensparksite.com/tracker/
- **Sandbox preview (dev)**: https://3000-i4zj15jax42ejggi6n8yt-b32ec7bb.sandbox.novita.ai
- **API health**: `/api/health` (the only unauthenticated endpoint besides `POST /api/auth/dev-login`)

## Authentication & Multi-Tenancy

Every route under `/api/*` requires a valid JWT **except** `GET /api/health` and `POST /api/auth/dev-login`. Unauthenticated or invalid-token requests get a `401`.

- **Login**: `POST /api/auth/dev-login` with body `{"email"?: string}` (defaults to the seeded admin) looks up a seeded user and returns `{token, user}`. There is no password yet — this app has no real IdP wired up. Swapping this for real credential checking or Cloudflare Access later only touches `src/routes/auth.ts` / `src/lib/auth.ts`; every other route just consumes `c.var.user` and doesn't care how it was populated.
- **Token**: HS256 JWT (`hono/jwt`), 12h TTL, signed with `JWT_SECRET` (set via `.dev.vars` locally, `wrangler secret put JWT_SECRET` in production). Claims: `sub` (user id), `email`, `name`, `role`, `org_id`.
- **Sending the token**: the SPA stores it in `localStorage` and axios attaches `Authorization: Bearer <token>` to every API call. The one exception is the DYMO label pages opened via `window.open()` for **Browser Print** mode — a plain browser navigation can't carry a header, so those URLs fall back to a `?token=` query param (`extractToken()` in `src/lib/auth.ts` checks the header first, then the query param). **Known limitation, flagged for later hardening**: tokens in URLs can leak into server logs / browser history — acceptable for the current dev/demo auth story, but should be revisited before this goes to production with a real IdP.
- **Multi-tenancy**: every domain table (`received_devices`, `device_events`, `webhooks`, etc.) carries `organisation_id`. Every write records both `user_id` and `organisation_id` from the verified token; every read query is scoped with `WHERE organisation_id = ?`. There is currently one seeded organisation (`Default Organisation`, id `1`).
- **Who am I**: `GET /api/auth/me` returns `{user}` for the current token — used by the SPA on boot to validate a stored token before loading app data, and by any external client to sanity-check its token.

## Workflow Implemented

### A. Expected Devices (ASN / Manifest)
- **Upload module** in `Manifests` view: drag-and-drop or click to ingest **CSV / XLS / XLSX**.
- Auto-parses the supplier's *Packing List* format (the provided `YH001-Saigates Limited_260608.xlsx` works out of the box — columns: OEM, Condition, Description, Grade, MODEL NO., IMEI).
- Validates identifiers (strictly **15-digit IMEIs** passing the GSMA Luhn checksum, or **10-character alphanumeric serials** for non-cellular devices — rule tightened 2026-07-28 per owner brief; 14-digit TAC+SN and 16-digit IMEISV forms are rejected), de-duplicates, and pre-resolves a candidate SKU from the description.
- **Optional valuation-hint columns** (added 2026-07-28 after the owner asked “no option to include the prices in USD and VAT Type — do we add the prices at a later stage?” while manually testing): the upload mapper also recognises **Unit cost** (`unit cost`, `price`, `buy price`…), **Currency** (`currency`, `curr`, `ccy` — ISO 4217, uppercased at import so `usd` → `USD`) and **VAT type** (`vat type`, `vat`, `vat scheme` — `MARGIN` / `STANDARD` / `ZERO` / `PVAT`, where **PVAT = Postponed VAT**, import accounting). When the price header **embeds the currency** — e.g. `Price (USD)`, `Unit Cost (GBP)` (the real Saigates supplier format) — it auto-maps as the unit-cost column and the ISO code is **inferred from the header** for rows that carry a price, so no separate Currency column is needed. Each row's hints are validated server-side at import with the **same validators** goods-in uses; a row with a junk hint (unknown currency, negative price, bad VAT type) is flagged in the response's `invalid_valuations` and **skipped** — never silently stored — and the UI shows a warn toast with the skipped count. At scan time, a matched line's hints **pre-fill** the confirm modal's Buy price / Currency / VAT type. **Hints only**: `/scan/confirm` still requires operator-confirmed valuation, and the operator's (possibly edited) values are what land on the received device — the manifest line itself is never modified.
- Populates the **Pending Receipt Queue** visible in the receive view.
- Progress widget shows `received / expected` and a `%` bar that updates after every scan.

### B. Scan Individual IMEIs (HID barcode scanner)
- The receive view has a **globally focused input** — clicking anywhere outside form controls refocuses the scan box, so a Honeywell/Zebra HID scanner can fire `IMEI\n` repeatedly without interaction.
- On scan the frontend optimistically pulses the input ring, plays a short WebAudio bleep (toggleable), and cross-references the IMEI against the active manifest.
- Edge cases handled:
  - **Matched** → opens a confirm-SKU modal (suggested SKU pre-filled).
  - **Duplicate** → amber toast with the existing UUID, no double-receive.
  - **Unreconciled (not on manifest)** → red warning ring + modal forcing the operator to either **Reject** the device (audit-logged) or **Force-add** it to the *Unreconciled* bucket for manager review.
  - **Rejected** (malformed IMEI) → red bleep + toast.

### C. Add / Confirm SKU
- If the manifest's description maps cleanly, the suggested SKU is auto-built using `BRAND-MODELSHORT-CAPACITY-COLOR` (e.g. `SMSG-S24-512-PBK`).
- Operator can override any field (brand / model / capacity / color / grade) before confirming.
- **Grade options**: `A+`, `A`, `B+`, `B`, `C+`, `C`, `D`, and **`UG`** (Ungraded / Untested — for devices arriving without a supplier grade or routed straight to QC). `UG` shows up as a violet badge throughout the UI to make ungraded stock easy to spot.
- Force-add path generates the same SKU shape for off-manifest devices.
- **Valuation & VAT** (required on **every** path that creates a device — `/confirm`, `/force-add`, AND `/manual` (Quick receive). General rule, earned through evidence after force-add shipped as a real bypass: any intake path enforces the same server-side valuation rules, and any future intake path inherits `required: true` by default): **buy price**, **currency** (ISO 4217, default `GBP` — an unrecognised code like `UKL` is rejected with a `422`, server-side, regardless of what the UI allowed through), **VAT type** (`MARGIN` / `STANDARD` / `ZERO` / `PVAT` — Postponed VAT for import accounting, added 2026-07-28 per owner confirmation), and an optional **supplier id** (confirm only). The client-side checks in the confirm and force-add modals are optimistic only, to save an obviously-wasted round trip — `src/lib/validate.ts` on the server is the authoritative validator and is what actually enforces these rules.

### D. Print Label — connects to a real DYMO LabelWriter
- On confirm, a print job is queued in the `print_jobs` table with a JSON payload.
- **Two label formats supported** (toggle in the top bar — preference persists per browser via `localStorage`):
  - **DYMO 57×32mm** (landscape, default) — large-format label for the warehouse floor.
  - **DYMO 32×57mm** (portrait) — compact label for the receiving desk.
- **Rotate-90° toggle** (top bar ↻ icon, also exposed in Settings) — for DYMO LabelWriter setups where the label roll feeds the **short edge first**, so a 57×32 landscape page would otherwise come out sideways and overflow onto a second sticker. With rotate on, the `@page` is declared as 32×57 (what the printer expects) while the label content stays landscape and is CSS-rotated 90° internally — one label, correct orientation, one sticker. Persisted as `labelRotate.v1` in `localStorage`.
- Both labels carry the same data and **two QR codes** (rendered by `qrious@4.0.2`):
  - **Main QR** — encodes `{uuid, sku, imei}` as JSON. Routes the device to any internal scan target.
  - **IMEI QR** — plain-text IMEI only. Lets cheap or basic scanners (or warranty/repair tools that expect raw IMEIs) read the IMEI directly from the printed label without parsing JSON.
- Plus the human-readable fields:
  - Internal **UUID** (12-char short code)
  - Clean human-readable **SKU**
  - **IMEI** in monospace
  - Brand · Model · Capacity · Grade (incl. the **UG / Ungraded** state)

#### Three printer modes (choose in **Settings**)

| Mode | What happens when you click `Send` | When to use |
|---|---|---|
| **Browser Print** (default) | App opens a print window pre-sized via `@page size: 50mm 30mm` (or 32×57mm) — your OS print dialog appears, you pick the DYMO printer and click Print. After printing, the window posts back and jobs are marked `sent` automatically. | Easiest setup — just install the DYMO driver. Works for single-operator stations. |
| **PrintNode** (cloud) | Server-side `POST` to `https://api.printnode.com/printjobs` with `pdf_uri` pointing back at `/api/print/label/:id`. The PrintNode agent on the warehouse PC picks up the job and feeds it straight to the DYMO LabelWriter — no operator print dialog. | Multi-station / hands-off / unattended printing. Requires a PrintNode account + agent installed on the LAN. |
| **Manual / Off** | Just flips `print_jobs.status` to `sent`. No physical print. | Testing / when labels are printed via some external workflow. |

The Settings view (gear icon in the top bar) toggles between modes, lets you paste & store a PrintNode API key (kept server-side — never returned to the browser), and pulls the live list of available printers from PrintNode so you can map the DYMO 50×30 and DYMO 32×57 stations independently.

### E. Inventory Update
- A successful confirm writes a `received_devices` row with `status = 'RECEIVED'`.
- The IMEI is now visible in the **Inventory** view with full search (UUID/SKU/IMEI), source badge (manifest vs unreconciled), and print status.

### F. Device Status Lifecycle & Audit Trail
Every `received_devices` row carries a `status` enum, defaulting to `RECEIVED`:

`RECEIVED → SORTING → {ACTIVE_INVENTORY | IN_HOUSE_REPAIR | READY_FOR_EXPORT}`, `IN_HOUSE_REPAIR → ACTIVE_INVENTORY`, `RECEIVED → REJECTED`, and — wired by OPR 2 — `READY_FOR_EXPORT ↔ IN_EXPORT_CONSIGNMENT → EXPORTED_UNDER_OPR`.

`ACTIVE_INVENTORY`, `EXPORTED_UNDER_OPR`, `REJECTED` are currently terminal. The export transitions are **OPR-workflow-only**: a device becomes `IN_EXPORT_CONSIGNMENT` exactly when it has a line on a DRAFT export shipment and `EXPORTED_UNDER_OPR` exactly when that shipment finalises, so the generic `/api/devices/:id/transition` endpoint refuses to move devices into **or** out of those statuses (409) — only the `/api/opr/shipments/:id/lines|scan|finalise` endpoints may drive them, keeping `shipment_lines` and the device ledger in lockstep. The return leg is wired by OPR 3: `EXPORTED_UNDER_OPR → RETURNED_UNDER_OPR` happens exactly when an import (return) shipment finalises, and `RETURNED_UNDER_OPR → ACTIVE_INVENTORY` via the explicit `/restock` step — both OPR-workflow-only, refused by the generic endpoint. `SOLD` exists in the enum but stays unwired (downstream sales flow, not OPR). `GET /api/devices/meta/statuses` returns the full enum plus the exact allowed-transition map so a future UI/CRM never has to hardcode it.

All status changes go through a single choke point, `transitionDevice()` (`src/lib/deviceLifecycle.ts`):
1. Validates the requested transition against the allowed-transition map — anything not listed is rejected with `409 invalid_transition`.
2. Writes the `received_devices` UPDATE and a `device_events` INSERT in one atomic D1 `batch()` call, so the two can never diverge.
3. Invariant enforced by construction: a device's `status` always equals the `to_status` of its own most recent `device_events` row.

`device_events` is an **append-only audit log** — every receive, status transition, and rejection is recorded with `organisation_id`, `device_id`, `event_type` (`RECEIVE` / `STATUS_CHANGE` / `REJECT`), `from_status`, `to_status`, `user_id`, an optional `reference`, and optional JSON `metadata`. Nothing is ever updated or deleted from this table. The pre-existing `scan_events` table (matched/duplicate/unreconciled/rejected scan attempts, before a device is created) is unchanged and still written alongside it.

### G. Read API, Export & Webhooks
- `GET /api/devices` and `GET /api/devices/:id` are the primary integration seam for a future CRM/OPR module — filterable, paginated, org-scoped, with `:id` returning the full event history alongside the device.
- `GET /api/devices/export/csv` exports a CSV (`Content-Disposition: attachment`) of the currently-filtered devices, or an exact operator-picked selection via `?ids=1,2,3`.
- `POST /api/devices/:id/transition` fires an outbound webhook (if any are configured for the org) after every successful status change — see **Outbound Webhooks** below.

## Outbound Webhooks

Configured per-organisation via `POST /api/webhooks` (`{url}` → returns `{id, url, secret, enabled}` — **the secret is only ever returned once, at creation time**, the same rule as the PrintNode API key). Every successful `POST /api/devices/:id/transition` then POSTs a JSON payload to every `enabled` webhook for that org:

```json
{
  "event": "device.status_changed",
  "organisation_id": 1,
  "device_id": 15,
  "imei": "356102152723494",
  "uuid": "B44FF3AA791C",
  "from_status": "SORTING",
  "to_status": "ACTIVE_INVENTORY",
  "user_id": 1,
  "occurred_at": "2026-07-27T17:50:21.762Z"
}
```

The request carries `X-Signature: sha256=<hex>` — an HMAC-SHA256 of the exact raw JSON body, keyed with the webhook's secret (same pattern as GitHub/Stripe signature verification: recompute the HMAC over the raw body you received, with the secret you were given at creation time, and compare hex strings). Delivery failures are logged and swallowed — a downstream system being down must never block or fail the transition that triggered it. `POST /api/webhooks/:id/toggle` (`{enabled}`) disables/enables delivery without deleting the config; `DELETE /api/webhooks/:id` removes it.

## Functional Entry URIs

### Pages (UI)
| Path | Description |
|---|---|
| `/` | Single-page app (Dashboard / Manifests / Receive / Inventory / Print Queue) |

### API
Every row below is under `/api/*` and requires `Authorization: Bearer <token>` **except** the two marked 🔓. All are scoped to the caller's `organisation_id`.

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET`  | `/api/health` | 🔓 | Liveness probe |
| `POST` | `/api/auth/dev-login` | 🔓 | Body: `{email?}`. Returns `{token, user}` |
| `GET`  | `/api/auth/me` | 🔒 | Returns `{user}` for the current token |
| `GET`  | `/api/inventory/stats` | 🔒 | Counts for dashboard tiles |
| `GET`  | `/api/manifests` | 🔒 | List manifests with progress |
| `GET`  | `/api/manifests/:id` | 🔒 | Detail with expected & unreconciled |
| `POST` | `/api/manifests` | 🔒 | Create manifest. Body: `{reference, supplier, notes?, rows[]}`. Rows may carry optional valuation hints `unit_cost` / `currency` (ISO 4217, uppercased) / `vat_type` (`MARGIN`\|`STANDARD`\|`ZERO`\|`PVAT`) — validated per row; bad-hint rows are returned in `invalid_valuations` and skipped |
| `POST` | `/api/manifests/:id/close` | 🔒 | Close manifest |
| `POST` | `/api/manifests/:id/reopen` | 🔒 | Reopen manifest |
| `DELETE` | `/api/manifests/:id` | 🔒 | Delete manifest (received devices remain) |
| `POST` | `/api/scan` | 🔒 | Scan IMEI. Body: `{manifest_id, imei}`. Returns `matched` / `duplicate` / `unreconciled` / `rejected`. Server re-validates the identifier (**strictly 15 digits + Luhn**, or a **10-character alphanumeric serial** for non-cellular devices, uppercased) regardless of client-side checks |
| `POST` | `/api/scan/confirm` | 🔒 | Confirm matched SKU. Body: `{expected_device_id, sku, brand, model, capacity, color, grade, notes?, auto_print?, buy_price, currency, vat_type, supplier_id?}`. Valuation fields (`buy_price`, `currency`, `vat_type`) are **required**, validated server-side (`422` on missing/invalid — e.g. an unrecognised ISO 4217 code) |
| `POST` | `/api/scan/force-add` | 🔒 | Force-add unreconciled IMEI to inventory. Same body shape as `/confirm`; valuation fields are optional here but still server-validated if present |
| `POST` | `/api/scan/manual` | 🔒 | Manually add a device outside the scan flow. Same valuation rules as `/force-add` |
| `POST` | `/api/scan/reject` | 🔒 | Audit-log a rejection (writes a `REJECT` `device_events` row) |
| `GET`  | `/api/scan/events/:manifestId` | 🔒 | Recent scan events |
| `GET`  | `/api/inventory` | 🔒 | List received devices. Query: `q`, `source`, `manifest_id`, `limit` |
| `DELETE` | `/api/inventory/:id` | 🔒 | Delete a received device. Restores its manifest line to `pending`, removes queued labels, writes a `DEVICE_DELETED` `device_events` row |
| `POST` | `/api/inventory/grade` | 🔒 | Set/override grade for one or more devices. Body: `{ids: number[], grade, actor?, reason?}`. One `grade_audit` row + one `GRADE_CHANGE` `device_events` row per changed device |
| `GET`  | `/api/inventory/grade-audit/:id` | 🔒 | Grade-change history for a single device |
| `GET`  | `/api/devices?status=&source=&q=&page=&page_size=` | 🔒 | Filterable, paginated device list. `status` accepts a comma-separated list; an unrecognised status is rejected with `400` |
| `GET`  | `/api/devices/:id` | 🔒 | Full device record + its `device_events` history (newest first) |
| `GET`  | `/api/devices/export/csv?status=&source=&ids=` | 🔒 | CSV export (`Content-Disposition: attachment`). `ids` (comma-separated) takes precedence over `status`/`source` for exporting an exact selection |
| `GET`  | `/api/devices/meta/statuses` | 🔒 | Returns `{statuses, transitions}` — the full status enum and allowed-transition map |
| `POST` | `/api/devices/:id/transition` | 🔒 | The single entry point for status changes. Body: `{to_status, reference?, metadata?}`. `409 invalid_transition` if not allowed from the current status; fires configured webhooks on success |
| `GET`  | `/api/webhooks` | 🔒 | List this org's webhooks (secret never included) |
| `POST` | `/api/webhooks` | 🔒 | Register a webhook. Body: `{url}`. Returns the signing secret **once**, at creation |
| `POST` | `/api/webhooks/:id/toggle` | 🔒 | Body: `{enabled}`. Enable/disable delivery without deleting the config |
| `DELETE` | `/api/webhooks/:id` | 🔒 | Remove a webhook |
| `GET`  | `/api/opr/authorisations` | 🔒 | List OPR authorisations (org-scoped). The Saigates record is seeded via `seed.sql` |
| `POST` | `/api/opr/authorisations` | 🔒 | Create an authorisation. Validated: EORI shape, ISO dates ordered, CDS number required (unique per org); CDS + CHIEF numbers stored as **distinct fields** |
| `GET`/`PATCH` | `/api/opr/authorisations/:id` | 🔒 | Read / update an authorisation |
| `GET`  | `/api/opr/shipments` | 🔒 | List shipments with line counts + total declared value |
| `POST` | `/api/opr/shipments` | 🔒 | Create a DRAFT consignment. Enforced server-side: **GBP-only currency (`UKL` rejected)**, procedure codes (`2100`/`2200` export, `6121` import, **`2100+B51` forbidden**, `B51`/`B02` pair with `2200`), declaration charset (letters/numbers/spaces) on `reference`/`consignee_name`, mandatory org-scoped `authorisation_id` linkage |
| `GET`/`PATCH` | `/api/opr/shipments/:id` | 🔒 | Detail (lines + authorisation + total) / edit header. **DRAFT-only**: non-DRAFT shipments are immutable (409) |
| `POST` | `/api/opr/shipments/:id/lines` | 🔒 | Add a device: snapshots IMEI/SKU/attributes/`buy_price` **frozen at add time** (later device edits never leak into the declared line). Devices without `buy_price` rejected (422); one line per device per shipment (409). OPR 2: device must be `READY_FOR_EXPORT` and moves to `IN_EXPORT_CONSIGNMENT` in lockstep (event-logged) |
| `POST` | `/api/opr/shipments/:id/scan` | 🔒 | **Consignment builder**: add a device by IMEI (scanner path). Same rules as `/lines` — `READY_FOR_EXPORT` gate, frozen snapshot, status lockstep |
| `DELETE` | `/api/opr/shipments/:id/lines/:lineId` | 🔒 | Remove a line (DRAFT only); releases the device back to `READY_FOR_EXPORT` (event-logged) |
| `GET` | `/api/opr/shipments/:id/validation` | 🔒 | **Green/amber/red validation engine** — 10 coded checks (currency, authorisation validity on ship date, procedure codes, commodity scope, IMEI Luhn/uniqueness, declaration text, unit values pence-exact, totals consistency, logistics). Red blocks finalisation; amber warns |
| `GET` | `/api/opr/shipments/:id/invoice` | 🔒 | **Print-ready A4 commercial invoice** (HTML → browser print). Built from the frozen line snapshots; carries the CDS authorisation number (never the CHIEF one), procedure + commodity codes, OPR no-sale declaration |
| `GET` | `/api/opr/shipments/:id/scan-out` | 🔒 | IMEI/value scan-out list — total equals the invoice total by construction (same pence-exact sum) |
| `GET` | `/api/opr/shipments/:id/prealert` | 🔒 | Carrier customs **pre-alert email draft**. Mailbox + cut-off come from the authorisation record (`prealert_email`/`prealert_cutoff` — configurable data, seeded for FedEx); nothing is sent (OPR 4) |
| `POST` | `/api/opr/shipments/:id/finalise` | 🔒 | **Finalisation**: blocked while validation has red results (422 + the failing checks, zero side-effects); locks lines/PATCH; every device → `EXPORTED_UNDER_OPR` through the state machine (event-logged); captures `export_mrn`/`ducr`/`ead_mrn` |
| `POST` | `/api/opr/shipments/:id/export-proof` | 🔒 | Record/replace MRN / DUCR / EAD after finalisation — deliberately the **only** mutation a FINALISED export accepts. Export-direction only (409 on imports → use `/import-proof`) |
| POST | `/api/opr/shipments/:id/prealert/mark-sent` | Record an operator's MANUAL pre-alert send (provider=manual/status=manual outbox row; server-built subject; optional validated `to` override) |
| POST | `/api/opr/shipments/:id/clearance/mark-sent` | Record an operator's MANUAL clearance-instruction send (same honest manual row) |
| `GET` | `/api/opr/shipments/:id/ce1154` | 🔒 | **C&E1154 duty-relief form** (OPR 3) — `?format=json` or print-ready A4 HTML. Quantity from the consignment, repair cost → GBP at the customs rate, exported-goods value = **frozen declared-at-export value of the returning devices only**, relief = duty on (goods+repair) minus duty on repair. The authorisation field carries the **CHIEF** number; the CDS number appears **only** in the cross-reference statement — a missing CHIEF number refuses (422) rather than substituting |
| `GET` | `/api/opr/shipments/:id/clearance` | 🔒 | **Re-import clearance-instruction draft** (OPR 3): procedure 6121, quotes the original export MRN, duty/VAT on **repair cost only**. Nothing is sent (OPR 4) |
| `GET` | `/api/opr/discharge` | 🔒 | **Discharge tracker** built from real shipment lines: per finalised export — exported vs returned vs outstanding device counts, deadline = export date + authorisation discharge period (day-clamped month maths), status open/closing/overdue/discharged + summary |
| `POST` | `/api/opr/shipments/:id/finalise` (import) | 🔒 | **Receipt**: same endpoint, direction-aware. Red-blocked by the 10-check import validation engine (discharge-window overrun is amber, not red); captures `import_mrn`; every device → `RETURNED_UNDER_OPR` (event `IMPORT_RECEIVED` with the MRN) |
| `POST` | `/api/opr/shipments/:id/import-proof` | 🔒 | Record/replace the 6121 import MRN on a FINALISED import |
| `POST` | `/api/opr/shipments/:id/restock` | 🔒 | Explicit restock step: `RETURNED_UNDER_OPR` → `ACTIVE_INVENTORY` (event `RETURN_RESTOCKED`); idempotent — already-restocked devices are skipped, not errored |
| `POST` | `/api/opr/shipments/:id/prealert/send` | 🔒 | **OPR 4: actually SENDS** the pre-alert via the Gmail REST API with the commercial invoice + scan-out attached. **Refuses 503 `gmail_not_configured`** (writing nothing) unless the `GMAIL_CLIENT_ID`/`GMAIL_CLIENT_SECRET`/`GMAIL_REFRESH_TOKEN` secrets are all set; refuses 422 if no `prealert_email` is configured (never invents a recipient). Every real attempt lands in the `sent_emails` outbox — success with the provider message id, or failure (502) with the provider error |
| `POST` | `/api/opr/shipments/:id/clearance/send` | 🔒 | **OPR 4: SENDS** the clearance instruction (C&E1154 attached when computable) to `{ to }` from the body or the authorisation's pre-alert mailbox. Same honesty gate + outbox rules as pre-alert send |
| `GET` | `/api/opr/shipments/:id/emails` | 🔒 | The `sent_emails` outbox for a shipment — an empty list genuinely means nothing was ever attempted |
| `POST` | `/api/opr/shipments/:id/scan-bulk` | 🔒 | **OPR 4: bulk consignment builder** — `{ imeis: […] }` (≤200). Each IMEI goes through **exactly** the same direction-aware gates as single `/scan` with independent per-IMEI outcomes; a failed entry provably leaves zero side-effects and never blocks the rest |
| `GET`  | `/api/print/queue` | 🔒 | Pending print jobs with payloads |
| `GET`  | `/api/print/job/:id` | 🔒 | Single job |
| `GET`  | `/api/print/settings` | 🔒 | Print settings (mode + whether PrintNode is configured) |
| `POST` | `/api/print/settings` | 🔒 | Update settings. Body: `{print_mode?, printnode_api_key?, printnode_printer_id_large?, printnode_printer_id_small?}` (`null` clears) |
| `GET`  | `/api/print/printnode/printers` | 🔒 | Proxy to PrintNode — list available printers for the configured account |
| `GET`  | `/api/print/label/:id?size=large\|small&token=…` | 🔒 | Standalone HTML label page (`@page size` in real mm). Auto-fires `window.print()`. Opened via `window.open()`, so it accepts the token as a `?token=` query param (see **Authentication** above) |
| `GET`  | `/api/print/labels?ids=1,2,3&size=…&token=…` | 🔒 | Bulk version with all labels separated by `page-break-after`. Same `?token=` fallback |
| `POST` | `/api/print/send/:id?size=…` | 🔒 | Dispatch one label. Returns `{mode, url}` for browser mode, `{mode, printnode_job_id}` for PrintNode |
| `POST` | `/api/print/send-all?size=…` | 🔒 | Bulk send / open one print window for all queued labels |
| `POST` | `/api/print/mark-sent/:id` | 🔒 | Mark a single job as sent (used by the browser-print window) |
| `POST` | `/api/print/mark-sent-batch` | 🔒 | Body: `{ids: [...]}`. Called by `postMessage` from the browser-print window after `afterprint` fires |

## Data Architecture

### Storage
- **Cloudflare D1** (SQLite). Local dev uses `--local` mode at `.wrangler/state/v3/d1`.

### Tables
- `organisations` — tenants. One seeded row (`Default Organisation`, id `1`).
- `users` — seeded operator/admin accounts, each tied to an `organisation_id`. No passwords yet (see **Authentication** above).
- `manifests` — supplier ASN header (reference, supplier, status open/closed). Org-scoped.
- `expected_devices` — one row per IMEI on the ASN, status `pending` → `received`. Org-scoped. Also carries **optional valuation hints** from the supplier file (`unit_cost` since 0001; `currency` + `vat_type` added in migration 0015) that pre-fill the confirm modal — hints only, never a substitute for the operator-confirmed valuation on `received_devices`.
- `received_devices` — the core inventory record: UUID, SKU, source (`manifest` | `unreconciled`), lifecycle `status` (see **Device Status Lifecycle** above), valuation (`buy_price`, `currency`, `vat_type`, `supplier_id`), and `created_by_user_id` + `organisation_id` on every row.
- `device_events` — **append-only** audit trail of every lifecycle mutation (`RECEIVE`, `STATUS_CHANGE`, `REJECT`) with `from_status`/`to_status`, `user_id`, `organisation_id`, optional `reference`/`metadata`. A device's `status` always equals its latest event's `to_status`.
- `scan_events` — pre-existing audit trail of every raw scan *attempt* (matched, duplicate, unreconciled, rejected) — kept unchanged and written alongside `device_events`, which covers the device-mutation side specifically.
- `sku_catalog` — reference catalog of clean SKUs (seeded for the Samsung models in the sample manifest).
- `print_jobs` — queued/sent label print jobs with JSON payload.
- `webhooks` — per-organisation outbound webhook config (`url`, `secret`, `enabled`).
- `suppliers` — referenced by `received_devices.supplier_id` (optional FK, no CRUD UI yet — id-only for now).

### Data flow
```
Supplier file ──► parseRows() (frontend)
              ──► POST /api/manifests          ──► expected_devices (pending)
HID scanner   ──► POST /api/scan               ──► scan_events
              ──► POST /api/scan/confirm       ──► received_devices (status=RECEIVED) + print_jobs
                                                  + device_events (RECEIVE) + expected_devices.status='received'
              ──► POST /api/scan/force-add     ──► received_devices (source='unreconciled') + device_events (RECEIVE)
Printer       ◄── POST /api/print/send/:id     ──► print_jobs.status='sent'
                                                  + received_devices.label_printed_at
Lifecycle     ──► POST /api/devices/:id/transition ──► received_devices.status + device_events (STATUS_CHANGE)
                                                       ──► outbound webhook (if configured)
```

## User Guide

### Receive a new shipment
1. Open the app, go to **Manifests** → **Upload Manifest**.
2. Drag the supplier's `.xlsx` (e.g. the provided `YH001-Saigates Limited_260608.xlsx`) into the drop zone.
3. Fill in reference + supplier (the filename pre-fills both) and **Create Manifest**.
4. App jumps to the **Receive** view with the scan input focused.
5. Start scanning. Each successful scan opens the SKU-confirm modal — most fields are pre-filled, just press **Enter** to confirm.
6. If an off-manifest IMEI is scanned the screen flashes red — either **Reject** or **Force-add** with notes.
7. As you scan, the right pane ticks devices over from pending → received, and the print queue fills with labels.
8. When done, go to **Print Queue** and click **Send all** (in production this fires the labels to your DYMO LabelWriter via PrintNode or QZ Tray).
9. Browse the finished stock in **Inventory** — no grade is set, so the devices are visible to operations but not to sales platforms.

### Keyboard
- `Esc` while in Receive → refocus the scan input.
- `Enter` inside the SKU-confirm modal → confirm and queue print.

## Production Integration Notes

### Connecting a physical DYMO LabelWriter

**Option 1 — Browser Print (default, easiest):**
1. Install the official DYMO LabelWriter driver on the workstation running the browser.
2. Plug in the DYMO LW550 / LW450 / LW4XL etc. — make sure it appears in your OS Printers panel.
3. Load the correct label stock (50×30 mm or 32×57 mm) and select the matching size in the top bar.
4. Allow pop-ups for this site so the print window can open.
5. Click `Send` — the system print dialog appears. Select the DYMO printer, set **Margins: None** and **Scale: 100%**, click Print.
6. The print window posts back to `/api/print/mark-sent-batch` automatically once `afterprint` fires.

**Option 2 — PrintNode (cloud, unattended):**
1. Create a PrintNode account at <https://www.printnode.com/>.
2. Install the PrintNode agent on the warehouse PC connected to the DYMO printer.
3. Power on the printer; confirm it appears in the PrintNode dashboard.
4. In the app go to **Settings** → switch mode to **PrintNode** → paste your API key → save.
5. Click **Load printers** and map the DYMO 50×30 and DYMO 32×57 stations to specific PrintNode printer IDs.
6. Now `Send` calls the PrintNode REST API server-side (`pdf_uri` pointing back at `/api/print/label/:id`) and the agent feeds the label to the printer with zero operator interaction.

**Option 3 — Manual / Off:** Use during testing or if you print via some external workflow. `Send` only flips the DB flag.

### Other production concerns
- **Authentication**: implemented — HS256 JWT via `hono/jwt` on every `/api/*` route except `/api/health` and `/api/auth/dev-login` (see **Authentication & Multi-Tenancy** above). `POST /api/auth/dev-login` is a dev/demo login with no password; before real production use, swap it for either Cloudflare Access in front of the Pages project, or a real credential/IdP check inside `src/routes/auth.ts` — everything downstream is unaffected either way since routes only consume the verified `c.var.user`.
- **Multi-tenant**: implemented — every domain table carries `organisation_id`, every write records it plus `user_id` from the verified token, every read is scoped with `WHERE organisation_id = ?`.
- **Token-in-URL for print windows**: the `window.open()` label pages fall back to `?token=` because a plain navigation can't send an `Authorization` header. Flagged as a known limitation — revisit (e.g. a short-lived single-use print token, or a signed-URL scheme) before hardening auth further for production.
- **PrintNode key storage**: stored server-side in the `app_settings` D1 table. The `GET /api/print/settings` endpoint only returns whether the key is configured — never the raw value.
- **Webhook secret storage**: stored server-side in the `webhooks` table, returned to the caller **once**, at creation time (`POST /api/webhooks`), never echoed back by `GET /api/webhooks` afterwards.

## Deployment
- **Platform**: Cloudflare Pages + Workers
- **Status**: ✅ Running in sandbox (port 3000 via Wrangler)
- **Tech Stack**: Hono · TypeScript · Cloudflare D1 · vanilla JS SPA · Tailwind CDN
- **Last Updated**: 2026-07-28 (OPR 6) (OPR 5 frontend UI — full OPR tab in the SPA, browser-proven by 30 Playwright checks; identifier rule tightened to strict 15-digit IMEI + Luhn / 10-character alphanumeric serial; previously OPR 1–4 API-level, JWT auth + multi-tenancy, device status lifecycle + `device_events` audit log, valuation fields, server-side authoritative validation, `/api/devices` read+CSV-export API, outbound signed webhooks)

### Local dev
```bash
npm install
npm run db:migrate:local         # create local SQLite
npm run db:seed                  # seed SKU catalog + default org/users
echo "JWT_SECRET=dev-local-insecure-secret-change-me" >> .dev.vars   # required — server 500s without it
npm run build
pm2 start ecosystem.config.cjs   # serves on http://localhost:3000
```
Then get a token: `curl -X POST http://localhost:3000/api/auth/dev-login -d '{}' -H 'Content-Type: application/json'` and use it as `Authorization: Bearer <token>` on every other `/api/*` call (the SPA does this automatically once you log in through the UI).

### Production deploy (Genspark-hosted Cloudflare — current path)
Deployed 2026-07-27 via `gsk hosted deploy` (Workers for Platform on a Genspark-managed
Cloudflare account, approval-gated). Managed resources: worker + D1
`d6aea290-bd61-4f82-aa8d-94378b9f2fec-db` (all 9 migrations applied; SKU seed loaded);
`JWT_SECRET` set as a write-only worker secret (`gsk hosted secret_put`).

**Remote-D1 caveat (fixed in `f6e69a3`):** Cloudflare's remote D1 rejects explicit
`BEGIN TRANSACTION` / `COMMIT` in migration files (error 7500) — wrangler applies each
migration file as one batch, which is D1's supported atomicity. Do not add explicit
transaction wrappers to new migrations.

Redeploy: `npm run build && gsk hosted deploy` (user approves in the UI), then re-set
secrets if the redeploy dropped bindings. D1 data ops: `gsk hosted d1_query` /
`d1_execute`.

<details><summary>Alternative: deploy to your own Cloudflare account (BYOK)</summary>

```bash
npx wrangler d1 create webapp-production         # then paste the id into wrangler.jsonc
npm run db:migrate:prod
npx wrangler pages secret put JWT_SECRET         # required — pick a strong random value, never commit it
npm run deploy
```
</details>

## Testing

**Automated suite**: [Vitest](https://vitest.dev/) via [`@cloudflare/vitest-pool-workers`](https://developers.cloudflare.com/workers/testing/vitest-integration/), which runs tests inside the real `workerd`/Miniflare runtime against a real D1 binding (all 13 migrations in `migrations/` applied before each test file — see `vitest.config.ts` and `test/apply-migrations.ts`), not mocks.

```bash
npm test              # vitest run — runs once and exits
npm run test:watch    # vitest — watch mode
```

Current coverage (211 tests across 8 suites):
- **`test/deviceLifecycle.spec.ts`** (24 tests) — `transitionDevice()`: every entry in `ALLOWED_TRANSITIONS` succeeds; a representative set of disallowed transitions (explicitly including `RECEIVED → SOLD`) reject with `InvalidTransitionError`; unknown-status and unknown-device-id error paths; org-scoping (a device in another organisation is treated as not-found, never a cross-tenant leak); each transition writes **exactly one** `device_events` row with the correct `from_status`/`to_status`/`user_id`/`organisation_id`; and — the audit-trail invariant from Priority 3 — `device.status === (most recent device_events row).to_status`, asserted automatically after single transitions, chains of transitions, and rejected-attempt no-ops, so a future refactor can't silently break it without a test failing (verified by deliberately injecting a bug that skips the status UPDATE — the invariant tests caught it immediately, then the fix was confirmed reverted byte-identical via `git diff`).
- **`test/validate.spec.ts`** (40 tests) — `isValidCurrency()`: every code in `ISO_4217_CODES` accepted; `"UKL"`, empty string, whitespace-only, and assorted junk (`"XXX"`, `"GB"`, `"GBPX"`, non-string input, etc.) all rejected. Note: the validator normalizes to uppercase *before* checking (`.trim().toUpperCase()`), so a lowercase **valid** code like `"gbp"` currently passes — this is documented and locked in as its own explicit test (not silently asserted as a rejection), while lowercase **junk** (`"ukl"`, `"xyz"`) is still correctly rejected in any case. Also covers `normalizeCurrency()`'s fallback behaviour. **IMEI/serial rule (13 tests, added 2026-07-28)**: `validateImei()` accepts a Luhn-valid strict 15-digit IMEI and rejects a broken checksum; 14-digit and 16-digit numerics are **rejected** with the targeted "strictly 15 digits" message; a 10-character alphanumeric serial is accepted and **normalised to uppercase** (`c02xk1abcd` → `C02XK1ABCD`, all-numeric `1234567890` also accepted); 9/11-character serials and punctuation/whitespace forms are rejected with targeted messages; `isValidImeiFormat()` mirrors the same rule. Verified-can-fail ×2: loosening the regex back to 14–16 digits fails exactly the two rejection tests; dropping the uppercase normalisation fails exactly the normalisation test — both reverts confirmed sha1-identical.
- **`test/forceAddValuation.spec.ts`** (21 tests) — `POST /api/scan/force-add` exercised through the **real Hono app** (`app.request()` with a signed JWT) against the real D1 binding. Proves the off-manifest exception branch enforces the same server-side valuation rules as the manifest-matched `/confirm` path: missing/empty/invalid `buy_price` → 422, missing/invalid `vat_type` → 422, invalid ISO 4217 `currency` (incl. `"UKL"`) → 422 — and every rejection is asserted to leave **zero side-effects** (no `received_devices` row, no `FORCE_ADD` event, no `scan_events` 'received' row, no print job). The happy path asserts the persisted row AND the `FORCE_ADD` `device_events` metadata both carry the exact valuation (`buy_price`/`currency`/`vat_type`, normalised). Lowercase `"gbp"` accepted-and-normalised is locked in as an explicit test, consistent with the validate suite. Verified-can-fail: the server requirement was deliberately flipped to `required: false` → 4 tests failed immediately; the revert was confirmed sha1-identical to the committed file.
- **`test/manualValuation.spec.ts`** (19 tests) — `POST /api/scan/manual` (Quick receive), the last intake branch that was still `required: false`, now enforcing the same rules: missing/empty/invalid `buy_price` → 422, missing/invalid `vat_type` → 422, invalid ISO 4217 `currency` → 422, all with zero side-effects asserted (no device row, no `MANUAL_RECEIVE` event, no scan_event, no print job); happy path asserts the row and the event metadata carry the exact normalised valuation; lowercase `"eur"` accepted-and-normalised locked in. Same verified-can-fail discipline (flipped to `required: false` → 4 immediate failures; revert sha1-identical).

**Browser-UI checks (Playwright + real Chromium)**: `test/browser/force-add-ui.browser.mjs` (22 checks) and `test/browser/manual-ui.browser.mjs` (13 checks — same pattern for the Quick receive modal: missing fields blocked with zero network requests, `UKL` server-rejected through the UI, valid values persisted exactly), all passing — see `test/browser/README.md` for how to run it and the full check list). Proves through the actual UI — not curl — that (1) the login click-through works end to end (bad email fails loudly, blank-email seeded-admin sign-in reaches the app shell, session survives reload via `/api/auth/me`, logout returns to the login screen), and (2) the force-add path for off-manifest devices cannot create a device without valid `buy_price`/`vat_type`/valid-ISO `currency`: missing fields are blocked client-side with **zero network requests** (asserted via response interception), while an invalid currency (`UKL`) typed into the UI genuinely reaches the **server** and the rendered toast carries the server's 422 ISO 4217 rejection; after all blocked attempts the inventory API confirms no row exists; the valid-values path succeeds with the exact valuation persisted. Failure-mode verified by sabotaging both the client checks and the server requirement — the checks failed immediately — then restoring from git (sha1-verified) and cleaning the leaked row from local D1.

- **`test/oprFoundation.spec.ts`** (25 tests) — OPR 1 foundation invariants through the real app: GBP-only shipment currency (`UKL` → 422 carrying the CHIEF-era explanation, `EUR` → 422, lowercase `"gbp"` normalised, empty defaults to GBP — every rejection asserted zero-side-effect on the `shipments` table); procedure codes (forbidden `2100+B51` → 422, warranty `2200+B51`/`2200+B02` accepted, `6121` import-only, direction cross-checks); declaration charset on `reference`/`consignee_name`; mandatory org-scoped authorisation linkage (missing/unknown/cross-org all 422); CDS + CHIEF numbers stored distinct; duplicate CDS → 409; **snapshot freeze** (device edited after being added to a shipment — the line's declared `unit_value`/`grade` provably do not move); devices without `buy_price` rejected with no line created; non-DRAFT shipments immutable (409). Verified-can-fail ×3: the UKL guard, the `2100+B51` guard, and the line `buy_price` guard were each deliberately disabled → the matching tests failed → reverts confirmed sha1-identical.
- **`test/oprExport.spec.ts`** (28 tests) — OPR 2 export-flow invariants through the real app: the consignment builder only accepts `READY_FOR_EXPORT` devices (a `RECEIVED` device → 409 with zero side-effects) and moves them `↔ IN_EXPORT_CONSIGNMENT` in lockstep with the line (both directions event-logged, `EXPORT_CONSIGNMENT_ADD`/`_REMOVE`); an import shipment with no linked export refuses the builder (422, zero side-effects); the generic transition endpoint refuses consignment-derived statuses in **both** directions; the validation engine's coded checks each proven individually (no-lines red, out-of-window ship date red, missing ship date amber, duplicate IMEI red, Luhn-broken IMEI red, pence-inexact and non-positive unit values red, missing logistics amber, missing commodity codes amber, fully-formed green); scan-out total equals the invoice total on the same real shipment (150 + 249.99 + 88.5 = 488.49 on **both** documents); the invoice carries the **CDS** number and provably not the CHIEF one; the pre-alert draft uses the mailbox/cut-off configured on the authorisation and flags an unconfigured mailbox instead of inventing one; **finalisation**: red blocks with zero side-effects (status/`export_mrn`/`finalised_at` all unchanged), amber passes, happy path locks the shipment, moves every device → `EXPORTED_UNDER_OPR` with `EXPORT_FINALISED` events carrying the MRN, and rejects re-finalise/scan/PATCH afterwards while `/export-proof` still lands. Verified-can-fail ×3: the red-block finalisation gate, the `READY_FOR_EXPORT` builder gate, and the totals-consistency check were each deliberately disabled → the matching tests failed → reverts confirmed sha1-identical.
- **`test/oprImport.spec.ts`** (22 tests) — OPR 3 import/discharge invariants through the real app, sitting on true preconditions (each suite runs the full OPR 2 export flow first): the **return-consignment builder** only accepts `EXPORTED_UNDER_OPR` devices that have a line on the linked export (partial returns fine; a device from a different export → 409 zero-side-effect; duplicate open-draft membership → 409); the return line **copies the frozen declared-at-export value** — proven by mutating `buy_price` to 999.99 after export and asserting the return line still reads 150; device status does **not** move while the return is DRAFT (audit via `RETURN_CONSIGNMENT_ADD`/`_REMOVE` events only); **`computeCe1154`** pure-function suite (USD 1000 @ 1.25 → £800; 2% duty → £22 without relief / £16 net / £6 relief; quantity guardrail 162≠1; CHIEF number in the authorisation field with the CDS number provably absent, CDS only in the cross-reference statement — and a missing CHIEF number **refuses** rather than substituting); `addMonths` day-clamping (2026-08-31 + 6 → 2027-02-28) and discharge-row statuses; **end-to-end**: all 10 `IMP_*` validation codes, discharge-window overrun is **amber** (blocking receipt would strand physical goods), red validation blocks receipt with zero side-effects (`import_mrn` stays null), happy-path partial return (2 of 3 back → `RETURNED_UNDER_OPR` with `IMPORT_RECEIVED` events carrying the import MRN, third device untouched), the generic transition endpoint refuses `RETURNED_UNDER_OPR` both directions, discharge row 3/2/1 with deadline export-date + 6 months, and idempotent `/restock` → `ACTIVE_INVENTORY` (second call restocks 0). Verified-can-fail ×3: the related-export membership gate, the CHIEF→CDS substitution refusal, and the receipt red-block gate were each deliberately disabled → the matching tests failed → reverts confirmed sha1-identical.

- **`test/oprAutomation.spec.ts`** (20 tests) — OPR 4 automation invariants: the **honesty gate** (`/prealert/send` and `/clearance/send` with no `GMAIL_*` secrets → 503 `gmail_not_configured` AND provably zero `sent_emails` rows — the system never pretends an email went out); with secrets present (outbound fetch stubbed at the isolate boundary) the **wire behaviour is asserted directly**: the OAuth token exchange posts the refresh-token grant, the Gmail send carries `Authorization: Bearer` + a base64url RFC 2822 message which is decoded and checked for the recipient, multipart structure and attachments; the outbox records `sent` + provider message id on success and `failed` + the provider error on a 500 (response 502) — and a token-exchange failure never even reaches the send call; `shipment.finalised` (export and import) and `shipment.restocked` **webhooks** carry an HMAC-SHA256 `X-Signature` independently recomputed over the exact delivered bytes, disabled webhooks stay silent, and a receiver that throws never fails the finalise; **bulk scan**: mixed batches get per-IMEI independent outcomes with the same status codes as single scan (404 unknown, 409 not-READY), failed entries leave zero side-effects, the 200-IMEI cap and body-shape validation hold, and import (return) bulk goes through the return gates without moving device status. Verified-can-fail ×3: the honesty gate, the HMAC (signature computed over a tampered body), and the outbox status (hardcoded 'sent') were each deliberately broken → the matching tests failed → reverts confirmed sha1-identical.

**Gmail send caveat (stated plainly)**: the send path is proven against a **stubbed** Gmail API at the wire level. Real `GMAIL_*` credentials have never been configured, so **no real email has ever been sent by this system**. First-live-send verification remains an open item for when credentials exist.

**Manual dispatch (OPR 6, interim until Gmail integration — deferred per owner instruction):** the draft modal shows copy-buttoned To/Subject/Body plus an "Open in mail app" mailto link; the operator sends from their own mail client and clicks "Mark as manually sent", which records an honest `provider=manual`/`status=manual` outbox row (cyan badge) — never confusable with a real system send. `status=sent` still exclusively means the system delivered via a provider; `/send` still refuses 503 without GMAIL_* secrets. MUCR (master UCR) is captured alongside MRN/DUCR/EAD at finalise or later via the export-proof card (migration 0014).

**Browser-UI checks — OPR (Playwright + real Chromium)**: `opr-ui.spec.mjs` (30 checks, all passing) drives the full OPR lifecycle through the real SPA: create an export consignment via the modal → scan two devices (Enter-to-scan) → a junk IMEI is rejected with the **server's** error toast and provably adds no row → validation panel → finalise with an MRN → pre-alert **send** surfaces the `gmail_not_configured` 503 honestly and the email outbox is proven to stay empty → linked import consignment → return scan → repair-invoice card (C&E1154 inputs) saved → receive → restock ("Restocked 1") — with API cross-checks that device A is back to `ACTIVE_INVENTORY` while device B (partial return) is still `EXPORTED_UNDER_OPR` — → discharge tracker row reads 2 exported / 1 returned / 1 outstanding, status open; zero page JS errors across the whole flow. Verified-can-fail: the scan error branch was replaced with a lying success toast → exactly the junk-IMEI check failed → revert sha1-identical. All test rows cleaned from local D1 afterwards.

**Manual/live verification (not yet automated)**: auth 401s and CSV export shape have been exercised via live `curl`/scripted requests against a running instance, but do not yet have Vitest coverage. (The webhook `X-Signature` HMAC and IMEI/serial validation, formerly in this list, are now covered by the OPR 4 suite and `validate.spec.ts` respectively.)

## Not Yet Implemented / Next Steps
- Automated coverage for CSV export shape (currently manual/live-verified only — see **Testing** above).
- Grading workflow (next stage after Goods In).
- QZ Tray local-WebSocket bridge (alternative to PrintNode for sites that don't want cloud printing).
- Real credential-based login / Cloudflare Access (current auth is a dev/demo email-only `dev-login` — see **Authentication** above).
- `SOLD` lifecycle transition — deliberately unwired; belongs to a downstream sales flow, not OPR.
- **Real Gmail credentials + first live send** — OPR 4's send endpoints are wire-proven against a stubbed Gmail API and refuse 503 until `GMAIL_CLIENT_ID`/`GMAIL_CLIENT_SECRET`/`GMAIL_REFRESH_TOKEN` are configured as Wrangler secrets. No real email has ever been sent; verify the first live send when credentials exist.
- Grading — explicitly out of scope.
- Multi-warehouse / multi-location.
- CSV **import** for suppliers (only export exists today — see `GET /api/devices/export/csv`).
- Real-time multi-user updates (websocket / SSE on `scan_events` / `device_events`).
- User-management UI (users/organisations are currently seeded directly in D1, no CRUD screens).
- OpenAPI spec — a machine-readable description of the API table above (see `openapi.yaml` in the project root).
