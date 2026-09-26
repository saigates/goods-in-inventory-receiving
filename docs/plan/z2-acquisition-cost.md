# Z-2 — Acquisition Cost Fields: Scope + Design Decision

Status: **IMPLEMENTED on branch `z2-acquisition-cost` (off `040b3eb`), NOT
merged to `main`.** Per operator instruction this pass: `main` stays pinned
at the deploy target (`040b3eb`) until the redeploy action has landed and
been confirmed; Z-2 develops on its own branch until then.

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

## "Only `acquisition_cost` reaches the Zoho bill Rate"

`GET /api/devices/export/csv` (`src/routes/devices.ts`) is this codebase's
existing Zoho-reconciliation-facing export surface (the column-naming
convention there already borrows Zoho's own field vocabulary, e.g.
`skuMapImport.ts`'s literal `'Zoho Item Name'` header). Z-2 adds a `Rate`
column (Zoho's own bill-import field name for unit cost) to that export's
manager-gated cost-column set, populated with `acquisition_cost_gbp` ONLY
— `repair_cost_gbp` and `freight_cost_gbp` are computed and exposed
alongside it (as `total_cost_gbp`) but never folded into `Rate`. The
existing `purchase_cost_gbp` column is left untouched (still the raw
`cost_ledger` sum with no goods-in fallback) so no existing consumer's
column semantics silently changes; `acquisition_cost_gbp`, `total_cost_gbp`,
and `Rate` are net-new, additive columns.

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
- Does not change `GET /api/reports/inventory-valuation`'s existing
  `purchase_gbp` / `purchase_plus_repair_gbp` figures — those remain the
  raw `cost_ledger`-only aggregates they always were; `acquisition_cost_gbp`
  is a new, separate, CSV-export-facing figure with the goods-in fallback,
  not a replacement for the report's existing basis.
