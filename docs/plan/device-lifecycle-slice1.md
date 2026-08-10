# Device Lifecycle & Repair Operations — First Slice Design + Test Plan

Status: PLANNING ONLY. No application code, migrations, or schema changes
exist yet for this workstream. This document is the "work tracker" entry
required before implementation begins, per the agreed protocol.

Baseline: commit `0b76a8899b1ae373b6647851e88b6cec9770a7ed`
(tag `baseline-pre-device-lifecycle-2026-08-10`), D1 backup at
`backups/d1-local-baseline-2026-08-10.sql` (see `backups/RESTORE.md`).

---

## Amendment 1 resolution — cost data, no duplication

Two options were offered: (a) build `device_costs` now, or (b) treat
`repair_jobs` cost fields as a documented compatibility layer with a
migration path.

**Recommendation: Option (b).** Reasoning:

- The approved first-slice boundaries (Workstream C) list "Repair cost
  entry" as fields ON the repair job, not a separate ledger table — the
  ledger itself is explicitly Workstream D, later in the roadmap.
- Building `device_costs` now, before Workstream D's allocation-method
  logic and the ERP webhook contract are needed, would front-load scope
  the roadmap deliberately deferred.
- A compatibility layer is safe **only if** the eventual migration path
  is fully specified now, so no data is lost or reinterpreted later.
  That specification follows below.

### `repair_jobs` cost fields (first slice — authoritative for now, CONFIRMED field list)

```
repair_jobs.repair_cost_gbp        REAL NULL   -- total repair cost, GBP
repair_jobs.parts_cost_gbp         REAL NULL   -- parts component, GBP
repair_jobs.labour_cost_gbp        REAL NULL   -- labour component, GBP
repair_jobs.cost_source            TEXT NULL   -- e.g. 'MANUAL_MANAGER_ENTRY'
repair_jobs.cost_source_reference  TEXT NULL   -- free-form reference to the
                                                -- source (invoice no., ERP
                                                -- id once that exists, etc.)
repair_jobs.cost_recorded_at       TEXT NULL   -- ISO timestamp cost was recorded
repair_jobs.cost_recorded_by       INTEGER NULL -- users.id of the recording user
                                                -- (explicit field — NOT
                                                -- inferred from qc_by or
                                                -- assigned_to)
```

This is the CONFIRMED, authoritative field list for slice 1 (superseding
an earlier draft that used `parts_cost`/`labour_cost`/`repair_cost`/
`repair_cost_currency` without the `_gbp` suffix and without
`cost_source`/`cost_source_reference`/`cost_recorded_at`/
`cost_recorded_by`). These are the ONLY authoritative record of in-house
repair cost until Workstream D ships. No other table duplicates them in
this slice.

**Slice 1 is GBP-only by design — an intentional interim scope
decision, not an oversight.** All repair-cost fields above are
GBP-denominated; there is no currency or FX-rate field on `repair_jobs`
in this slice. If a repair invoice ever arrives in a non-GBP currency,
the manager enters the GBP-converted figure directly — same discipline
already used for `shipments.repair_cost`/`customs_exchange_rate` in the
OPR module, just deferred rather than duplicated here. The future
`device_costs` ledger (Workstream D) will support original currency, FX
rate, allocation method, and additional cost types beyond in-house
repair — none of that is needed or built in slice 1.

**The supplier ERP webhook is explicitly NOT part of Slice 1.** It is a
Workstream D deliverable; slice 1 has no webhook receiver, no ERP
cost-ingestion path, and no ERP-derived fields on `repair_jobs`.

### Documented migration path to `device_costs` (Workstream D, later)

**Existing slice 1 repair-cost data must be backfillable into
`device_costs` without loss.** When `device_costs` is built, a
migration will backfill one row per existing `repair_jobs` completion:

```
device_costs.device_id        = repair_jobs.device_id
device_costs.imei             = repair_jobs.imei
device_costs.cost_type        = 'INHOUSE_REPAIR'
device_costs.amount           = repair_jobs.repair_cost_gbp
device_costs.currency         = 'GBP'   -- slice 1 is GBP-only; see above
device_costs.fx_rate          = NULL    -- no FX in slice 1 by design
device_costs.amount_gbp       = repair_jobs.repair_cost_gbp
device_costs.source           = repair_jobs.cost_source
device_costs.source_reference = repair_jobs.cost_source_reference
device_costs.allocation_method = 'MANUAL_MANAGER_ENTRY'
device_costs.created_by       = repair_jobs.cost_recorded_by   -- explicit
                                                                -- field, no
                                                                -- longer TBD
device_costs.created_at       = repair_jobs.cost_recorded_at
```

The explicit `cost_source`/`cost_source_reference`/`cost_recorded_at`/
`cost_recorded_by` fields on `repair_jobs` exist specifically so this
backfill is lossless and unambiguous — no field on the future
`device_costs` row needs to be inferred, guessed, or defaulted from an
unrelated column (e.g. `qc_by`).

From that point forward, new repair completions write to `device_costs`
directly; `repair_jobs`'s own cost columns become a read-only cached
snapshot (kept for backward-compatible queries/UI, never the source of
truth again). **No repair_jobs row is ever deleted or altered by this
future migration — it is additive only.**

### Freight allocation rule — preserved, not implemented

```
Device freight = Total freight × (Device purchase value ÷ Total purchase
                                   value for the shipment)
```

Recorded here for Workstream D. Not implemented in slice 1 — no freight
cost entry exists in this slice at all.

### ERP precedence rule — preserved, not implemented

**When the supplier ERP later provides an authoritative per-IMEI cost,
that ERP value takes precedence over an app-calculated allocation** and
MUST NOT be recalculated or overridden by an app-side allocation.
Recorded here for Workstream D's design; not applicable until the
webhook exists (the webhook itself is out of scope for slice 1 — see
above).

---

## Amendment 2 resolution — QC auditability

**Decision: separate `QC_FAILED` and `HOLD` states**, not a single
overloaded `HOLD`. Reasoning: `HOLD` per the original spec draft was
meant to also cover non-QC holds (e.g. a device paused for an unrelated
reason); collapsing QC failure into it would make "why is this on hold"
ambiguous exactly where the amendment asks for it not to be. Two states
keep QC failure specifically legible in the ledger and on the device
record without inspecting `repair_jobs.qc_result` separately.

**Confirmed QC rules for slice 1 (explicit statement):**

- `QC_FAILED` is a separate status — it is never overloaded onto a
  generic `HOLD`.
- Generic `HOLD` is **not included** in slice 1 at all (see below).
- A `QC_FAILED` result **requires a mandatory reason.** The reason is
  not optional metadata — the QC-fail endpoint must reject a request
  that omits it, and `repair_jobs` must persist the reason value
  alongside `qc_result = 'FAILED'`.
- A device can enter `READY_FOR_ZOHO` **only after a successful QC
  result** (`qc_result = 'PASSED'`, plus the other gate conditions
  below).
- A failed or incomplete QC result (`FAILED` or `PENDING`) **cannot**
  enter the Zoho queue — only `READY_FOR_ZOHO` devices are eligible.

### New device statuses (Workstream B, slice 1 only)

```
READY_FOR_ZOHO
QC_FAILED
```

`HOLD` (generic) is NOT added in this slice — out of scope per the
approved boundaries ("no OPR return-state changes yet" and no other
non-repair hold scenario exists yet to justify it). If a future
workstream needs a non-QC hold, it will be added then, not preemptively.

### New transition edges (slice 1 only)

```
SORTING          → IN_HOUSE_REPAIR        (unchanged, already exists)
IN_HOUSE_REPAIR  → READY_FOR_ZOHO         (NEW — QC passed)
IN_HOUSE_REPAIR  → QC_FAILED              (NEW — QC failed; MANDATORY reason
                                            required on this transition, see
                                            "Confirmed QC rules" above)
QC_FAILED        → IN_HOUSE_REPAIR        (NEW — re-open for further repair;
                                            required so a failed device is
                                            not a dead end)
```

`IN_HOUSE_REPAIR → ACTIVE_INVENTORY` (the current direct edge) is
**removed** for devices going through the new repair-job flow — see next
section for how this interacts with the existing generic transition
endpoint.

### QC outcomes (on `repair_jobs.qc_result`)

```
PASSED
FAILED
PENDING   -- default until QC is recorded; scan-back does NOT itself set
             a QC result — QC is a distinct, separate action per the
             approved boundaries ("QC pass/fail" is its own step after
             "scan-back")
```

### Gate for entering `READY_FOR_ZOHO` (all must hold)

1. Repair job `status = 'completed'` (repair itself finished)
2. `qc_result = 'PASSED'` — a `FAILED` or still-`PENDING` result blocks
   this transition outright; there is no path from `QC_FAILED` straight
   to `READY_FOR_ZOHO` (a fresh scan-back/QC cycle is required)
3. Required device data present (imei, model, capacity/grade — same
   fields OPR's `runExportValidation` already treats as mandatory
   elsewhere, reused here rather than inventing a new rule set)
4. Valid SKU mapping exists (`received_devices.sku` resolves in
   `sku_catalog` — reusing the existing catalog, not a new table)
5. No open conflicting movement: device is not currently on any DRAFT/
   open OPR consignment line, not already `SOLD`/`DESPATCHED`/`REJECTED`

Any failure of 1–5 blocks the transition; the endpoint returns 409/422
with the specific unmet condition, mirroring the existing
`runExportValidation`/`runImportValidation` pattern of explicit, named
checks rather than a single opaque rejection.

### Interaction with the existing generic `/api/devices/:id/transition` endpoint

`IN_HOUSE_REPAIR`, `READY_FOR_ZOHO`, and `QC_FAILED` will be added to
`OPR_WORKFLOW_ONLY_STATUSES`-style protection — i.e. a new
`REPAIR_WORKFLOW_ONLY_STATUSES` guard, same pattern as the existing OPR
one, so a raw `POST /transition` call cannot desynchronise a device from
its `repair_jobs` row. Only the new repair-job endpoints may drive these
three statuses. `ACTIVE_INVENTORY` remains reachable via the generic
endpoint for devices NOT in an active repair job (unchanged).

---

## Test plan (work-tracker entry — to be implemented next, pending go-ahead)

All new tests assert HTTP response AND database state, per instruction.
No test in this list has been written yet.

### A. OPR Phase 0 regression tests (previously agreed, still pending)
1. `90 + 72 = 162` discharge/value-balance regression (already covered by
   existing Ticket B tests — confirm still green, add explicit named
   regression test if not already isolated)
2. `£22,588 + £16,798 = £39,386` value reconciliation regression
3. PC 2100 + B51 rejected (`validateProcedureCodes`)
4. IMEI uniqueness within a shipment
5. Declaration-text charset/length validation
6. Finalisation blocking rules (`runExportValidation`/`runImportValidation`
   red-result gate)
7. Return IMEI accepted when it belongs to the parent export
8. Return IMEI from another export rejected (409), confirm no
   `shipment_lines` row created
9. Same IMEI cannot be added to two open (DRAFT) returns (409), confirm
   second return's line count unchanged
10. Device cannot be reused in a new export/return after finalisation
    without a legitimate transition back to `READY_FOR_EXPORT`

### B. Baseline lifecycle tests (existing transitions, pre-change)
11. Every currently-defined edge in `ALLOWED_TRANSITIONS` succeeds when
    invoked correctly (one test per edge, table-driven)
12. Every attempted edge NOT in `ALLOWED_TRANSITIONS` is rejected with
    `InvalidTransitionError`
13. `OPR_WORKFLOW_ONLY_STATUSES` cannot be set via
    `POST /api/devices/:id/transition` (existing 409 guard)
14. `transitionDevice()` writes exactly one `device_events` row per call,
    atomically with the status update (D1 batch — no partial writes)

### C. New repair-workflow tests (slice 1)
15. Start repair with an unknown/invalid IMEI → 404/422, no `repair_jobs`
    row created
16. Start repair without a fault code → 422, no `repair_jobs` row created
17. Start repair on a device that already has an open repair job → 409,
    no second `repair_jobs` row created, existing job unchanged
18. Start repair on a `SOLD`/`DESPATCHED`/`EXPORTED_UNDER_OPR` device →
    409, no `repair_jobs` row created, device status unchanged
19. Start repair on a valid `SORTING`/`ACTIVE_INVENTORY` device with a
    fault code → 201, `repair_jobs` row created with correct fields,
    device status → `IN_HOUSE_REPAIR`, exactly one new `device_events`
    row with `event_type = 'SENT_TO_INHOUSE_REPAIR'`
20. Scan-back without an open repair job for that device → 409, no state
    change
21. Scan-back with an open job, QC not yet recorded → job moves to
    "awaiting QC" state, device remains `IN_HOUSE_REPAIR` (QC is a
    separate action per the design)
22. Recording QC `FAILED` → device → `QC_FAILED`, `repair_jobs.qc_result
    = 'FAILED'`, `repair_jobs.qc_by`/`qc_at` set, one `device_events` row
    (`RECEIVED_BACK_FROM_INHOUSE_REPAIR` or equivalent), device does NOT
    reach `READY_FOR_ZOHO`
23. Recording QC `PASSED` → device → `READY_FOR_ZOHO`, same job/event
    bookkeeping as above, gate conditions (SKU mapping etc.) verified
24. QC `PASSED` but SKU mapping missing → transition blocked, explicit
    error naming the unmet gate condition, device stays `IN_HOUSE_REPAIR`
25. Repair cost entered (parts + labour) → `repair_jobs.repair_cost`
    correctly computed and linked to the correct `device_id`/`imei` —
    confirm querying by IMEI returns exactly this job's cost, not another
    device's
26. `QC_FAILED` device can re-enter `IN_HOUSE_REPAIR` (re-open) but a
    fresh scan-back/QC cycle is required — cannot skip straight to
    `READY_FOR_ZOHO` from `QC_FAILED`

### D. Zoho upload queue tests (slice 1)
27. Generating a Zoho file with N selected `READY_FOR_ZOHO` devices →
    file/batch record created containing exactly those N IMEIs, no more,
    no fewer
28. Generating the file does NOT change any device's status — confirm
    all N devices remain `READY_FOR_ZOHO` immediately after generation
29. A device not in `READY_FOR_ZOHO` cannot be included in a batch (e.g.
    still `IN_HOUSE_REPAIR` or `QC_FAILED`) → excluded/rejected
30. Manager confirms upload → batch status updated, confirmation is
    manager-role-only (operator role → 403)
31. Repeating the same confirmation call → idempotent, no duplicate
    upload-result row, no duplicate audit event
32. Upload marked as failed/retry → batch status reflects failure, does
    not silently retry N times or corrupt IMEI membership
33. A device still does NOT move to `ACTIVE_INVENTORY` purely from being
    in a confirmed-uploaded batch — that transition is out of scope for
    this slice per the explicit boundary ("no device marked
    ACTIVE_INVENTORY merely because a file was generated")

---

## Explicit scope boundary (unchanged, restated for the tracker)

Out of scope for slice 1: `device_costs` table, ERP webhook, Pack and Go
integration, Zoho API integration, OPR return-inspection states
(`OPR_REPAIR_CANDIDATE`, `RETURN_INSPECTION`), generic `HOLD`, any
`ACTIVE_INVENTORY` transition change beyond what's needed to remove the
old direct `IN_HOUSE_REPAIR → ACTIVE_INVENTORY` edge.

## Next step

Pending your confirmation of the Amendment 1 resolution above (option b,
compatibility layer), implementation proceeds in this order:
1. Write tests A1–A10, confirm current code passes/fails as expected
2. Write tests B11–B14, confirm current code passes as expected
3. Write tests C15–C33 against not-yet-built code (expected to fail/not
   compile until the migration + endpoints exist)
4. Only then: first migration (`repair_jobs` table, new device statuses,
   new transition edges) + application code to make C15–C33 pass
