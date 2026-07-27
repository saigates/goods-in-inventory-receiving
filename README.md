# Goods In — Inventory Receiving

A modern, scanner-first web application for the **Goods In** (inbound receiving) workflow used by wholesale device traders, refurbishers, and graders.

## Project Overview
- **Name**: Goods In
- **Goal**: Turn the chaotic process of receiving a pallet of phones into a single, frictionless scan-and-print loop — from supplier ASN through to printed internal label.
- **Stack**: Hono (Cloudflare Pages) · TypeScript · Cloudflare D1 (SQLite) · Tailwind (CDN) · vanilla JS SPA · QRCode.js

## Live URL
- **Sandbox preview**: https://3000-i4zj15jax42ejggi6n8yt-b32ec7bb.sandbox.novita.ai
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
- Validates IMEIs (14–17 digits), de-duplicates, and pre-resolves a candidate SKU from the description.
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
- **Valuation & VAT** (required on confirm, optional on force-add/manual): **buy price**, **currency** (ISO 4217, default `GBP` — an unrecognised code like `UKL` is rejected with a `422`, server-side, regardless of what the UI allowed through), **VAT type** (`MARGIN` / `STANDARD` / `ZERO`), and an optional **supplier id**. The client-side checks in the confirm modal are optimistic only, to save an obviously-wasted round trip — `src/lib/validate.ts` on the server is the authoritative validator and is what actually enforces these rules.

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

`RECEIVED → SORTING → {ACTIVE_INVENTORY | IN_HOUSE_REPAIR | READY_FOR_EXPORT}`, `IN_HOUSE_REPAIR → ACTIVE_INVENTORY`, `RECEIVED → REJECTED`.

`ACTIVE_INVENTORY`, `READY_FOR_EXPORT`, `REJECTED` are currently terminal — the export/return/sale states (`IN_EXPORT_CONSIGNMENT`, `EXPORTED_UNDER_OPR`, `RETURNED_UNDER_OPR`, `SOLD`) exist in the enum for forward-compatibility with the OPR/export module but have **no transitions wired to them yet** — that workflow is explicitly out of scope for this pass. `GET /api/devices/meta/statuses` returns the full enum plus the exact allowed-transition map so a future UI/CRM never has to hardcode it.

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
| `POST` | `/api/manifests` | 🔒 | Create manifest. Body: `{reference, supplier, notes?, rows[]}` |
| `POST` | `/api/manifests/:id/close` | 🔒 | Close manifest |
| `POST` | `/api/manifests/:id/reopen` | 🔒 | Reopen manifest |
| `DELETE` | `/api/manifests/:id` | 🔒 | Delete manifest (received devices remain) |
| `POST` | `/api/scan` | 🔒 | Scan IMEI. Body: `{manifest_id, imei}`. Returns `matched` / `duplicate` / `unreconciled` / `rejected`. Server re-validates the IMEI (14-16 digits + Luhn at 15) regardless of client-side checks |
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
- `expected_devices` — one row per IMEI on the ASN, status `pending` → `received`. Org-scoped.
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
- **Last Updated**: 2026-07-27 (JWT auth + multi-tenancy, device status lifecycle + `device_events` audit log, buy price/currency/VAT/supplier valuation fields, server-side authoritative validation, `/api/devices` read+CSV-export API, outbound signed webhooks)

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

### Production deploy
```bash
npx wrangler d1 create webapp-production         # then paste the id into wrangler.jsonc
npm run db:migrate:prod
npx wrangler pages secret put JWT_SECRET         # required — pick a strong random value, never commit it
npm run deploy
```

## Testing

**Manual/live verification so far**: every behaviour described above (auth 401s, org-scoping, IMEI/Luhn validation, ISO 4217 currency rejection, `transitionDevice()` valid/invalid transitions, `device_events` invariant, CSV export shape, and the webhook `X-Signature` HMAC — independently recomputed and matched against a live payload) has been exercised via live `curl`/scripted requests against a running instance, not just read from source.

**Automated test suite: not written yet** — this is the next planned step. Priority order once started: (1) `transitionDevice()` — valid transitions succeed, invalid ones reject with `409`, the `device_events` invariant holds after each; (2) `isValidCurrency()` / `validateImei()` in `src/lib/validate.ts` — known-good and known-bad codes (e.g. `GBP` accepted, `UKL` rejected) and IMEI edge cases (14/15/16-digit, Luhn pass/fail). No test framework is wired into `package.json` yet.

## Not Yet Implemented / Next Steps
- Automated test suite (state-machine transitions, currency/IMEI validators) — see **Testing** above.
- Grading workflow (next stage after Goods In).
- QZ Tray local-WebSocket bridge (alternative to PrintNode for sites that don't want cloud printing).
- Real credential-based login / Cloudflare Access (current auth is a dev/demo email-only `dev-login` — see **Authentication** above).
- Export/return/sale lifecycle transitions (`READY_FOR_EXPORT → IN_EXPORT_CONSIGNMENT → EXPORTED_UNDER_OPR → RETURNED_UNDER_OPR`, `→ SOLD`) — the statuses exist in the enum but no transitions are wired to them yet; explicitly out of scope for this pass.
- Grading, OPR export/import documentation, C&E1154, and commercial-invoice generation — explicitly out of scope for this pass.
- Multi-warehouse / multi-location.
- CSV **import** for suppliers (only export exists today — see `GET /api/devices/export/csv`).
- Real-time multi-user updates (websocket / SSE on `scan_events` / `device_events`).
- User-management UI (users/organisations are currently seeded directly in D1, no CRUD screens).
- OpenAPI spec — a machine-readable description of the API table above (see `openapi.yaml` in the project root).
