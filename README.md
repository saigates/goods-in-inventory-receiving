# Goods In — Inventory Receiving

A modern, scanner-first web application for the **Goods In** (inbound receiving) workflow used by wholesale device traders, refurbishers, and graders.

## Project Overview
- **Name**: Goods In
- **Goal**: Turn the chaotic process of receiving a pallet of phones into a single, frictionless scan-and-print loop — from supplier ASN through to printed internal label.
- **Stack**: Hono (Cloudflare Pages) · TypeScript · Cloudflare D1 (SQLite) · Tailwind (CDN) · vanilla JS SPA · QRCode.js

## Live URL
- **Sandbox preview**: https://3000-i4zj15jax42ejggi6n8yt-b32ec7bb.sandbox.novita.ai
- **API health**: `/api/health`

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
- Force-add path generates the same SKU shape for off-manifest devices.

### D. Print Label (PrintNode / QZ Tray ready)
- On confirm, a print job is queued in the `print_jobs` table with a JSON payload.
- The label preview pops up briefly showing what was sent to the printer — a real **50×30mm Zebra-style label** with:
  - Internal **UUID** (12-char short code)
  - Clean human-readable **SKU**
  - **IMEI**
  - Brand · Model · Capacity · Grade
  - **2D QR code** encoding `{uuid, sku, imei}` (DataMatrix payload-equivalent)
- The `Print Queue` view shows every queued job, with `Send` / `Send all` buttons. In production the `/api/print/send/:id` endpoint posts the payload to PrintNode or QZ Tray — here it flips the job to `sent` and stamps `received_devices.label_printed_at`.

### E. Inventory Update
- A successful confirm writes an immutable `received_devices` row (status `received`, no grade locked-in, no listing flag).
- The IMEI is now visible in the **Inventory** view with full search (UUID/SKU/IMEI), source badge (manifest vs unreconciled), and print status — but stays out of any downstream sales flow because there's no `graded` status set yet.

## Functional Entry URIs

### Pages (UI)
| Path | Description |
|---|---|
| `/` | Single-page app (Dashboard / Manifests / Receive / Inventory / Print Queue) |

### API
| Method | Path | Description |
|---|---|---|
| `GET`  | `/api/health` | Liveness probe |
| `GET`  | `/api/inventory/stats` | Counts for dashboard tiles |
| `GET`  | `/api/manifests` | List manifests with progress |
| `GET`  | `/api/manifests/:id` | Detail with expected & unreconciled |
| `POST` | `/api/manifests` | Create manifest. Body: `{reference, supplier, notes?, rows[]}` |
| `POST` | `/api/manifests/:id/close` | Close manifest |
| `POST` | `/api/manifests/:id/reopen` | Reopen manifest |
| `DELETE` | `/api/manifests/:id` | Delete manifest (received devices remain) |
| `POST` | `/api/scan` | Scan IMEI. Body: `{manifest_id, imei}`. Returns `matched` / `duplicate` / `unreconciled` / `rejected` |
| `POST` | `/api/scan/confirm` | Confirm matched SKU. Body: `{expected_device_id, sku, brand, model, capacity, color, grade, auto_print?}` |
| `POST` | `/api/scan/force-add` | Force-add unreconciled IMEI to inventory |
| `POST` | `/api/scan/reject` | Audit-log a rejection |
| `GET`  | `/api/scan/events/:manifestId` | Recent scan events |
| `GET`  | `/api/inventory` | List received devices. Query: `q`, `source`, `manifest_id`, `limit` |
| `GET`  | `/api/print/queue` | Pending print jobs with payloads |
| `GET`  | `/api/print/job/:id` | Single job |
| `POST` | `/api/print/send/:id` | Mark single job sent |
| `POST` | `/api/print/send-all` | Flush queue |

## Data Architecture

### Storage
- **Cloudflare D1** (SQLite). Local dev uses `--local` mode at `.wrangler/state/v3/d1`.

### Tables
- `manifests` — supplier ASN header (reference, supplier, status open/closed).
- `expected_devices` — one row per IMEI on the ASN, status `pending` → `received`.
- `received_devices` — physical receive record with UUID, SKU, source (`manifest` | `unreconciled`).
- `sku_catalog` — reference catalog of clean SKUs (seeded for the Samsung models in the sample manifest).
- `print_jobs` — queued/sent label print jobs with JSON payload.
- `scan_events` — full audit trail of every scan attempt (matched, duplicate, unreconciled, rejected).

### Data flow
```
Supplier file ──► parseRows() (frontend)
              ──► POST /api/manifests          ──► expected_devices (pending)
HID scanner   ──► POST /api/scan               ──► scan_events
              ──► POST /api/scan/confirm       ──► received_devices + print_jobs
                                                  + expected_devices.status='received'
              ──► POST /api/scan/force-add     ──► received_devices (source='unreconciled')
Printer       ◄── POST /api/print/send/:id     ──► print_jobs.status='sent'
                                                  + received_devices.label_printed_at
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
8. When done, go to **Print Queue** and click **Send all** (in production this fires the labels to your warehouse Zebra/Brother printer via PrintNode or QZ Tray).
9. Browse the finished stock in **Inventory** — no grade is set, so the devices are visible to operations but not to sales platforms.

### Keyboard
- `Esc` while in Receive → refocus the scan input.
- `Enter` inside the SKU-confirm modal → confirm and queue print.

## Production Integration Notes
- **Cloud printing**: swap the `app.post('/send/:id')` body for a `fetch()` to your PrintNode API (header `Authorization: Basic …`) or a WebSocket call to QZ Tray. The payload schema is already in `print_jobs.payload_json`.
- **Authentication**: not implemented — add Cloudflare Access in front of the Pages project, or Hono's `jwt` middleware on `/api/*` for app-level auth.
- **Multi-tenant**: add `organisation_id` foreign keys to every table and a Hono middleware that sets it from the JWT.

## Deployment
- **Platform**: Cloudflare Pages + Workers
- **Status**: ✅ Running in sandbox (port 3000 via Wrangler)
- **Tech Stack**: Hono · TypeScript · Cloudflare D1 · vanilla JS SPA · Tailwind CDN
- **Last Updated**: 2026-06-12

### Local dev
```bash
npm install
npm run db:migrate:local         # create local SQLite
npm run db:seed                  # seed SKU catalog
npm run build
pm2 start ecosystem.config.cjs   # serves on http://localhost:3000
```

### Production deploy
```bash
npx wrangler d1 create webapp-production         # then paste the id into wrangler.jsonc
npm run db:migrate:prod
npm run deploy
```

## Not Yet Implemented / Next Steps
- Grading workflow (next stage after Goods In).
- Live PrintNode / QZ Tray wire-up (currently the print endpoint just flips the DB flag).
- User accounts + per-operator scan attribution.
- Multi-warehouse / multi-location.
- Webhook out to ERP / accounting on receive.
- Export buttons (CSV) for received batches.
- Real-time multi-user updates (websocket / SSE on `scan_events`).
