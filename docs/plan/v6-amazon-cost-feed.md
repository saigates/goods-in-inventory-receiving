# V-6 — Amazon read-only cost feed

Status: **SCOPED, NOT BUILT.** Sprint 2 (opens 9 Oct), after Y-1/Z-7/Z-10,
unblocked by Z-5. This document exists so the decisions already made about
this ticket — in conversation, across the Z-5 merge/deploy pass and the two
review passes that followed it — survive the sprint boundary and do not have
to be re-derived (or silently re-decided differently) by whoever actually
opens the ticket. Per the operator's explicit instruction (2026-09-27): this
is a spec with a scheduled deliverable behind it, not a placeholder, and
Z-16's own through-line — a fact that was only ever true in someone's head,
not in a file — is the reason it is being written now rather than held.

## What this endpoint is

A **read-only** cost/stock feed for Amazon, in the same family as V-2 (not
yet built either, but assumed to share the same auth pattern per the
operator's scope note). No write path exists at the route level — this
route only ever reads `received_devices` (and the exclusion joins below) and
returns JSON. It does not create, update, or delete anything, and it does
not itself call out to Amazon; it is the side Amazon (or whatever pulls on
Amazon's behalf) calls in to.

## Route and auth

- `GET /api/cost-feed`
- Bearer auth via a **scoped service token**, shared with V-2 (i.e. the same
  token type/verification path V-2 uses, not a new one invented for this
  ticket alone) — not the regular per-user JWT auth wall the rest of
  `/api/*` uses (see `src/index.tsx:26` and `src/lib/auth.ts`). The exact
  token issuance/storage mechanism is V-6's own build-time decision; this
  note only fixes that it must be a scoped service token, shared with V-2's
  pattern, not a per-user credential.

## Payload shape

Per device row, exactly:

- `IMEI`
- `SKU`
- `grade`
- `status`
- `location`
- `acquisition_cost_gbp`
- `total_cost_gbp`
- `acquisition_source` — the Z-2 source flag, exactly as
  `computeDeviceCostBreakdown()` already returns it
  (`docs/plan/z2-acquisition-cost.md:69`, values
  `'cost_ledger' | 'goods_in_buy_price' | 'none'`). Reuse this field name
  and these three values verbatim — do not invent a new name or a
  different value set for this route.

No other fields. In particular: no raw cost-ledger rows, no shipment/
consignment detail beyond what `status`/`location` already imply, no
internal IDs beyond what's needed to key the row (IMEI is the natural key
Amazon-side).

**Fallback-costed devices are provisional, because this is a computed
read, not a stored figure.** Per Z-2's own design
(`docs/plan/z2-acquisition-cost.md:54-71,160`),
`acquisition_cost_gbp`/`total_cost_gbp` are never written to a column —
they are recomputed at read time from `cost_ledger` (or the goods-in
`buy_price` fallback when no ledger row exists yet). A device returned
with `acquisition_source: 'goods_in_buy_price'` or `'none'` today can
change its cost — and therefore its `total_cost_gbp` — the moment a bill
posts a `cost_ledger` row for it, with no event firing to tell V-6's
caller that happened. Any consumer of this feed (Amazon-side pricing
logic in particular) must treat a non-`'cost_ledger'` `acquisition_source`
as **provisional**, not final, and should expect the number to move
without notice until a real ledger entry lands.

## The four decisions already made, verified against the code as it stands

These four were reached and checked in conversation before this file
existed; each is recorded here with the citation it was verified against so
the next person does not have to re-derive or re-trust them from memory.

### 1. Status exclusion set: `OPR_WORKFLOW_ONLY_STATUSES`, used as-is

V-6 excludes on **status**, not on `deviceLocation()`/
`LOCATION_ABROAD_STATUSES` — see operator §2 (2026-09-27 pass, prior to this
doc) for the full reasoning: `deviceLocation()` is display-only, and a
`location === 'Warehouse'` filter would wrongly include
`IN_EXPORT_CONSIGNMENT` (packed, committed to an outbound consignment, not
yet physically gone) and both `RETURNED_*` statuses (physically back, not
yet restocked) — neither is sellable despite reading `'Warehouse'`.

Verified this pass: `OPR_WORKFLOW_ONLY_STATUSES` at
`src/lib/deviceLifecycle.ts:170-178` already contains exactly the required
five —

```
170: export const OPR_WORKFLOW_ONLY_STATUSES: readonly DeviceStatus[] = [
171:   'IN_EXPORT_CONSIGNMENT',
172:   'EXPORTED_UNDER_OPR',
173:   'RETURNED_UNDER_OPR',
176:   'TEMP_EXPORTED_STANDARD',
177:   'RETURNED_UNDER_STANDARD',
178: ] as const
```

— and cross-checked against the full 14-value `DeviceStatus` union
(`src/types.ts:84-109`) to confirm nothing else export/return-adjacent sits
outside it. Nothing else needed excluding on this axis except the open
question in item 4 below. **V-6 imports and uses this constant directly —
it does not need its own status-exclusion list.**

### 2. Ungraded predicate: reuse the existing A/B/C allow-list, not a null test

Grade is not nullable — it is the literal string `'UG'` by default (never
absent), so an ungraded-exclusion test written as "grade IS NULL" would
silently pass every ungraded device straight through. The correct
comparison already exists and is enforced elsewhere for the same business
rule (Zoho-readiness), at `src/lib/repairWorkflow.ts:163-165`:

```
163:   if (grade !== 'A' && grade !== 'B' && grade !== 'C') {
164:     return `Device has grade '${grade}' — only A, B, or C may reach Zoho`
165:   }
```

Manifest 17's 111 units (the Ungraded investigation, Sprint 1) were
uniformly `condition='RAW', grade='UG'` — the real-world case this
comparison exists to catch. **V-6 reuses this exact comparison** (or calls
into whatever shared helper wraps it, if one exists by build time) rather
than re-deriving an allow/deny list independently. Two predicates
encoding the same business rule in two places is exactly the drift shape
Z-16 documents (`docs/plan/z16-convention-drift.md`) — here the fix is free
because the allow-list already exists and only needs importing.

### 3. Zoho-batch-committed exclusion: its own predicate, not derived from status or grade

A device already committed to a Zoho batch (i.e. present in
`zoho_batch_devices`, per Z-6's correction-lock ticket) is not expressed by
`OPR_WORKFLOW_ONLY_STATUSES` or by the grade allow-list — it is a separate
fact, keyed by a join against `zoho_batch_devices`, not a device-status or
device-grade value. V-6 needs its own exclusion clause for this (a
`NOT EXISTS`/anti-join against `zoho_batch_devices` on device id, or
equivalent) — this is real, net-new predicate logic for V-6 to write; no
existing helper covers it, and this note does not claim otherwise.

### 4. `READY_FOR_EXPORT` — open question, not a ruling

`READY_FOR_EXPORT` sits outside `OPR_WORKFLOW_ONLY_STATUSES` by design (it
is the shared precursor before a device is committed to any consignment,
per `src/types.ts:88-89` and the `ALLOWED_TRANSITIONS` table at
`deviceLifecycle.ts:81`) — in the abstract, "not yet committed to a
consignment" reads as sellable.

In practice, in this operation, a device reaching `READY_FOR_EXPORT` is
earmarked for Syncere. Listing it on Amazon risks a sale against a unit
already staged onto an export manifest — an oversold listing costs a
cancellation; an unnecessarily-excluded listing costs nothing. The
asymmetry favours excluding it, but **this is flagged as an open question
for the operator, not decided here.** Whoever opens V-6's ticket must put
this to the operator explicitly before shipping the exclusion list, rather
than defaulting either way silently.

## Non-goals

- No write path. This route never mutates `received_devices`,
  `zoho_batch_devices`, or any other table.
- No order-pull integration (that is Amazon's own future rehoming stage —
  see `docs/plan/zoho-replacement-roadmap.md` stage (iv) — and explicitly
  out of scope for this ticket, which is stock-feed only).
- No new status-exclusion list invented independently of
  `OPR_WORKFLOW_ONLY_STATUSES` (see decision 1).
- No new grade-comparison logic invented independently of
  `repairWorkflow.ts`'s existing allow-list (see decision 2).

## What is still genuinely open at build time

- The exact shared-service-token mechanism with V-2 (issuance, storage,
  verification) — not fixed here, V-2 doesn't exist in the codebase yet
  either (`grep -rn "V-2" src/` returns nothing at the time of writing).
- The `zoho_batch_devices` anti-join predicate (decision 3) — real logic,
  not yet written.
- The `READY_FOR_EXPORT` question (decision 4) — needs an explicit operator
  answer before ship.
- What the feed returns when `acquisition_source` is `'none'` — a device
  with no `cost_ledger` purchase row AND no `buy_price` has
  `acquisition_cost_gbp: null` (`src/lib/acquisitionCost.ts:63`), and
  `computeDeviceCostBreakdown()` silently treats that null as `0` inside
  `total_cost_gbp` (`acquisitionCost.ts:91`). Whether V-6 passes `null`
  through as-is, substitutes `0`, or excludes `'none'`-sourced devices
  from the feed entirely is not decided here — flagged for build time.
