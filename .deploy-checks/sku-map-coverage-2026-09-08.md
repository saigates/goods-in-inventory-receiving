# sku_map coverage check (2026-09-08) — unmapped goods-in SKUs, real data not fixtures

## Why this entry exists

The user asked: is any SKU carried by a stocked goods-in device absent from
`sku_map`? Retiring the file-diff question (no prior `Z-G-MAPPING.csv`
exists, per the earlier README correction) doesn't retire this — it's a
coverage check against the *loaded mapping*, not a file-history diff, and
it doesn't depend on file history existing.

**This required exercising the real `applySkuMapImport()` against real
data, not vitest's isolated in-memory fixture DB** — `0032_zoho_sku_mapping.sql`
had never actually been applied anywhere outside `vitest-pool-workers`'
per-test D1 instance:
- Confirmed absent from production: `gsk hosted d1_query -q "SELECT ... FROM sku_map"`
  → `no such table: sku_map` (production has 32/32 migrations through
  `0031`; `0032` was written this session but never deployed).
- Confirmed absent from local persisted D1 too: `npx wrangler d1 migrations
  list webapp-production --local` showed `0032_zoho_sku_mapping.sql` as
  still pending. Applied it (`npx wrangler d1 migrations apply
  webapp-production --local`) — read-write, but to LOCAL dev D1 only, not
  production, and not a fixture-account action.
- Local D1's `received_devices` was empty (0 rows) — it's a dev-only
  database, never seeded with real goods-in data. All real goods-in data
  lives in production only.

**Method**: read production's real distinct goods-in SKU set (read-only,
`gsk hosted d1_query`, bracketed by clean `gsk login-info` before/after,
paginated 3×100-row calls since the tool caps at `limit=100`) → 201
distinct SKUs, `organisation_id=1` only (confirmed `COUNT(DISTINCT
organisation_id)=1`, so no cross-org concern). Then loaded the real
`/home/user/uploaded_files/Z-G-MAPPING.csv` into LOCAL D1 via a one-off
script that imports `applySkuMapImport` from `src/lib/skuMapImport.ts`
directly (via `wrangler`'s `getPlatformProxy`, real binding backed by
`.wrangler/state/v3/d1`, NOT the vitest pool) — the actual production
code path, not a re-implementation. Import succeeded, 747 rows written
(matches the already-known 747 baseline). Left-joined the 201 production
SKUs against the 747 loaded `sku_map` rows (`org_id=1`, non-orphaned).
Throwaway script deleted after use; local D1's `sku_map` table is left
populated with this real import's result (this is not test pollution —
it's the same write a future `/imports` page's first real import would
produce).

## Result: 95 of 201 goods-in SKUs are unmapped — three distinct causes, not one

**Cause 1 — UG grade is entirely absent from the mapping file (60 of 95).**
`grep -c ',UG,' Z-G-MAPPING.csv` → 0. Zoho's export never carries an
"Ungraded" tier at all — confirmed structural, not a row that got dropped.
Every one of the 60 UG-suffixed unmapped SKUs has NO UG row in the CSV for
that model/color, while sibling A/B/C grades of the same model/color often
do exist and are mapped. **This is the graded stock has no route into
Zoho's item catalog by design of Zoho's own export — a real coverage hole
for UG stock specifically, at the mapping-source level, not something
`sku_map`'s import logic can fix.**

**Cause 2 — genuinely missing model/color/grade combinations, non-UG (29 of 95).**
E.g. `APL-I13-256-GRN-A`, `APL-I14-256-MDN-A/B/C`, `APL-I15PL-128-BLK-A/C`,
`SAM-S23U-512-GRN-B/C` — checked each against the raw CSV by exact-match
grep; none exist under any row. These are ordinary A/B/C-grade
combinations that Zoho's own catalog apparently never had a matching item
for, independent of the UG pattern above.

**Cause 3 — iPhone 16 non-Pro/128GB-Pro tiers, brand-new model (6 of 95).**
`APL-I16E-128-WHT-A`, `APL-I16P-128-BKT-A/DST-A/WTT-A` (128GB Pro),
`APL-I16PM-256-DST-UG/WTT-UG`. The CSV has 18 iPhone 16 rows total but
they skip: the base "16E" line entirely, all 128GB Pro configs (CSV only
has Pro at 256GB/512GB/1TB — `APL-I16P-1TB-NAT-A`, `-256-BKT/DST/NAT/WTT-A`,
`-512-BKT-A`), and (per Cause 1) any UG grade. Likely a genuinely new/thin
Zoho catalog for this recently-launched model rather than an import defect.

**None of this is a `skuMapImport.ts` bug.** The safeguards (column-scoped
writes, orphan-marking, audit rows, dry-run) all behaved correctly against
real data — the gap is entirely upstream, in what Zoho's own mapping
export contains. Restoration, if wanted, is at the Zoho-catalog source
(cause 1/3) or a data-entry gap in Zoho itself (cause 2) — not a code fix
in this repo.

## Numbers to carry forward

- 201 distinct goods-in SKUs in production (`organisation_id=1` only).
- 747 SKUs loaded into `sku_map` by the real import (matches existing
  `test/skuMapImport.spec.ts` baseline — this real-data run reproduces it
  independently, not just as an assumed constant).
- 95 goods-in SKUs (47.3% of the 201) have no corresponding `sku_map` row:
  60 UG-grade absence, 29 other genuinely-missing combinations, 6 iPhone 16
  tier/model gaps.
- Full unmapped-SKU list is in this session's transcript; not duplicated
  here in full to avoid a second stale list to maintain — re-run the same
  left-join against a fresh `gsk hosted d1_query` SKU pull if this number
  is needed again later, since production's goods-in set moves (see the
  existing 1133→1135 note in `pre-0029-export.md` for precedent on why a
  stored count goes stale).

## Deploy-manifest note — 0032 needs an explicit "first application" step

Because migration `0032_zoho_sku_mapping.sql` had never been applied to
production or local persisted D1 before this session (only ever exercised
inside `vitest-pool-workers`' in-memory per-test D1), the next real
production deploy that includes it is **not a no-op migration run** —
`zoho_items`/`sku_map`/`sku_map_audit`/`sku_map_version` will be created
in production for the first time, with zero rows, and someone will need
to run the real CSV import against production afterwards (via the
eventual `/imports` page, or the existing `src/routes/skuMap.ts` API
directly) to reach the same 747-row state this session's local-D1 test
achieved. The deploy record for that release should say "0032 applied for
the first time, tables created empty, import still pending" rather than
treating it as routine schema drift — routine migrations in this repo are
usually additive/inert on data that already fits; this one starts a
brand-new feature's data from zero.

## Directional coverage checks (2026-09-08 follow-up) — both structurally blocked, not just unrun

Two narrower checks were requested to separate "cosmetic gap" from
"revenue-affecting gap": (A) restrict the 95 unmapped SKUs to ones with at
least one device that left `ACTIVE_INVENTORY` toward a sale; (B, critical
path) reverse-join every distinct Zoho item ID appearing on an invoice
line against `sku_map` to catch unresolvable sold-invoice lines.

Both are correctly-designed checks with **no data to run against yet**,
confirmed two ways:
- Live production device-status distribution (`gsk hosted d1_query`,
  bracketed by clean `gsk login-info` before/after, identity
  `saigateslimited@gmail.com` both times): `RECEIVED=532, SORTING=393,
  IN_EXPORT_CONSIGNMENT=155, ACTIVE_INVENTORY=27, IN_HOUSE_REPAIR=17,
  READY_FOR_EXPORT=10, REJECTED=1`. Seven statuses total; `SOLD` is not
  among them — zero devices have ever reached `SOLD`.
- Schema-wide grep confirms no invoice-line/sales-ingestion table exists
  anywhere (`sold_*` columns don't exist on `received_devices`; no
  `sales_invoice`/`invoice_line` table in any migration; `SOLD` has zero
  inbound edges in `ALLOWED_TRANSITIONS`, `src/lib/deviceLifecycle.ts`).

Re-run both once real sales start flowing through the system (i.e. once
something actually writes a path into `SOLD` and an invoice-line table
exists to reverse-join against) — this note exists so that work isn't
silently reattempted against the same empty domain later.

## Regrade / UG-mapping interaction (resolved)

Regrade **does** rewrite a device's `sku`, not only its `grade`:
`src/routes/inventory.ts:290-294` — `UPDATE received_devices SET grade =
?, sku = ? WHERE id = ? AND organisation_id = ?`, using a freshly-resolved
`sku_catalog` lookup for the new `(model, capacity, color, grade)`
combination. So a UG device regraded to A/B/C acquires a new SKU at that
moment, which may already be mapped in `sku_map` even though the UG form
never was. This is *consistent with* Cause 1 above being largely benign,
but is not full proof without real regrade-then-sale history (which per
the directional-check finding above doesn't exist yet either).
