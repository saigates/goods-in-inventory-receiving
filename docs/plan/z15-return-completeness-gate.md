# Z-15 — Return-Completeness Gate: Scope + Sizing

Status: **SCOPING ONLY. No code, schema, or migration exists yet.** This
document is the work-tracker entry required before implementation begins,
per the standing protocol (same convention as
`docs/plan/device-lifecycle-slice1.md`). Written per operator instruction,
next-pass item 1, after item 2 (finalisation block) was flagged as missing
from the prior pass — Z-9's amendment 4 depends on Z-15's finalisation
block, and the wrong-device case belongs here rather than in Z-9.

## Problem statement

Z-8's investigation (2026-09-26, batch 3 / shipment 3) proved the system
cannot distinguish "exported and not yet returned" from "exported and
returned but never scanned" — both read `EXPORTED_UNDER_OPR` on the device
row, and nothing on the export shipment or the return shipment currently
computes or persists a per-consignment reconciliation. Today's `/discharge`
tracker (`GET /shipments` route, `computeDischargeRow()` in
`src/lib/oprImport.ts:1077-1128`) already computes exported/returned/
outstanding at the **export-batch** level, across *all* FINALISED returns
against that export — but it is read-only reporting, has no per-return
partial-return reason, and — critically — is not consulted by
`finaliseImportShipment` (`src/routes/opr.ts:1524-1603`) at all. A return
can currently be finalised at any line count without the system ever
checking it against the export it discharges. Export 1's 90-plus-72
pattern (a two-tranche return of a single export) is explicitly the
legitimate case this gate must continue to allow — Z-15 blocks *silent*
partial returns, not partial returns as such.

## Existing building blocks (confirmed, reusable)

- `computeDischargeRow(exportShipment, dischargePeriodMonths, exported, returned, today, closingWindowDays, exportedValueGbp?, returnedValueGbp?)`
  — pure function, already returns `{ outstanding, status: open|closing|overdue|discharged, outstanding_value_gbp, value_balanced }`.
  Z-15 reuses this as-is for the count/value math; no change to its
  signature is anticipated.
- `GET /discharge` (`src/routes/opr.ts:1287-1336`) — the SQL that sums
  `exported`/`returned` per export shipment across all its FINALISED
  returns already exists and is correct. Z-15's finalise-time check is
  the same query, scoped to one export id, run at the moment a specific
  return is about to finalise (not just displayed).
- `shipment_value_deltas` (migration 0019) / `shipment_misdeclaration_acks`
  (migration 0025) — the two existing append-only "correction/acknowledgement"
  table patterns. Z-15's partial-return reason (see below) follows the
  same shape: a new row, never an UPDATE, FK to the shipment.

## Scope — four parts, per operator's next-pass item 1

### (a) Exported-vs-returned balance, computed at finalise time (not just displayed)

`finaliseImportShipment` gains a pre-commit check: before flipping the
return shipment to FINALISED, run the same exported/returned aggregate
`GET /discharge` already computes, scoped to `related_export_shipment_id`,
**including the return shipment currently being finalised** in the
"returned" side. If `returned < exported` after this return commits, the
finalise is not blocked outright (see (b) — a legitimate partial return
must be allowed) — but it **requires** the partial-return reason from (b)
to be present, or the finalise is refused (422/409, mirroring the existing
red-block convention in `runImportValidation`).

If `returned` (including this return) would **exceed** `exported` — i.e.
more units returning than the export ever declared — that is a hard,
unconditional block. There is no legitimate reason for this to happen; it
signals a device/shipment data error, not an operator judgement call.

### (b) Partial-return reason, balance carried forward against the original MRN

New table, append-only, same shape as `shipment_misdeclaration_acks`:

```sql
CREATE TABLE IF NOT EXISTS partial_return_declarations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organisation_id INTEGER NOT NULL,
  export_shipment_id INTEGER NOT NULL,   -- the export being partially discharged
  return_shipment_id INTEGER NOT NULL,   -- the return leg being finalised
  exported_count INTEGER NOT NULL,       -- frozen at declaration time
  returned_count_cumulative INTEGER NOT NULL,  -- across ALL finalised returns incl. this one
  outstanding_count INTEGER NOT NULL,    -- exported_count - returned_count_cumulative
  reason TEXT NOT NULL,                  -- free text: why the balance remains outstanding
  carried_forward_deadline TEXT NOT NULL,-- = the export's own discharge deadline (unchanged,
                                          --   never a new/extended deadline — Z-15 does not
                                          --   grant more time, only records that a balance
                                          --   remains against the EXISTING deadline)
  declared_by_user_id INTEGER NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (export_shipment_id) REFERENCES shipments(id),
  FOREIGN KEY (return_shipment_id) REFERENCES shipments(id)
);
CREATE INDEX idx_partial_return_export ON partial_return_declarations(export_shipment_id);
```

One row per return leg that finalises with `returned < exported` for its
export. A fully-discharging return (returned == exported cumulative) never
writes a row here. The existing `/discharge` tracker already surfaces the
deadline via `computeDischargeRow`'s `discharge_deadline`/`days_remaining`
fields — this table does not duplicate that computation, it only records
*that* a human explicitly acknowledged the gap and *why*, at the moment it
was allowed through.

### (c) Wrong-device-returned case (moved here from Z-9 per operator instruction)

`addDeviceToReturnShipment` (`src/routes/opr.ts:839-912`) already refuses
a device that has no matching line on the related export (`if (!exportLine)
... 409`). That refusal already exists and is correct for "this device was
never on this export." What Z-15 adds is the *symmetric* case: a physical
scan produces a device the operator believes is a genuine return unit but
whose corrected identity (per Z-9's `return_line_corrections`, once that
ships) doesn't merely diverge in grade/colour — it resolves to a
fundamentally different device than any line on the related export. This
is not a new endpoint; it is a new check that runs Z-9's generation-boundary
detector (§5/Amendment 3) against the *whole* consignment at finalise time,
not just per-line.

**Correction (2026-09-26, same day as this doc, post-write): narrowed to
match the operator's ruling on Z-9's own finalise-time block.** The
operator has since ruled that a generation-boundary correction is NOT a
misdeclaration on the original export — Z-9's `IMP_RETURN_LINE_REVIEW`
check was corrected accordingly to hard-block ONLY on an IMEI-driven
correction (`review_reason` includes `imei_change`), never on
`generation_boundary`/`generation_unparseable`/`catalog_value_diff` alone.
Z-15's shipment-level enforcement point MUST read the same distinction,
not `requires_review` generically, or it would silently reintroduce
exactly the over-broad block Z-9 just had corrected out of it. So: if an
IMEI-driven correction is still unreviewed anywhere on the return,
finalisation is blocked, no override (Amendment 4's "sharp case," X-7
reserved). A non-IMEI `requires_review` correction (generation-boundary,
unparseable, or catalog-value-diff alone) does NOT block Z-15's gate
either — same amber-informational treatment as Z-9's own check.
**Dependency unchanged**: this sub-scope cannot be implemented before
Z-9 ships `return_line_corrections`/`requires_review`/`review_reason` —
Z-15's finalise-time block reads those columns, it does not duplicate
the detection logic.

### (d) Finalisation block, general

Combining (a)–(c): `finaliseImportShipment` gains one new pre-commit gate,
analogous to the existing `runImportValidation` red-block check already in
that function, with three failure modes:
1. `returned > exported` (cumulative, including this return) — hard block, no override.
2. `returned < exported` (cumulative) with no `partial_return_declarations`
   row supplied in the finalise request body — block, "reason required."
3. Any line on this return has an unreviewed IMEI-driven correction
   (`review_reason` includes `imei_change`; Z-9 dependency) — hard block,
   no override (per Amendment 4, narrowed per the operator's
   generation-boundary ruling — see (c) above). A non-IMEI
   `requires_review` correction does not trigger this failure mode.

## Explicit non-goals

- Z-15 does not change the discharge deadline itself, does not grant
  extensions, and does not auto-notify HMRC — it only gates finalisation
  and records the declared reason.
- Z-15 does not touch `computeCe1154()`'s arithmetic — the C&E1154 already
  correctly describes only the returning units on this leg (the existing
  "quantity guardrail," `oprImport.ts:394-401`); Z-15 operates one level up,
  at the shipment-completeness question, not the per-shipment customs figure.
- Z-15 does not retroactively re-check already-FINALISED returns (Exports
  1 and 2's existing legs are not touched by this ticket) — it only gates
  *future* finalise calls. A backfill/audit pass over Exports 1 and 2's
  existing finalised legs, if wanted, is a separate, later exercise
  (flagged, not scoped here).

## Sizing

| Piece | New/reused | Estimate |
|---|---|---|
| Migration (`partial_return_declarations` table) | new | 0.5 day (schema + local/prod migration file, following the 0019/0025 pattern exactly) |
| `finaliseImportShipment` pre-commit gate (a)+(d.1)+(d.2) | new check, reuses `computeDischargeRow` | 1 day incl. request-body handling for the reason payload |
| Wrong-device / `requires_review` finalise block (c)+(d.3) | new check | 0.5 day — **but blocked until Z-9's `return_line_corrections`/`requires_review` exists**; cannot start early |
| Tests (unit: gate logic; integration: finalise blocked/allowed paths, partial-return row written, cumulative-exceeds-exported hard block) | new | 1.5 days |
| Route/response wiring (`POST /finalise` body shape, error messages, `GET /discharge` unchanged) | new | 0.5 day |
| **Total** | | **~4 days**, of which **~3.5 days can start immediately** and **~0.5 day is hard-gated behind Z-9 shipping first** |

## Sprint 1 fit

Twelve days remain in Sprint 1 (25 Sep – 8 Oct) as of this pass, with Z-2/
Z-3/Z-4 still at 0% and explicitly named as what actually unblocks the
Zoho export. Z-9 (full five-amendment scope, migration 0039, restock
write-through, tests) is a materially larger ticket than Z-15's ~4 days —
Z-15's (c)/(d.3) sub-scope structurally cannot start until Z-9's table
exists, so the two tickets are sequential, not parallel, for that slice.
Z-15's (a)/(b)/(d.1)/(d.2) sub-scope (~3.5 days) has no such dependency and
could run before, after, or interleaved with Z-9's non-dependent work.

This sizing is submitted for the operator's own capacity call against
Z-2/Z-3/Z-4 and the 12 remaining days — no scheduling decision is made
here, per instruction ("no code" / scoping only).
