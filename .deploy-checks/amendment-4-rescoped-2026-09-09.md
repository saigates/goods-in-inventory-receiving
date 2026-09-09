# Amendment 4, re-scoped (2026-09-09) — can a Quick Receive device ever be freight-allocated?

**Original framing (retracted)**: "what would it take to make a manifest
mandatory on `/scan/manual`?" — wrong question. `/scan/manual` (Quick
Receive, `source='manual'`) is *deliberately* manifest-free; making a
manifest mandatory there would break an intended workflow, not fix a
gap. No such report was written.

**Re-scoped question**: a Quick Receive device can never carry
manifest-scoped inbound freight at the moment it's received, so what
happens to it at valuation? Two candidates were posed:
- (a) it CAN be retrospectively attached to a manifest later, tolerating
  allocation arriving after the fact; or
- (b) it CANNOT — permanently freight-unallocatable, needs its own
  reporting category.

## Finding 1 — `manifest_id` is never UPDATEd anywhere in the codebase today

Exhaustive grep, `manifest_id` as a write target, across every file
under `src/routes/*.ts` and `src/lib/*.ts`:

```
grep -n "manifest_id" src/routes/*.ts src/lib/*.ts | grep -iv "SELECT\|WHERE\|AS \|const \|type \|//\|json("
```

Every hit is either a read (`WHERE manifest_id = ?`), a bind parameter
for an INSERT, or a TypeScript field name. **Zero matches for `UPDATE
... SET manifest_id`** anywhere. The only three `UPDATE received_devices`
call sites in the whole codebase are:
- `src/routes/inventory.ts:292` — `SET grade = ?, sku = ?` (grade
  correction)
- `src/routes/inventory.ts:357` — `SET sku = ?` (SKU correction)
- `src/lib/deviceLifecycle.ts:290` — `SET status = ?, updated_at = ...`
  (lifecycle transition)
- `src/routes/print.ts:309/378/646` — `SET label_printed_at = ...`

None touch `manifest_id`. `manifest_id` is written exactly once, at
INSERT time, on three intake paths (`scan.ts` `/confirm`, `/force-add`;
`manifests.ts`'s own manifest-line insert) — `/manual`'s INSERT doesn't
even include the column in its column list (confirmed already, prior
turn), so it's implicitly `NULL` and stays `NULL` forever under current
code.

## Finding 2 — no route exists whose purpose is "attach a manifest after the fact"

Full endpoint inventory of the three files that could plausibly host
this (`manifests.ts`, `scan.ts`, `inventory.ts`):

```
manifests.ts: GET /, GET /:id, POST /, POST /:id/apply-sku-to-batch,
              POST /:id/close, POST /:id/reopen, DELETE /:id
scan.ts:      POST /, POST /confirm, POST /bulk, POST /force-add,
              POST /manual, POST /reject, GET /events/:manifestId
inventory.ts: GET /, DELETE /:id, POST /grade, GET /sku-grade-consistency,
              GET /removal-flags, POST /removal-flags/:id/resolve,
              GET /grade-audit/:id, GET /stats
```

Nothing here reassigns `manifest_id` on an existing row. `apply-sku-to-
batch` only writes `expected_devices.sku`, scoped to a `manifest_id`
that's already fixed on the WHERE clause, not received_devices at all.

## Finding 3 — no schema barrier blocks adding this later, either

`received_devices.manifest_id` (`migrations/0023b` line 305, latest
recreate) is a plain nullable `INTEGER` with `FOREIGN KEY (manifest_id)
REFERENCES manifests(id) ON DELETE SET NULL` — no `CHECK`, no trigger,
nothing that would reject a future `UPDATE received_devices SET
manifest_id = ? WHERE id = ? AND manifest_id IS NULL`. Grepped every
migration file for any `TRIGGER` touching `received_devices` or
`manifest` — zero hits (`migrations/0023b`'s own "TRIGGER completeness"
comment at line 191 is prose, not a trigger definition).

## Finding 4 — freight/customs allocation is itself entirely unwired, and doesn't key on `manifest_id` yet either

`apportionFreightByValue` (`src/lib/freightApportionment.ts:51`) and
`apportionCustomsByValue` (`src/lib/customsApportionment.ts:79`) are
pure functions with **zero call sites outside their own test files** —
confirmed:

```
grep -rn "apportionFreightByValue\|apportionCustomsByValue" --include="*.ts" .
```

only returns their own definitions and `test/*.spec.ts`. The one table
that exists for owner-paid freight, `freight_invoices`
(`migrations/0028` line 200), keys on `shipment_id` (an export/return
consignment leg), **not** `manifest_id` — this is the acquisition-side/
export-side split already documented in `0033`'s own header ("inbound
PURCHASE freight ... is keyed on `manifests`, not `shipments`"). There
is currently **no table at all** that links a manifest to a freight
charge — that's exactly the still-unbuilt `goods_in_freight_bill_manifests`
link table from the ⚪ queue. So today, a manifest_id alone doesn't
connect a device to any freight figure regardless of whether that
manifest_id is null or set.

## Verdict: neither (a) nor (b) is built. The schema leans toward (a) being the cheaper direction, not (b)

This is genuinely **undecided/unbuilt** territory, not a design that
already picked one of the two answers — there is no code path today
that performs retrospective attachment (so (a) isn't a working feature
yet), and there is no report or flag anywhere that classifies a
`manifest_id IS NULL` device as "permanently unallocatable" (so (b)
isn't implemented as a category either — `reports.ts`'s valuation
endpoint doesn't reference `source` or `manifest_id` at all today).

But architecturally, (a) is the path of least resistance:
- `manifest_id` is nullable and freely updatable — nothing needs to be
  torn down or overridden to allow a later `UPDATE`. Building (a) means
  ADDING a new capability (a route to set it, plus a decision on
  re-running apportionment for a consignment a device joined late).
- Building (b) properly would mean ADDING a new enforced rule
  ("once a device is created with `source='manual'`, it is permanently
  excluded from any future manifest_id assignment") — there's no such
  rule today, so calling these devices "permanently unallocatable"
  would be describing a policy that isn't actually enforced anywhere,
  not stating a fact about the schema. That's a materially different,
  weaker claim than the (a)-side finding above.
- The freight-apportionment functions already require "every device in
  the consignment is priced" before running (rule 1, both modules) and
  the user's own framing already treats re-running apportionment as "an
  explicit act" — consistent with a design where a device attaching to
  a manifest late just means the manifest's (future) freight-bill link
  needs re-apportioning, not a structural impossibility.

**Caveat that must be carried forward**: because
`goods_in_freight_bill_manifests` doesn't exist yet, attaching a
`manifest_id` to a Quick Receive device does not, by itself, make it
freight-costed under current code — that also depends on whether the
manifest it gets attached to is (or later becomes) linked to a freight
bill via that still-unbuilt table, and whether the linking happens
before or after that bill's apportionment run. This can't be fully
closed out until that link table's design is actually written (queued,
comes after `/imports` and the mapping/orphans view per the stated
order) — recording the dependency here so that design doesn't have to
rediscover it.

## Coverage check re-keyed on `source` (live production numbers, read this pass)

Queried live production (`gsk hosted d1_query`, bracketed by
`gsk login-info` before/after — identity stable,
`saigateslimited@gmail.com`, no retry needed):

```sql
SELECT source, COUNT(*) AS n,
       SUM(CASE WHEN manifest_id IS NULL THEN 1 ELSE 0 END) AS no_manifest
FROM received_devices GROUP BY source;
```

```
source        n     no_manifest
manifest      1133  0
manual        2     2
```

(`unreconciled` returns no row — zero such devices currently in
production.) This maps cleanly onto the three-bucket design:
- **`'manual'`** — 2 devices, both correctly `manifest_id IS NULL`.
  Expected exclusion, report as a count (matches ids 1136/1137 already
  found in the earlier Amendment 4 pass).
- **`'unreconciled'`** — 0 devices today. Backlog figure, currently
  clean; should be watched over time as `/scan/force-add` gets used.
- **`'manifest'`** — 1133 devices, all 1133 correctly carry a
  `manifest_id`. Zero manifested-but-unallocated rows today — the real
  alarm bucket is currently empty, which is the expected healthy state
  (no manifested device should ever lack its `manifest_id`, since
  `scan.ts`'s `/confirm` path always copies it from the matched
  `expected_devices` row).

No `scan.ts` change made or needed for this reading — this is a report/
query shape, not an intake-path change, per the standing instruction.

**Not yet decided**: whether this three-bucket check becomes a
persistent field on `GET /api/reports/inventory-valuation` (alongside
the existing `exclusions`/`data_quality` blocks) or stays an ad-hoc
`gsk hosted d1_query` run when needed. That's a reporting-surface
decision, not investigated further this pass — flagging it rather than
silently picking one.
