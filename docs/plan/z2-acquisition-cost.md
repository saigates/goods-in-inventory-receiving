# Z-2 — Acquisition Cost Fields: Scope + Design Decision

Status: **IMPLEMENTED and MERGED to `main`** (merge commit `2cd33b2`,
"Merge Z-2 (acquisition_cost/total_cost + export-gate zero-cost block) into
main"). The branch-pinning note that used to live here is now historical —
recorded as of the pass that wrote the Z-3 closing note below, current as
of that pass.

## Problem statement, per operator's next-pass item 2

> Z-2: `acquisition_cost` from goods-in, `total_cost` = acquisition + repair
> + freight, only `acquisition_cost` reaches the Zoho bill Rate. Devices with
> zero acquisition cost block at the export gate.

## Pre-existing design gap, found before writing any code

This codebase already has **two distinct, previously-unreconciled
"acquisition cost" concepts**, and Z-2's literal instruction ("populated
from goods-in") cannot be implemented by picking one without addressing the
conflict between them:

1. **`received_devices.buy_price`** — a single mutable REAL column, set at
   goods-in (`src/routes/scan.ts`'s `/confirm`, `/bulk`, `/force-add`,
   `/manual` paths). `buy_price` is **required on every intake path**
   (`parseValuation()`'s `opts.required: true`, scan.ts:27-32's own
   comment) — so this is the only cost figure GUARANTEED to exist the
   moment a device is received. It has no history and no source
   attribution (a correction overwrites it, not append-only).

2. **`cost_ledger` rows with `cost_type = 'purchase'`** (migration 0028) —
   append-only, typed, provenance-tagged (`supplier-invoiced` /
   `default-unverified`). This is the term **already used in this
   codebase** for acquisition cost — `src/routes/reports.ts:245`'s own
   comment states "Acquisition rows are cost_type = 'purchase'" — and its
   per-device SUM is already exposed as `purchase_cost_gbp` in
   `GET /api/devices/export/csv` (`devices.ts:598`) and
   `GET /api/reports/inventory-valuation`. **Critically, nothing writes
   this at goods-in time** — the only two writers are
   `src/routes/bills.ts`'s `write-cost-ledger` (requires a CLOSED bill) and
   `src/lib/costEntry.ts`'s `postPurchaseCostToLedger()` (a manual/
   historical-backfill entry point, manager-only, called later). Both are
   confirmed via `grep` to have zero call sites in `scan.ts`.

`devices.ts:497-514`'s own comment on the `/export/csv` rewrite explicitly
records that `buy_price` was **dropped on purpose** from that export in
favour of `purchase_cost_gbp`, "the more trustworthy figure ... the two are
NOT meant to be exported side by side (that would invite exactly the kind
of 'which number is right' confusion a reconciliation file must avoid)."
Introducing a THIRD field called `acquisition_cost` without addressing this
would reopen exactly the confusion that comment closed.

## Decision (pick-and-note, per standing protocol)

**`acquisition_cost_gbp` is defined as a computed fallback, not a new
stored column and not a new writer:**

```
acquisition_cost_gbp =
  cost_ledger 'purchase' SUM(amount_gbp)   if any 'purchase' row exists for the device
  buy_price                                 otherwise (goods-in value, unconverted)
```

Implemented in `src/lib/acquisitionCost.ts`'s `computeAcquisitionCostGbp()`.
This satisfies the operator's literal instruction — a device is never
acquisition-costed at zero just because no bill has landed yet, the
goods-in `buy_price` covers it from the moment of receipt — while
preserving the existing, deliberate precedent that a bill-backed or
manually-entered `cost_ledger` figure supersedes the single mutable
goods-in value once one exists. `source: 'cost_ledger' | 'goods_in_buy_price' | 'none'`
is returned alongside the number so any caller can see which one is live
for a given device, rather than the two silently competing.

**Why NOT auto-write a `cost_ledger` 'purchase' row at goods-in instead**
(the alternative design, rejected): `src/lib/costEntry.ts`'s own duplicate
guard blocks a SECOND positive `cost_type='purchase'` row on a device
unless `allow_duplicate_purchase_row: true` is explicitly set — a
safeguard against double-counting. If `scan.ts` auto-posted a ledger row
at receipt AND a bill later closed and posted its own row for the same
device (`bills.ts`'s `write-cost-ledger`, which has no such duplicate
check — it only skips already-posted `source_bill_line_id`s, not a
second acquisition figure from an unrelated origin), the device would be
double-counted in every `purchase_cost_gbp` consumer (the CSV export, the
inventory-valuation report) with no error raised anywhere. The
computed-fallback design has no such write-time collision risk, because it
never writes a second row — it just changes which existing number the
read-time computation prefers.

**Currency**: `buy_price`'s fallback path assumes the value is already
GBP-denominated when used as `acquisition_cost_gbp` verbatim — this is not
a new limitation Z-2 introduces; it MATCHES the existing, pre-Z-2
convention already hardcoded in `addDeviceToShipment()`
(`src/routes/opr.ts:808`, `.bind(..., device.buy_price, 'GBP', ...)` —
that INSERT already writes `device.buy_price` into
`shipment_lines.unit_value` with `currency` forced to `'GBP'` regardless
of `received_devices.currency`'s actual value). Z-2 does not fix that
pre-existing FX gap (no exchange-rate field exists on `received_devices`
to convert from); it is recorded here as a known, inherited limitation,
not silently carried forward unremarked.

## `total_cost_gbp`

```
total_cost_gbp = acquisition_cost_gbp
               + SUM(cost_ledger WHERE cost_type='repair', amount_gbp)
               + SUM(cost_ledger WHERE cost_type='freight', amount_gbp)
```

Repair and freight are read straight from `cost_ledger` (no fallback
needed — both already have dedicated, working writers:
`postRepairCostToLedger()` / `bills.ts`'s `write-cost-ledger` for repair;
`freightApportionment.ts`'s `apportionFreightByValue()` for freight).
`computeDeviceCostBreakdown()` in the same new file returns all four
figures (`acquisition_cost_gbp`, `repair_cost_gbp`, `freight_cost_gbp`,
`total_cost_gbp`) plus `acquisition_source`.

## "Only `acquisition_cost` reaches the Zoho bill Rate" — REVISED, no `Rate` column here

**Superseded design (as first implemented, now reversed):** Z-2 originally
added a `Rate` column (Zoho's own bill-import field name for unit cost) to
`GET /api/devices/export/csv`'s manager-gated cost-column set, populated
with `acquisition_cost_gbp` ONLY.

**Operator ruling (2026-09-26, §3 of that pass) — reversed this:** `Rate`
is Zoho-bill-import vocabulary that belongs exclusively to a future ticket
**Y-1**, which will build a 26-column `Zoho_Bill_Template` mapping file —
the single place this codebase's fields map onto Zoho's own bill-import
column names. A second `Rate` alias living here, in the general-purpose
device CSV export, would be a second, independently-driftable mapping of
the exact same underlying figure. The first time the two mappings diverged
(a rename in one file and not the other, a rounding difference, a future
edit that touches only one), it would surface to **Y-4**'s reconciliation
as an apparent "Zoho-side edit" that is actually just this codebase
disagreeing with itself.

**Current, correct design:** this export exposes only
`acquisition_cost_gbp` (plus `freight_cost_gbp` and `total_cost_gbp`).
Whichever future code actually builds the Zoho bill payload — Y-1's
mapping file — reads `acquisition_cost_gbp` and renames it to `Rate`
itself, in exactly one place. This export never uses the word `Rate`. The
existing `purchase_cost_gbp` column is left untouched (still the raw
`cost_ledger` sum with no goods-in fallback) so no existing consumer's
column semantics silently changes; `acquisition_cost_gbp`, `freight_cost_gbp`,
and `total_cost_gbp` are net-new, additive columns — `Rate` is not one of
them.

## Export-gate block — "devices with zero acquisition cost block"

`addDeviceToShipment()` (`src/routes/opr.ts`) already refused a device
with `buy_price == null`. This was a **null-only** check — a device with
`buy_price = 0` (a real, if unusual, zero-cost entry) passed through
untouched and could join an export consignment with a customs unit value
of £0. Z-2 replaces that check with a call to
`computeAcquisitionCostGbp()` and refuses when the result is `null` OR
`<= 0`, with a message that names which case applied (no buy_price entered
at all, vs. a zero/negative computed acquisition cost) so an operator
seeing the 422 knows which of the two to fix.

## Y-3/Y-4 requirement: snapshot acquisition cost as sent, never recompute at reconciliation (operator §1, 2026-09-26)

`acquisition_cost_gbp` is a **live computed read** (see Decision, above) —
its value can change after the fact. Concretely: a device is exported to
Zoho at a `Rate` derived from its goods-in `buy_price` (no `cost_ledger`
`'purchase'` row exists yet); a week later a bill closes and posts a
`cost_ledger` `'purchase'` row for that same device. From that moment on,
`computeAcquisitionCostGbp()` returns the ledger sum instead of
`buy_price` — the figure we originally sent Zoho no longer reproduces from
a fresh call.

**The risk this creates for Y-4:** if a future **Y-3** (the Zoho
batch-export ticket) persists a device into `zoho_batch_devices` by
storing only identifying keys and re-deriving the acquisition cost at
reconciliation time via a fresh `computeAcquisitionCostGbp()` call, then
**every** such after-the-fact ledger posting would make Y-4's reconciliation
logic see "our figure" and "Zoho's figure" diverge — permanently, for that
device, from the moment the ledger row posts onward. Y-4 has no way to
tell that apart from an actual, genuine edit made on the Zoho side. The
false-positive is not a one-off glitch; it is a standing, silent drift
that would need to be manually re-investigated and dismissed every time it
fires, for a device that was in fact billed correctly.

**Required fix, owned by Y-3/Y-4, not implemented by Z-2 (Z-2 has no
`zoho_batch_devices` writer — see Non-goals):**

- When Y-3 persists a device row into `zoho_batch_devices`, it MUST
  **snapshot** — write down as a stored value on that row, at send time —
  both:
  1. the `acquisition_cost_gbp` figure actually sent, and
  2. the `acquisition_source` flag (`'cost_ledger' | 'goods_in_buy_price' | 'none'`)
     that was live at that same moment (already returned by
     `computeAcquisitionCostGbp()` — Y-3 has this value for free from the
     same call it uses to build the sent figure; it only needs to persist
     it rather than discard it).
- Y-4's reconciliation MUST compare Zoho's reported value against this
  **frozen snapshot** — never against a fresh call to
  `computeAcquisitionCostGbp()` for the same device. A genuine
  post-export ledger posting is allowed to change what a NEW export would
  send; it must never retroactively change what an ALREADY-SENT batch is
  judged against.
- This is recorded here, in the Z-2 doc, specifically so Y-3 inherits the
  requirement when it is scoped/started, rather than rediscovering the
  same failure mode from a live incident after batches are already
  flowing.

## Y-1/Y-3 requirement: export SKU must be read live, never from the frozen `shipment_lines.sku` (Z-3 closing note)

**Origin.** Z-3 was raised against a real incident: a stale SKU appeared
on a bill that had been produced by hand from the August workbook. The
ticket's working title ("export SKU source") implied a live code path
somewhere reads `shipment_lines.sku` when it should read
`received_devices.sku`, and that path needed fixing plus a retro-fix of
any past pushes carrying the stale value.

**Finding, this pass — three paths checked, by direct code read, not by
inspection of a plan doc (none existed for Z-3):**

1. **`GET /api/devices/export/csv`** (`src/routes/devices.ts:639`,
   `exportCsvSelectSql()` at line 573) — the CSV export that actually
   feeds today's hand-built Zoho reconciliation workflow. Its `SELECT`
   reads `rd.sku` — `received_devices.sku` — directly, live, with no
   `shipment_lines` join anywhere in that query. This path already
   satisfies "read SKU live from the device record."
2. **`src/lib/zohoSaleImport.ts` / `src/routes/zohoSaleImport.ts`** — the
   **inbound** Zoho→app importer (sale-attribution, matched by `imei`).
   Its own header states explicitly "NO SKU translation on this path."
   Not an export-SKU surface at all; irrelevant to Z-3's premise.
3. **`src/lib/billBuilder.ts` / `src/routes/bills.ts`** — the one bill
   builder for the two bill types that exist today, `purchase` and
   `repair` (Sprint B §1). Neither type is a Zoho SALES/export bill.

**Conclusion: there is no outbound Zoho bill-build code path in this
codebase today, because Y-1 (the Zoho bill-mapping ticket) has not been
written yet.** The stale SKU that motivated Z-3 could not have come from
a live code defect — it came from a human building a bill by hand outside
any of the three paths above. `shipment_lines.sku` staying frozen-at-
add-time (Z-9's deliberate customs-record design) was never actually
implicated; there is no code that reads it into an export or a bill.

**Therefore Z-3, as a fix-a-bug ticket, is CLOSED — closing statement:**
checked `devices.ts`'s CSV export (reads `received_devices.sku` live,
already correct), `zohoSaleImport.ts` (inbound, explicitly no SKU
translation, not in scope), and `billBuilder.ts`/`bills.ts` (purchase/
repair invoicing only, not a Zoho export surface) — no live path reads a
frozen SKU into an export or bill, so there is nothing to fix and nothing
to retro-fix. The read-only stale-SKU comparison count that was to
accompany this closure was explicitly skipped for the same reason: with
no code path reading a frozen SKU into a bill, any divergence between
`shipment_lines.sku` and `received_devices.sku` in production is either
the intended Z-9 frozen snapshot or a recorded Z-9 correction — both
correct, neither actionable — and running the count would produce a
number with no decision attached to it.

**What Z-3 actually leaves behind is a constraint for the tickets that
will build the outbound path, pairing with the Y-3/Y-4 snapshot
requirement immediately above — both now inherited by Y-1 and Y-3:**

- **Y-1** (Zoho bill-mapping file) MUST read SKU live from
  `received_devices.sku` at bill-build time. It must NEVER read
  `sku` off `shipment_lines` — that column stays frozen-at-add-time for
  Z-9's customs-record purposes and is not a safe source for a
  Zoho-facing SKU, for exactly the same "figure can silently go stale
  after the fact" reason the acquisition-cost snapshot requirement above
  exists.
- **Y-3** (Zoho batch-export ticket), when it writes a `zoho_batch_devices`
  row, MUST **snapshot the SKU actually sent** on that row — not just
  identifying keys to be re-resolved later — for the identical reason
  or the acquisition-cost/acquisition-source snapshot already required
  above: a device can be re-graded (new SKU) or corrected
  (`PATCH /:id/correct`) AFTER a batch has already gone out, and Y-4's
  reconciliation must judge that already-sent batch against what was
  actually sent, not against a fresh live lookup that has since moved on.
  Y-3's `zoho_batch_devices` row should carry the SKU (this section) and
  the acquisition_cost_gbp + acquisition_source (Y-3/Y-4 section above)
  as one paired snapshot, written at the same send-time moment, not two
  separately-timed writes.

## X-8 follow-on (noted, not actioned this ticket)

Per the operator's note: INV-260067's AED 133.08-per-unit repair charge is
apportioned across a denominator that is currently unsettled (155 vs 112,
Batch 3's open blocker). `computeDeviceCostBreakdown()`'s `repair_cost_gbp`
figure for any Batch-3 device is only as correct as that denominator —
this is inherited exposure, not a Z-2 defect, and X-8's own apportionment
logic (wherever it lands) will consume this same `cost_ledger
cost_type='freight'`-shaped-but-repair-typed sum once the denominator is
confirmed. Z-2 does not touch `freightApportionment.ts` or attempt to
pre-empt X-8's design.

## Shipment 3 — repair_cost variance against INV-260067 — SUPERSEDED, pending FedEx IDS (originally ruled immaterial 2026-09-28; reopened 2026-10-05)

**Original ruling (2026-09-28), now superseded, kept for the record:** the
app keeps `repair_cost` at `20,627.21` and computes `£4,144.01` from it;
INV-260067 itself states `20,627.40` / `£4,144.05`. The operator ruled this
variance (four pence, on both the underlying figure and its GBP conversion)
**immaterial to the customs position and the VAT**, and **deliberately not
corrected** — accepted as-is. Filed same pass as the ruling, specifically
so a reconciliation exercise months later that found this exact 4p gap
would have a written record that it was seen, checked, and knowingly left
alone rather than newly discovered. No `shipments.repair_cost` value
change, no code change, no migration at that time.

**Why this is reopened (2026-10-05):** the variance is no longer purely
internal. £4,144.09 has gone to a customs broker in writing and will
appear on an official declaration — a THIRD figure, distinct from both the
system's £4,144.01 and the invoice's (understood-to-read) £4,144.05. The
operator's standing principle: materiality is not a fixed property of a
number, it depends on who has already acted on it and in what capacity.
Three figures for one value, one of them now public, is no longer the
immaterial-rounding case the 2026-09-28 ruling addressed.

**Current ruling — no action until the IDS lands:** per the operator
(2026-10-05), take no action on `repair_cost` until FedEx returns the
import MRN and IDS (Import Declaration Statement). Once that document
lands, the declared figure on it becomes the single source of truth, and
`repair_cost` is corrected to match it everywhere — in the ledger, in the
system's own computed `£4,144.0x`, and against whichever of £4,144.01 /
£4,144.05 / £4,144.09 the IDS actually confirms. This note is the
superseding record; the 2026-09-28 "immaterial, accepted" language above
no longer governs and must not be cited as closing this out.

**Still outstanding, separately** (operator's passive ask, not yet
actioned — no sighting of INV-260067 this pass): confirm directly against
the invoice document whether it reads £4,144.09 or £4,144.05 — this
figure needs to resolve to one value across system/invoice/broker, and the
£4,144.05 reading above is itself only "understood to read .05," not
independently re-confirmed in this pass.

## Non-goals

- Does not add a stored `acquisition_cost` column to `received_devices` or
  any table — it is a computed read, matching the existing
  `purchase_cost_gbp` pattern's own precedent of being a query-time
  aggregate, not a persisted field.
- Does not touch `bills.ts`'s `write-cost-ledger`, `costEntry.ts`'s
  `postPurchaseCostToLedger()`, or `repairWorkflow.ts`'s
  `postRepairCostToLedger()` — all three existing writers are read
  as-is; Z-2 only adds a new READ-time aggregation on top.
- Does not fix the pre-existing `buy_price`-forced-to-`'GBP'` assumption in
  `addDeviceToShipment()`'s `shipment_lines` insert (see Currency note
  above) — flagged, not fixed, as it predates this ticket and touching it
  is a separate, larger FX-handling piece of work.
- **SUPERSEDED (2026-09-28, operator ruling, X-9 §2)** — this bullet
  originally read: "Does not change `GET /api/reports/inventory-valuation`'s
  existing `purchase_gbp` / `purchase_plus_repair_gbp` figures — those
  remain the raw `cost_ledger`-only aggregates they always were;
  `acquisition_cost_gbp` is a new, separate, CSV-export-facing figure
  with the goods-in fallback, not a replacement for the report's
  existing basis." That is no longer true and is left struck through
  here rather than silently deleted, per the standing instruction that
  an unamended doc contradicting live behaviour is itself a Z-16
  instance. As of `src/routes/reports.ts`'s X-9 §2 change (same commit
  as this amendment), the report's headline/by_stage/by_provenance
  figures DO now read the fallback-aware `acquisition_cost_gbp` basis
  (cost_ledger 'purchase' sum, else goods-in `buy_price`, else none) —
  the same three-way precedence as `computeAcquisitionCostGbp()` and
  the CSV export. Reason: with `cost_ledger` at 0 rows in production,
  the raw-ledger-only report showed £0 across all 1,486 devices next to
  a CSV export quoting real `buy_price`-backed numbers for the same
  devices — two contradictory valuations in one system. The report's
  own `by_acquisition_source` field (renamed from `costed_vs_uncosted`)
  now states explicitly, per response, how many devices are
  ledger-backed, buy_price-backed, or neither, so the provisional
  nature of a fallback-sourced figure stays visible rather than being
  smoothed into a single number. `repair_gbp` has NO such fallback (no
  in-house-labour equivalent exists) and is unchanged — still a raw
  `cost_ledger` 'repair' sum only, per the report's own `basis` field
  LIMITATION 1.
- Does not touch `zoho_batches` / `zoho_batch_devices` (confirmed via grep
  to have zero application-code writers as of this ticket) or implement
  the snapshot-at-send-time requirement described above — that write path
  belongs to Y-3, and the reconciliation-against-snapshot logic belongs to
  Y-4. Z-2's only obligation here is to make sure the requirement is
  documented before either ticket starts, which this section does.
- Does not add a `Rate` column or any Zoho-bill-vocabulary field name to
  this export — see the revised section above; that naming is Y-1's
  exclusively.
