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
- **Grade options**: `A+`, `A`, `B+`, `B`, `C+`, `C`, `D`, and **`UG`** (Ungraded / Untested — for devices arriving without a supplier grade or routed straight to QC). `UG` shows up as a violet badge throughout the UI to make ungraded stock easy to spot.
- Force-add path generates the same SKU shape for off-manifest devices.

### D. Print Label — connects to a real DYMO LabelWriter
- On confirm, a print job is queued in the `print_jobs` table with a JSON payload.
- **Two label formats supported** (toggle in the top bar — preference persists per browser via `localStorage`):
  - **DYMO 50×30mm** (landscape) — large-format label for the warehouse floor.
  - **DYMO 32×57mm** (portrait) — compact label for the receiving desk.
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
| `DELETE` | `/api/inventory/:id` | Delete a received device. Restores its manifest line to `pending`, removes queued labels |
| `GET`  | `/api/print/queue` | Pending print jobs with payloads |
| `GET`  | `/api/print/job/:id` | Single job |
| `GET`  | `/api/print/settings` | Print settings (mode + whether PrintNode is configured) |
| `POST` | `/api/print/settings` | Update settings. Body: `{print_mode?, printnode_api_key?, printnode_printer_id_large?, printnode_printer_id_small?}` (`null` clears) |
| `GET`  | `/api/print/printnode/printers` | Proxy to PrintNode — list available printers for the configured account |
| `GET`  | `/api/print/label/:id?size=large\|small` | Standalone HTML label page (`@page size` in real mm). Auto-fires `window.print()`. |
| `GET`  | `/api/print/labels?ids=1,2,3&size=…` | Bulk version with all labels separated by `page-break-after` |
| `POST` | `/api/print/send/:id?size=…` | Dispatch one label. Returns `{mode, url}` for browser mode, `{mode, printnode_job_id}` for PrintNode |
| `POST` | `/api/print/send-all?size=…` | Bulk send / open one print window for all queued labels |
| `POST` | `/api/print/mark-sent/:id` | Mark a single job as sent (used by the browser-print window) |
| `POST` | `/api/print/mark-sent-batch` | Body: `{ids: [...]}`. Called by `postMessage` from the browser-print window after `afterprint` fires |

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
- **Authentication**: not implemented — add Cloudflare Access in front of the Pages project, or Hono's `jwt` middleware on `/api/*` for app-level auth.
- **Multi-tenant**: add `organisation_id` foreign keys to every table and a Hono middleware that sets it from the JWT.
- **PrintNode key storage**: stored server-side in the `app_settings` D1 table. The `GET /api/print/settings` endpoint only returns whether the key is configured — never the raw value.

## Deployment
- **Platform**: Cloudflare Pages + Workers
- **Status**: ✅ Running in sandbox (port 3000 via Wrangler)
- **Tech Stack**: Hono · TypeScript · Cloudflare D1 · vanilla JS SPA · Tailwind CDN
- **Last Updated**: 2026-06-12 (Real DYMO printer support: Browser Print + PrintNode + Manual modes, Settings view, switched QR library to `qrious@4.0.2`)

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
- QZ Tray local-WebSocket bridge (alternative to PrintNode for sites that don't want cloud printing).
- User accounts + per-operator scan attribution.
- Multi-warehouse / multi-location.
- Webhook out to ERP / accounting on receive.
- Export buttons (CSV) for received batches.
- Real-time multi-user updates (websocket / SSE on `scan_events`).
