# Goods In — Inventory Receiving & OPR Customs Platform

A scanner-first web application for wholesale device traders and refurbishers, covering inbound receiving (Goods In), the full device lifecycle (sorting → repair → export → sale), and HMRC Outward Processing Relief (OPR) customs documentation for devices sent abroad for repair and returned.

## Project Overview
- **Name**: Goods In
- **Goal**: one frictionless scan-and-print loop for receiving stock, plus the full downstream lifecycle — repair, OPR export/return customs paperwork, cost accounting, and sale reconciliation against Zoho.
- **Stack**: Hono (Cloudflare Workers) · TypeScript · Cloudflare D1 (SQLite) · Tailwind (CDN) · vanilla JS SPA · QRCode.js (`qrious`)
- **Current state**: production deployed at commit `3eed023` (2026-10-05). Gate baseline: **808 passed / 8 skipped / 0 failed across 38 files** (`npx vitest run`).

## Live URLs
- **Production (Genspark-hosted Cloudflare)**: https://d6aea290-bd61-4f82-aa8d-94378b9f2fec.vip.gensparksite.com
- **API health**: `GET /api/health` (unauthenticated — the only fully open route besides login and the dev-login tombstone)

## Authentication & Multi-Tenancy
Every route under `/api/*` requires a valid JWT **except** `GET /api/health`, `POST /api/auth/login`, and `POST /api/auth/dev-login` (exempt only so its **410 Gone** tombstone is visible rather than masked as a 401 — it can never mint a token).

- **Login**: `POST /api/auth/login` with `{email, password}` → `{token, user}`. Two real per-person accounts under **Saigates Limited** (org id 1): `owner@saigates.com` (admin) and `ops@saigates.com` (operator) — genuinely separate credentials, independent audit trails. Unknown email and wrong password return the identical `401` (no user enumeration).
- **Password storage**: PBKDF2-SHA256 via WebCrypto (100,000 iterations, 16-byte salt), stored as `pbkdf2$<iters>$<salt-hex>$<hash-hex>`. Plaintext is never stored anywhere.
- **Roles**: `operator` / `manager` / `admin`. A growing set of routes are **manager-gated** (`requireManager()` — role is `manager` or `admin`): cost-ledger writes, SKU-map edits, inventory valuation reports, repair-control overrides. Any new manager-gated action must filter its own UI affordance by role in the same commit that creates it.
- **Token**: HS256 JWT (`hono/jwt`), 12h TTL, signed with `JWT_SECRET` (`.dev.vars` locally, `gsk hosted secret_put` in production). Claims: `sub`, `email`, `name`, `role`, `org_id`.
- **Token-in-URL for print/doc pages**: `window.open()`'d pages (labels, some document views) can't carry a header, so they fall back to a `?token=` query param — `extractToken()` checks the header first. `POST /api/auth/doc-token` mints a short-lived token for this purpose. Known limitation, flagged for hardening: URL tokens can leak into logs/history.
- **Multi-tenancy**: every domain table carries `organisation_id`; every write records `user_id` + `organisation_id`; every read is scoped `WHERE organisation_id = ?`. One seeded org: Saigates Limited, id `1`.

## Device Status Lifecycle

`received_devices.status` is a 14-value enum (`src/types.ts` `DEVICE_STATUSES`), enforced end-to-end by a single choke point, `transitionDevice()` (`src/lib/deviceLifecycle.ts`):

| Status | Notes |
|---|---|
| `RECEIVED` | Default on goods-in |
| `SORTING` | |
| `ACTIVE_INVENTORY` | Sellable stock |
| `IN_HOUSE_REPAIR` | Repair-workflow-only (see below) |
| `READY_FOR_EXPORT` | Precursor to OPR/temp-export consignments |
| `IN_EXPORT_CONSIGNMENT` | OPR-workflow-only — shared precursor for OPR export AND temp-standard export |
| `EXPORTED_UNDER_OPR` | OPR-workflow-only |
| `RETURNED_UNDER_OPR` | OPR-workflow-only |
| `TEMP_EXPORTED_STANDARD` | OPR-workflow-only — non-customs temporary export |
| `RETURNED_UNDER_STANDARD` | OPR-workflow-only |
| `SOLD` | Reachable from RECEIVED/SORTING/ACTIVE_INVENTORY/IN_HOUSE_REPAIR/READY_FOR_EXPORT/QC_FAILED/READY_FOR_ZOHO via `applyZohoSaleImport`; terminal — no outbound edge |
| `REJECTED` | Only outbound edge is back to `RECEIVED` (mandatory reason code either direction) |
| `QC_FAILED` | Repair-workflow-only |
| `READY_FOR_ZOHO` | Repair-workflow-only — gate before a device can join a (manual, not-yet-automated) Zoho batch |

**Workflow-only guards** — the generic `POST /api/devices/:id/transition` route refuses to move a device into *or* out of these statuses (409); only the dedicated routes may drive them, keeping shipment_lines / repair_jobs in lockstep with the device ledger:
- `OPR_WORKFLOW_ONLY_STATUSES`: `IN_EXPORT_CONSIGNMENT`, `EXPORTED_UNDER_OPR`, `RETURNED_UNDER_OPR`, `TEMP_EXPORTED_STANDARD`, `RETURNED_UNDER_STANDARD` — only `src/routes/opr.ts`'s `/shipments/:id/{lines,scan,finalise,restock}` endpoints may drive these.
- `REPAIR_WORKFLOW_ONLY_STATUSES`: `IN_HOUSE_REPAIR`, `QC_FAILED`, `READY_FOR_ZOHO` — only `src/routes/devices.ts`'s `/repair/*` endpoints may drive these.

Every status change writes an atomic D1 `batch()` of the `received_devices` UPDATE + a `device_events` append-only audit row — a device's `status` always equals the `to_status` of its own most recent event. `GET /api/devices/meta/statuses` returns the full enum + allowed-transition map so a future UI/CRM never hardcodes it.

## OPR (Outward Processing Relief) & Customs Domain

Full HMRC customs lifecycle for devices sent abroad for repair under OPR, or temporarily exported for non-customs reasons, and returned:

- **Authorisations** (`opr_authorisations`) — the holder's OPR Authorisation Number, EORI, CDS number, supervising office, commodity scope, rate of yield, discharge period, and carrier pre-alert mailbox/cutoff. The Saigates record is seeded data, not hardcoded.
- **Shipments** (`shipments` / `shipment_lines`) — a consignment entity above individual devices. `direction` (`export`|`import`), `status` (`DRAFT`|`FINALISED`|`CANCELLED`), procedure codes (`2100`/`2200` export, `6121` import; `2100+B51` forbidden; `B51`/`B02` pair with `2200`), GBP-only currency, mandatory authorisation linkage.
- **Lines are frozen snapshots**: adding a device to a DRAFT shipment snapshots its IMEI/SKU/attributes/`buy_price` at that moment — later device edits never leak into the declared customs line.
- **Validation engine**: `GET /shipments/:id/validation` — ~10 coded green/amber/red checks (currency, authorisation validity on ship date, procedure codes, commodity scope, IMEI Luhn/uniqueness, declaration text, unit values pence-exact, totals consistency, logistics, discharge-window for imports). Red blocks finalisation with zero side-effects.
- **Finalisation**: `POST /shipments/:id/finalise` — direction-aware (same endpoint drives both export-finalise and import-receipt). Export: every line's device → `EXPORTED_UNDER_OPR` (or `TEMP_EXPORTED_STANDARD`), captures `export_mrn`/`ducr`/`ead_mrn`. Import: devices → `RETURNED_UNDER_OPR`, captures `import_mrn`. `POST /shipments/:id/finalise/resume` recovers a partially-applied finalise.
- **Return-completeness**: partial returns are supported — only devices actually returned move status; the rest stay `EXPORTED_UNDER_OPR`/`TEMP_EXPORTED_STANDARD` until a later return consignment picks them up. `GET /discharge` is the tracker (exported vs returned vs outstanding, deadline = export date + authorisation discharge period, status open/closing/overdue).
- **C&E1154 duty-relief form**: `GET /shipments/:id/ce1154` — quantity from the consignment, repair cost → GBP at the customs rate, exported-goods value = frozen declared-at-export value of the *returning* devices only, relief = duty on (goods+repair) minus duty on repair. Uses the OPR Authorisation Number field; the CDS number appears only in the cross-reference statement.
- **Correspondence & honesty gates**: pre-alert and clearance-instruction drafts are built server-side; *actually sending* (`/prealert/send`, `/clearance/send`) goes via the Gmail REST API and refuses `503 gmail_not_configured` (writing nothing) unless all three `GMAIL_*` secrets are set — no real email has ever been sent by this system (stubbed-wire-level tested only). A manual-send path (`/prealert/mark-sent`, `/clearance/mark-sent`) records an honest `provider=manual` outbox row for operators who send from their own mail client. `sent_emails` is the outbox of record.
- **Value corrections & misdeclaration**: `POST /shipments/:id/lines/:lineId/correction` + a manager-review step record post-finalisation corrections to a declared line without rewriting the frozen original; `POST /shipments/:id/reconcile-value` + `GET /value-deltas` track goods-value reconciliation deltas; `POST /shipments/:id/misdeclaration-ack` is the manager-acknowledged path for a known-wrong declared value that isn't being corrected.
- **Bulk builders**: `POST /shipments/:id/scan-bulk` and `/bulk-serials` add many devices in one call with independent per-device outcomes — a failed entry leaves zero side-effects and never blocks the rest. (See **Testing** below — this endpoint's sequential-per-device write is the subject of a standing gate-reliability note, Z-20.)

Full endpoint table below under **Functional Entry URIs**.

## Cost Model

**Acquisition cost** (`src/lib/acquisitionCost.ts`, `computeAcquisitionCostGbp()`): for a given device, prefers the sum of any `cost_ledger` rows with `cost_type='purchase'` for that device; falls back to `received_devices.buy_price` (the goods-in valuation) **only when the ledger has zero purchase rows for that device**. Returns `{acquisition_cost_gbp, acquisition_source}` where `acquisition_source` is `'cost_ledger' | 'goods_in_buy_price' | 'none'` — `'none'` means genuinely no cost basis exists yet (not zero). This is a **computed read, not a stored column and not a new ledger writer** — deliberately, to avoid double-counting against the existing bill-close and manual cost-entry writers.

`computeDeviceCostBreakdown()` extends this with `repair_cost_gbp` + `freight_cost_gbp` (summed from `cost_ledger`) and a `total_cost_gbp` (acquisition, treating `null` as 0 for this sum only, plus repair plus freight). See `docs/plan/z2-acquisition-cost.md` for the full design decision.

**Inventory valuation** (`GET /api/reports/inventory-valuation`, manager-gated): totals owned stock using an explicit **inclusion list** (`VALUATION_INCLUDED_STATUSES` in `src/routes/reports.ts`), not an exclusion list — written this way deliberately so a 15th future status forces whoever adds it to decide where it belongs rather than silently joining or leaving the total. Currently includes every status except `SOLD` (the sole true exclusion — once sold it's no longer owned stock) and `REJECTED` (reported on its own separate line, since it can still be corrected back to `RECEIVED`).

**Bills** (`src/routes/bills.ts`, `src/lib/billBuilder.ts`): purchase and repair bills share one builder. Closing a bill writes `cost_ledger` rows (`write-cost-ledger`); `force-close` and `repair-control` are manager-gated overrides for edge cases (e.g. a bill that needs closing before every manifest line reconciles).

## SKU Map & Zoho CSV Round-Trip

`src/routes/skuMap.ts` maps this system's internal SKUs (`sku_catalog`) to Zoho's item IDs — the first legitimate write surface in production outside the core scan/lifecycle/bill flows, gated to manager/admin.

- `GET /api/sku-map` — list/search the mapping table.
- `GET /api/sku-map/unmapped` + `/unmapped/export` (CSV) — devices whose SKU has no Zoho mapping yet, scoped to `SKU_MAP_RELEVANT_STATUSES` (statuses where a device might still need a future Zoho bill line — excludes anything already `SOLD`, `REJECTED`, or already committed to an OPR/temp-export consignment, since those will never generate a Zoho bill line).
- `GET /api/sku-map/orphans` — Zoho item IDs with no matching internal SKU.
- `POST /api/sku-map/import` — CSV round-trip import (`src/lib/skuMapImport.ts`): parses, validates, and applies a bulk mapping update.
- `GET /api/sku-map/version` — a change-token for cache/sync purposes.

**Zoho sale import** (`src/lib/zohoSaleImport.ts`, mounted at `/api/zoho-sale-import` as of 2026-09-11, Quick Item B): applies a Zoho sale-export CSV against the device ledger via `applyZohoSaleImport()`. Matches a sold Zoho line to a device and drives it to `SOLD` via a direct `transitionDevice()` call (reachable from RECEIVED/SORTING/ACTIVE_INVENTORY/IN_HOUSE_REPAIR/READY_FOR_EXPORT/QC_FAILED/READY_FOR_ZOHO — deliberately wide, since Zoho is the authoritative external record of the sale *fact* and can legitimately record a sale before this app's own internal tracking has caught up). A device already in an OPR/temp-export consignment status, or already `REJECTED`, surfaces as a named conflict rather than a silent status write or a thrown error. Money columns (`sold_price_pence`) are integer pence, never float, per the project's money-column convention.

## Functional Entry URIs

### Pages (UI)
| Path | Description |
|---|---|
| `/` | Single-page app — all views (Dashboard / Manifests / Receive / Inventory / OPR / Print Queue / Settings) render client-side from `/static/app.js` |

### API — mounted route groups
All under `/api/*`, requiring `Authorization: Bearer <token>` except where marked 🔓. All scoped to the caller's `organisation_id`. 🔒🔒 marks manager/admin-only routes.

| Mount | File | Auth | Purpose |
|---|---|---|---|
| `/api/auth` | `routes/auth.ts` | mixed | `POST /login` 🔓, `POST /dev-login` 🔓 (410 tombstone), `POST /change-password`, `POST /doc-token` (mints a short-lived token for `?token=`-fallback pages), `GET /me` |
| `/api/manifests` | `routes/manifests.ts` | 🔒 | ASN upload/list/detail/close/reopen/delete, `POST /:id/apply-sku-to-batch` (bulk SKU correction across a manifest's lines) |
| `/api/scan` | `routes/scan.ts` | 🔒 | `POST /` (scan), `/confirm`, `/bulk`, `/force-add`, `/manual`, `/reject`, `GET /events/:manifestId` |
| `/api/inventory` | `routes/inventory.ts` | 🔒 | List/delete, `POST /grade` (bulk grade override), `/sku-grade-consistency`, `/removal-flags` + `/removal-flags/:id/resolve`, `/grade-audit/:id`, `/stats` |
| `/api/print` | `routes/print.ts` | 🔒 | Queue/job/settings, `GET /label/:id` + `/labels` (standalone print pages, `?token=` fallback), `POST /send/:id`, `/send-all`, `/mark-sent*`, `GET /printnode/printers` |
| `/api/catalog` | `routes/catalog.ts` | 🔒 | `GET /`, `POST /upload` (bulk catalog CSV), `POST /lookup`, `POST /` (add SKU, self-heals missing grade-variant rows), `DELETE /:id` |
| `/api/devices` | `routes/devices.ts` | 🔒 | `GET /` (filtered/paginated), `/:id`, `/repair-queue`, `/export/csv`, `/meta/statuses`; `PATCH /:id/correct` (SKU correction with optional manifest-line cascade); `POST /bulk-transition`, `/:id/transition`; `POST /:id/repair/{start,scan-back,qc,reopen,close-to-inventory,cost,cost-ledger}` 🔒🔒 for cost routes; `POST /:id/purchase/cost-ledger` 🔒🔒 |
| `/api/webhooks` | `routes/webhooks.ts` | 🔒 | List/create/toggle/delete outbound webhook configs. Signed `X-Signature: sha256=<hmac>` on every delivery; fires after every successful device transition |
| `/api/opr` | `routes/opr.ts` | 🔒 | 44 endpoints — see **OPR & Customs Domain** above. Authorisations, shipments (create/list/detail/edit), lines/scan (add/remove devices), validation, invoice, scan-out, prealert/clearance drafts + send + mark-sent, finalise + resume, export-proof/import-proof, restock, discharge, correspondence/replies/follow-up/checklist, value corrections + misdeclaration acks, ce1154, bulk builders |
| `/api/bills` | `routes/bills.ts` | 🔒 | `GET /`, `/:id`, `POST /` (create), `/:id/close`, `/:id/force-close` 🔒🔒, `/:id/write-cost-ledger`, `/:id/repair-control` 🔒🔒 |
| `/api/reports` | `routes/reports.ts` | 🔒🔒 | `GET /inventory-valuation` — see **Cost Model** above |
| `/api/sku-map` | `routes/skuMap.ts` | 🔒🔒 | See **SKU Map & Zoho CSV Round-Trip** above |
| `/api/zoho-sale-import` | `routes/zohoSaleImport.ts` | — | **NOT mounted in `src/index.tsx`** — imported but deliberately unmounted (its own request-level validation is not yet rebuilt; do not re-mount without separate authorisation). The underlying library (`applyZohoSaleImport()`) is built, tested, and used elsewhere. |

`webhooks.ts` is correctly excluded from any "mounted routes sweep" since it has no distinct mount prefix issue — it's listed here for completeness.

## Data Architecture

### Storage
**Cloudflare D1** (SQLite). Local dev uses `--local` mode at `.wrangler/state/v3/d1`. 41 migrations in `migrations/` (`0001`–`0040`); one file, `migrations-held/0030_expected_devices_condition_derived_from_grade.sql`, remains deliberately held pending renumbering (see `migrations-held/README.md`) — it is NOT one of the 41 applied.

### Key tables (not exhaustive — see `migrations/*.sql` for full DDL)
- `organisations`, `users` — tenancy + credentialed accounts.
- `manifests`, `expected_devices` — supplier ASN header + per-IMEI lines (with optional valuation hints: `unit_cost`/`currency`/`vat_type`).
- `received_devices` — the core inventory record: UUID, SKU, lifecycle `status` (14-value enum), valuation (`buy_price`/`currency`/`vat_type`/`supplier_id`), sale attribution columns (`sold_invoice_no`, `sold_date`, `sold_channel`, `sold_price_pence`, `attribution`, `vat_treatment`, `sold_shipment_id`), `received_at`.
- `device_events` — append-only audit trail of every lifecycle mutation.
- `scan_events` — raw scan-attempt log (matched/duplicate/unreconciled/rejected), separate from `device_events`.
- `sku_catalog` — reference catalog, one row per `(model, capacity, color, grade)`. Self-heals missing grade-variant rows on ordinary receiving (see `POST /api/catalog`'s Decision 2).
- `cost_ledger` — `purchase`/`repair`/`freight` cost rows per device; the basis for `acquisitionCost.ts`'s computed reads.
- `shipments`, `shipment_lines` — OPR/temp-export consignments and their frozen device-line snapshots.
- `opr_authorisations` — OPR Authorisation Number, EORI, CDS number, discharge period, pre-alert config.
- `sent_emails` — outbox of every prealert/clearance send attempt (real or manual).
- `sku_map` / `zoho_items` — internal-SKU ↔ Zoho-item-ID mapping.
- `removal_flags` — written when a downgrade-to-UG regrade happens on `ACTIVE_INVENTORY` stock.
- `print_jobs`, `webhooks`, `suppliers`, `repair_jobs`.

### Data flow (high level)
```
Supplier file ─► POST /api/manifests          ─► expected_devices (pending)
HID scanner   ─► POST /api/scan               ─► scan_events
              ─► POST /api/scan/confirm       ─► received_devices (RECEIVED) + device_events + print_jobs
Lifecycle     ─► POST /api/devices/:id/transition  OR  /repair/*  OR  opr.ts's /shipments/:id/{lines,scan,finalise,restock}
                   ─► received_devices.status + device_events  ─► outbound webhook (if configured)
Cost          ─► bills.ts close / manual cost-entry  ─► cost_ledger  ─► acquisitionCost.ts reads (computed, not stored)
Sale          ─► Zoho export CSV ─► applyZohoSaleImport() ─► received_devices.sold_* + status→SOLD
```

## Migration & Deploy Process

**Migrations**: `migrations/0001`–`0040` (41 files), applied in order by `gsk hosted deploy` itself — there is no separate migrate subcommand for this project category; one deploy action applies every not-yet-recorded migration file as a batch (D1's HTTP API has no atomic multi-statement DDL across files — each runs as an independent auto-commit statement, so a partial-apply is visible via the deploy result's `statement_index`/`remaining_statements` fields, not silently swallowed). `migrations-held/0030_...sql` stays physically outside `migrations/` until it's renumbered ahead of whatever now sits past it.

**Deploy path (current)**: Genspark-hosted Cloudflare via `gsk hosted deploy` (Workers for Platform, approval-gated — every deploy/rebuild/worker-delete action requires the operator's own typed confirmation naming the specific pending-action ID, never self-approved). The deploying session's own checked-out commit + its own fresh build are what ships — there is no server-side git-ref resolution for this project category.

```bash
# Local dev
npm install
npm run db:migrate:local
npm run db:seed
echo "JWT_SECRET=dev-local-insecure-secret-change-me" >> .dev.vars
npm run build
pm2 start ecosystem.config.cjs   # http://localhost:3000

# Production redeploy
npm run build && gsk hosted deploy   # user approves the named pending-action ID in the UI
```

**Post-deploy smoke checks** (standing convention): `git diff <deployed-commit> -- src/index.tsx` must be empty (confirms the working tree at submission time matched the intended commit with nothing uncommitted), and the deployed `/static/app.js`'s SHA-256 must match the local repo's copy at that commit.

<details><summary>Alternative: deploy to your own Cloudflare account (BYOK)</summary>

```bash
npx wrangler d1 create webapp-production
npm run db:migrate:prod
npx wrangler pages secret put JWT_SECRET
npm run deploy
```
</details>

## Testing

**Automated suite**: [Vitest](https://vitest.dev/) via `@cloudflare/vitest-pool-workers` — runs inside real `workerd`/Miniflare against a real D1 binding with all 41 migrations applied, not mocks.

```bash
npm test              # vitest run — runs once and exits
npm run test:watch    # watch mode
```

**Current baseline (2026-10-05): 808 passed / 8 skipped / 0 failed across 38 test files.** This baseline was only reached after discovering the gate itself is non-deterministic under load (see **Z-20** below) — two per-test timeout fixes (shared, named constants in `test/testTimeouts.ts`: `SEQUENTIAL_BATCH_WRITE_TIMEOUT_MS = 60000`, `PASSWORD_HASH_CHAIN_TIMEOUT_MS = 15000`) were required before two consecutive full-suite runs came back clean. The global vitest default (5000ms) is deliberately left untouched so a genuine future performance regression still surfaces — only specific, named, commented call sites get an override.

The 8 skipped tests are `test/repairWorkflow.spec.ts`'s Group D (`#30–36`, Zoho batch generation/confirmation) — `describe.skip`ped with the reason stated in the skip label itself: Zoho batch upload was never built, parked by explicit owner decision (stock currently goes into Zoho by hand).

Suite-level notes:
- `test/oprImport.spec.ts` is excluded from the main parallel config and run separately via `vitest.serial.config.ts` — a 324-sequential-round-trip test twice timed out at 60s under full-suite parallel contention while passing in isolation; documented in-file as a shared-runner capacity problem, not a flaky test.
- Each OPR/lifecycle/valuation suite follows a "verified-can-fail" discipline: a guard is deliberately disabled, the matching test is confirmed to fail, then the revert is confirmed byte-identical via git diff — so a passing suite is evidence the guard actually works, not just that the test exists.

For the full per-suite breakdown (what each of the 38 files actually covers), read each file's own header comment — they're kept current as the authoritative description; this README does not duplicate them.

## Active Workstreams / Standing Tickets (`docs/plan/`)

| File | Status |
|---|---|
| `z2-acquisition-cost.md` | **Implemented and merged.** Acquisition/total cost computation design — see **Cost Model** above. |
| `device-lifecycle-slice1.md` | Repair workflow + Zoho upload-queue gate design. Group C (start/scan-back/QC/reopen/cost) is built and green; Group D (batch upload) is parked. |
| `zoho-replacement-roadmap.md` | **Scope/documentation only, not authorised for implementation.** Staged plan to eventually replace Zoho as the accounting book of record. |
| `v6-amazon-cost-feed.md` | **Scoped, not built.** Sprint 2 item (opens 9 Oct), unblocked by Z-5. Amazon read-only cost feed — exclusion filter must key off `OPR_WORKFLOW_ONLY_STATUSES` directly, never the display-only `deviceLocation()` helper. |
| `z15-return-completeness-gate.md` | **Scoping only.** Finalisation-block design for partial-return completeness. |
| `z16-convention-drift.md` | **Standing tracking note**, not a ticket — recurring failure mode where a comment/test/log states a fact that goes stale unnoticed. Currently at thirteen logged instances. |
| `z20-gate-reliability.md` | **Scoping only**, Sprint 2. Opened after three consecutive full-suite runs in one pass produced three different results — standing response is an inventory of every test within a margin of its timeout (report first, decide fixes after), plus a folded-in production-latency check on OPR's sequential bulk-write endpoint against the Worker's real CPU-time budget. |

## Not Yet Implemented / Next Steps
- ⚠️ **KNOWN RISK, LIVE TODAY — CSV formula injection in `GET /api/devices/export/csv`.** Any device field value beginning `=`, `+`, `-` or `@` is a live formula the moment the exported CSV is opened in Excel/Sheets. Not yet mitigated because the usual fix (prefixing a quote) would mutate an HMRC audit artefact. Planned fix: a typed `.xlsx` export. Until then, treat every exported CSV as untrusted — open with formulas disabled or force all columns to Text.
- **Real Gmail credentials + first live send** — OPR correspondence send endpoints are wire-proven against a stubbed Gmail API only; no real email has ever been sent.
- Grading workflow beyond the current A+–D/UG scale — explicitly out of scope.
- Multi-warehouse / multi-location.
- CSV **import** for suppliers beyond the manifest-upload path (only export + manifest-upload exist today).
- Real-time multi-user updates (websocket/SSE on scan/device events).
- User-management UI — users/organisations are seeded directly in D1, no CRUD screens.
- OpenAPI spec — `openapi.yaml` exists in the project root as a starting point but is not kept in lockstep with the live route table above; treat this README's route table as the more current source until that's resolved.
- External IdP/SSO, self-signup, email verification, email-based password reset, multi-org — all deliberate non-goals for the current two-person internal use case.
- `v6-amazon-cost-feed.md`, `z15-return-completeness-gate.md`, `z20-gate-reliability.md` — all scoped, none built. See table above.
