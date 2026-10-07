# Z-24 — OPR batch register vs. what the OPR module can represent (scoping only, no code)

**Provenance note**: as with Z-22/Z-23, this ticket number has no prior
trace in this repo (zero grep/log matches before this file) and was not
issued by this agent in any earlier turn. Scoping the real gap the
operator described regardless, since — like Z-22/Z-23 — it stands on its
own merits once checked against the live system.

**Source of the external figures below**: the operator's own message
(543 units / batches 002, 004, 005 / ~£100,488 declared; batch 003's
import MRN `26GBB1ZHCRV9UEHAR8`; batch 005 at 218 units / £42,410.51
shipped entirely outside the app). This agent has no independent access
to that batch register — it exists outside this repo and outside
production D1. Everything below is the app's own live data compared
against those operator-supplied figures as given, not independently
verified against a source document this agent can see.

## What currently exists in the OPR module (production D1, live-queried)

Three shipments total, ever:

| id | reference | direction | status | lines | repair_cost |
|---|---|---|---|---|---|
| 1 | `OPR20260826003` | export | FINALISED | 155 | — |
| 2 | `OPR20260917004` | export | DRAFT | 125 | — |
| 3 | `877564146355` (import, related to #1) | import | DRAFT | 155 | 20,627.21 |

`partial_return_declarations` — **zero rows**. No partial return has ever
been declared through this module.

Devices at export-exposure statuses: 155 `EXPORTED_UNDER_OPR` + 125
`IN_EXPORT_CONSIGNMENT` = **280 devices total**, and all 280 are linked to
a `shipment_lines` row (confirmed: `COUNT(DISTINCT received_device_id)
FROM shipment_lines` = 280, matching exactly). So the app's own device
tracking and its own shipment-line tracking agree with each other — there
is no internal inconsistency. The gap is between this internally-coherent
280 and the operator's external total.

## The gap, stated plainly

**280 devices tracked in the app vs. 543 units in the real batch
register** — the app currently represents, at most, half of what the
operator says is actually open. Three shipments exist; the operator named
three DIFFERENT batch numbers (002, 004, 005) that don't obviously map
onto shipment IDs 1/2/3 by any naming convention visible in this schema
(shipments are keyed by `reference` — `OPR20260826003`,
`OPR20260917004`, and a bare AWB-looking number `877564146355` — none of
which contain "002", "004", or "005" as a recognisable batch token).
**This agent cannot confirm which, if any, of the 3 existing shipments
corresponds to which of the operator's 3 named batches** — that mapping
needs the operator's register, not something inferable from the DB alone.

## Batch 003 — import MRN landed, but the app doesn't know about it yet

Per the operator: batch 003's import MRN is `26GBB1ZHCRV9UEHAR8`,
re-imported 06/10, flagged "value/PC to correct." Checked production:
**no shipment in this database has `import_mrn = '26GBB1ZHCRV9UEHAR8'`**
(only shipment 3 has a non-null `import_mrn` field at all, and it's
currently null — the field exists on the schema but isn't populated for
any of the 3 live shipments). So batch 003, whatever it is, is not
shipment 3 by import_mrn match, and isn't represented by any existing
shipment row at all. If batch 003's export leg used the wrong procedure
code (not just the wrong value), the schema has no field that
distinguishes "discharged" from "undischarged independent of value" other
than the shipment's own `status` — there's no separate flag for "goods
physically returned but customs entry not yet cleared," which is exactly
the state the operator describes as a live risk.

## Batch 005 — by definition, cannot be checked against this database

218 units, £42,410.51, shipped entirely outside the app because the stock
was never in goods-in. This agent queried `received_devices` for any
device that might correspond — but a device that never passed through
goods-in **has no row to find**. This is not a zero-result query that
proves absence; it's a structural blind spot — the app has literally no
table that would record a unit that was never received through it. The
operator's own framing ("no device records, no consignment, no tracked
discharge deadline") is the only source of truth for batch 005's
existence; this agent can neither confirm nor refute it from inside the
database, only confirm that the database has nothing that could.

## What the OPR module CAN represent today, read directly from the schema

- **One shipment = one consignment**, `direction` export|import,
  `status` DRAFT|FINALISED|CANCELLED. No concept of a "batch" distinct
  from a shipment — if 002/004/005 are meant to be three separate
  trackable units, they'd need to be three separate `shipments` rows (or
  some new grouping concept above shipment, which doesn't exist).
- **`shipment_lines`** ties a device to a shipment at add-time (frozen
  snapshot). A device with no goods-in record cannot have a
  `shipment_lines` row, by foreign-key necessity (`received_device_id
  REFERENCES received_devices(id)`) — this is the structural reason
  batch 005 is unrepresentable as-is, not a bug, a direct consequence of
  the schema's own invariant that a shipment line requires a prior
  goods-in device.
- **`partial_return_declarations`** exists and is wired (per the §2
  triage, it's a "wire" candidate — built, tested, unused) but currently
  has zero rows — it's the mechanism that WOULD let a batch be
  split-tracked as it returns in increments, but nothing has used it yet.
- **No separate "discharge status independent of shipment status"
  field** — `GET /discharge` (mentioned in the README) computes a tracker
  view from existing shipment/line data rather than reading a persisted
  discharge-state column, so if batch 003 needs a customs-side amendment
  that the Goods-In side can't yet see, there's nowhere in this schema to
  record "amendment pending" as a state.

## Scoping conclusion — this is bigger than a missing shipment or two

Representing the real 5-batch, 543-unit picture would need, at minimum:
1. A reliable mapping from the operator's batch numbers to either
   existing or new `shipments` rows (needs the operator's register, not
   derivable from the DB).
2. A way to represent batch 005's 218 units despite having no goods-in
   history — either a backfill into `received_devices` (retroactively,
   which has its own risk of misrepresenting when those devices were
   actually received) or a new, lighter-weight "external batch" concept
   that doesn't require the full device lifecycle.
3. A field or table to record "customs amendment pending/in-progress" on
   a shipment independent of its own DRAFT/FINALISED status, for batch
   003's situation specifically.
4. Decide whether `partial_return_declarations` (already built, unused)
   is the right mechanism to activate for the batches that DO have normal
   goods-in device records, before building anything new for the ones
   that don't.

This note scopes the shape of the gap; it does not propose which of these
four to build first or estimate effort. That's the next decision, not
made here.
