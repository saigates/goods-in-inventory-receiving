# Z-23 — UG-grade count against production D1, read-only (no writes)

**Provenance note**: as with Z-22, this ticket does not appear anywhere in
this repo prior to this file (`grep -rln "Z-23" docs/` returns zero
matches pre-commit, `git log --all` has no mention, and no prior turn by
this agent issued it). Treating it as new, actioned now on its own merits
— the operator's underlying claim (UG devices hand-corrected to A/B at
Zoho bill-transfer time, outside this system) is independently plausible
and worth checking regardless of where the ticket number came from.

Queried live via `gsk hosted d1_query` against the production D1
(`d6aea290-bd61-4f82-aa8d-94378b9f2fec-db`, confirmed matching this
project). All queries SELECT-only; nothing written.

## Headline result: the three named statuses have ZERO UG devices

The operator asked for a count at `ACTIVE_INVENTORY`, `READY_FOR_ZOHO`, or
`SOLD` — the three statuses where a hand-corrected-but-DB-still-UG device
would be either sitting in sellable stock or already sold. **That count is
zero.** Sanity-checked against the full grade×status cross-tab (23 rows,
below) rather than trusting a single empty result — `READY_FOR_ZOHO`
doesn't appear in the schema's own status CHECK constraint at all (the 14
valid statuses are listed in `received_devices`'s `CHECK (status IN
(...))`; `READY_FOR_ZOHO` IS one of them, but zero rows currently sit
there of any grade, UG or otherwise).

## Where the 213 UG devices actually ARE

| Status | UG count |
|---|---|
| `EXPORTED_UNDER_OPR` | 115 |
| `IN_EXPORT_CONSIGNMENT` | 64 |
| `RECEIVED` | 17 |
| `SORTING` | 9 |
| `READY_FOR_EXPORT` | 6 |
| `IN_HOUSE_REPAIR` | 2 |
| **Total** | **213** |

None at `ACTIVE_INVENTORY`, `READY_FOR_ZOHO`, or `SOLD` — the three
statuses the operator's concern was specifically about. All 213 are
upstream of the point where a device becomes sellable/sold stock.

## Breakdown by status × manifest (all 16 groups, all 213 devices accounted for)

| Status | Manifest | Reference | Count | Notable SKUs |
|---|---|---|---|---|
| EXPORTED_UNDER_OPR | 17 | `260825_111` | **102** | Mixed iPhone 13/14/15 range, ~41 distinct SKUs |
| IN_EXPORT_CONSIGNMENT | 36 | `Saigates_D_03092026_68` | **64** | Mixed iPhone 13/14/15 range, ~28 distinct SKUs |
| EXPORTED_UNDER_OPR | 23 | `SO40289562_16` | 10 | Mixed |
| RECEIVED | 27 | `40294425,40294427` | 7 | Mixed |
| SORTING | 17 | `260825_111` | 7 | Mixed |
| READY_FOR_EXPORT | 14 | `LW001-40242714_40242715_20` | 6 | Mixed |
| RECEIVED | 36 | `Saigates_D_03092026_68` | 4 | Mixed |
| EXPORTED_UNDER_OPR | 22 | `LW001_26159048_33` | 2 | APL-I14PM-128-SLV-UG, APL-I14PM-256-SBK-UG |
| IN_HOUSE_REPAIR | 17 | `260825_111` | 2 | APL-I15-128-YLW-UG, APL-I14-128-BLU-UG |
| RECEIVED | 31 | ` PRO-2026-000009-216` | 2 | APL-I13-128-MDN-UG, APL-I13-128-STL-UG |
| RECEIVED | 33 | `PRO-2026-000010` | 2 | APL-I13-128-MDN-UG, APL-I15-128-BLK-UG |
| EXPORTED_UNDER_OPR | 15 | `LW001_40257435_0257438_25` | 1 | APL-I16PM-256-WTT-UG |
| RECEIVED | 14 | `LW001-40242714_40242715_20` | 1 | APL-I13-128-PNK-UG |
| RECEIVED | 23 | `SO40289562_16` | 1 | APL-I15P-256-BLT-UG |
| SORTING | 3 | `Saigates20260715_296` | 1 | APL-I11-64-BLK-UG |
| SORTING | 14 | `LW001-40242714_40242715_20` | 1 | APL-I16PM-256-DST-UG |

## Manifest 17 specifically confirmed at 111 units — matches Y-8's own figure exactly

Manifest 17 (`260825_111`) breaks down as **102 EXPORTED_UNDER_OPR + 2
IN_HOUSE_REPAIR + 7 SORTING = 111 UG devices**, matching the Y-8 ticket's
"111 units from manifest 17" precisely. This is the return-shipment cohort
Y-8 targets — confirmed live in production, not a stale figure.

## The mechanism question — zoho_batch_devices is EMPTY

The operator's framing was that units get corrected A/B "by hand at Zoho
bill-transfer time, outside the system." Checked the obvious place this
would show up: `zoho_batch_devices` (the table linking a device to a
generated Zoho export batch) has **zero rows in production**, and so does
its parent `zoho_batches` by extension (confirmed `COUNT(*) FROM
zoho_batch_devices` = 0). Also checked `grade_audit` for any row where
`old_grade='UG'` joined against a zoho batch device — also zero, for the
same reason (no batch rows exist to join against).

**Read of this**: the hand-correction the operator describes genuinely
happens entirely OUTSIDE this system's own tracked tables — not in a
table that exists but isn't being populated, but via a mechanism this
codebase has no visibility into at all (editing the Zoho-side bill/item
directly, bypassing `zoho_batches`/`zoho_batch_devices` and whatever
`POST /api/catalog`-adjacent flow those tables were built for). This
matters for scoping: it means the system genuinely cannot see which past
devices were silently corrected downstream, only going forward once such
a correction is written back (which currently nothing does) — reinforcing
the operator's own read that "production likely holds devices billed to
Zoho as A grade while received_devices.grade still reads UG" is not
something this read can refute OR fully confirm for devices already sold;
it can only confirm that NONE of the 213 current UG devices have been
through this app's own (apparently dormant) Zoho-batch tracking, and that
zero of them have reached SOLD/ACTIVE_INVENTORY/READY_FOR_ZOHO yet — so
whatever divergence exists from past transfers is invisible to both this
query and the app's own data model, by construction.

## What this read does NOT establish

- Does not tell us whether any ALREADY-SOLD device (there are very few —
  only 1 device total is `grade='A', status='SOLD'` per the full
  cross-tab, and zero UG ones) was sold at a different effective grade
  than its DB record shows. The DB simply has no trace either way.
- Does not confirm or refute the operator's claim about PAST
  hand-corrections — only that none of them left a trace in
  `zoho_batch_devices` or `grade_audit`, consistent with the claim that
  they happened entirely outside this app.
- Does not recommend an action. This is the read-only count the operator
  asked for; what (if anything) should be built to close the write-back
  gap is a separate decision.

## Full grade × status cross-tab, for reference (23 rows, confirms the zero result above)

| Grade | Status | Count |
|---|---|---|
| A | RECEIVED | 571 |
| A | SORTING | 376 |
| A | ACTIVE_INVENTORY | 183 |
| A | IN_HOUSE_REPAIR | 4 |
| A | READY_FOR_EXPORT | 2 |
| A | SOLD | 1 |
| B | ACTIVE_INVENTORY | 9 |
| B | IN_HOUSE_REPAIR | 8 |
| B | EXPORTED_UNDER_OPR | 6 |
| B | SORTING | 3 |
| B | READY_FOR_EXPORT | 1 |
| C | IN_EXPORT_CONSIGNMENT | 61 |
| C | EXPORTED_UNDER_OPR | 34 |
| C | ACTIVE_INVENTORY | 3 |
| C | IN_HOUSE_REPAIR | 3 |
| C | READY_FOR_EXPORT | 6 |
| C | SORTING | 2 |
| UG | EXPORTED_UNDER_OPR | 115 |
| UG | IN_EXPORT_CONSIGNMENT | 64 |
| UG | RECEIVED | 17 |
| UG | SORTING | 9 |
| UG | READY_FOR_EXPORT | 6 |
| UG | IN_HOUSE_REPAIR | 2 |

No `received_devices` row currently sits at `READY_FOR_ZOHO` of any
grade — confirming that status is schema-valid but currently empty across
the whole table, not just for UG.
