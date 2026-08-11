# Future Workstream — Zoho Replacement & Integrated Inventory + Accounting Connection

Status: **DOCUMENTATION / SCOPE TRACKING ONLY.** No code, schema, migration,
or implementation exists yet for this workstream. This entry records the
roadmap and design requirements agreed so far, so the boundary is written
down before any of the two currently-active workstreams (OPR Auth Batch,
Device Lifecycle slice 1) drift into overlapping it.

This is deliberately a **separate, later, staged initiative** — not part of
either currently-active workstream, and not authorised for implementation
by this document. It exists so future work has a stable reference point and
so "replace Zoho" scope creep doesn't get silently absorbed into either
active workstream's tickets.

## Confirmed fact — no live VAT-return risk

**Zoho is not the VAT/accounting book of record for this business.** This
was confirmed as a fact, not an assumption, before any of the staging below
was agreed. It means: replacing/rehoming Zoho's stock-tracking and
order-pull role carries no live VAT-return risk — the actual VAT/accounting
book of record is elsewhere and is untouched by this roadmap. This fact is
what makes staged replacement safe to plan; it does not, by itself, licence
skipping the parallel-run proof step below.

## Staged plan (in order)

1. **Build inventory + purchasing to full trust**, including a new
   **create-a-bill** flow:
   - VAT type lives on the **bill**, not on a device or a manifest row.
   - The manifest hangs off the bill (a bill can have one or more
     manifests attached; the manifest is evidence/detail under the bill,
     not a parallel record of its own VAT type).
   - Device receiving continues via the existing Goods In flow unchanged —
     this stage does not alter `POST /api/scan/*` or the receiving UI.
2. **Run parallel with Zoho** to prove data integrity before any cutover.
   Both systems ingest the same real transactions; discrepancies are
   reconciled and closed before trusting either system alone. No cutover
   date exists yet — this stage is a precondition for stage (iv), not a
   fixed-duration formality.
3. **Rehome Back Market** — already largely routed via Pack and Go, so this
   stage is scoped as *completing* that rehoming, not starting fresh
   integration work from zero.
4. **Rehome Amazon** (stock feed + order pull) **as its own scoped
   project** — this is explicitly called out as **the gate for switching
   Zoho off**. Zoho is not turned off until Amazon's stock-feed and
   order-pull integration has its own project, scope, and sign-off; this
   roadmap entry does not pre-authorise that project's design.
5. **Later and separately: connect the firm's own accounting system.** This
   is intentionally sequenced after (i)–(iv), not concurrent with them, and
   is its own future scoping exercise.

## Design requirement — audited, non-overwritable financial record (day one)

From the very first line of code in stage (i), the following three fields
must be treated as an **audited, non-overwritable financial record**:

- The **VAT type** recorded on the bill.
- **The bill** itself (its existence, contents, and any amendment history).
- **The purchase cost** recorded against the bill.

"Non-overwritable" means: once written, a correction is a new row
referencing the old one (an append-only correction/delta pattern — the same
discipline already used for `shipment_value_deltas` in the OPR workstream,
migration `0019_shipment_value_reconciliation.sql`), never an `UPDATE` that
loses the original value. This requirement is a **design constraint for
whenever stage (i) is actually built**, not a retroactive change to any
existing table today — no existing schema currently implements a bill/VAT
type/purchase-cost record of this kind, so there is nothing to migrate for
this requirement yet; it governs the schema that stage (i) will introduce.

## Explicit non-goals of this document

- Does not authorise writing `bills`, `purchase_costs`, or any related
  schema today.
- Does not authorise touching the existing Zoho integration surface (there
  is none in this codebase currently — Zoho integration is external to
  this repo as far as the codebase search shows; `grep -rn "zoho" -i src/
  migrations/ test/` returns zero matches at the time of writing).
- Does not set a timeline for stages (ii)–(v).
- Does not affect the two currently-active workstreams (OPR Auth Batch,
  Device Lifecycle slice 1) — those proceed on their own separately-tracked
  plans (see `docs/plan/device-lifecycle-slice1.md` and the OPR Auth Batch
  reporting in conversation/commit history).

## Relationship to the two active workstreams

Kept strictly separate, per the standing rule that a change in one
workstream must not touch another:

- **OPR Auth Batch** (rename + exchange-rate-month + stale-rate guard +
  expiry warnings + office-code correction) — proceeds independently; its
  domain is customs/duty declarations, not stock/accounting integration.
- **Device Lifecycle slice 1** (C15–D33 repair-workflow + Zoho upload
  *queue*, i.e. the existing placeholder CSV/file-generation queue already
  scoped in `docs/plan/device-lifecycle-slice1.md`) — this is a **narrower,
  already-scoped, currently-active piece of work** distinct from this
  document's stage (iv)/(v) "rehome Amazon" and "connect accounting"
  ambitions. The existing Zoho upload-queue placeholder in slice 1 is not
  redefined or superseded by this roadmap; it remains a one-row-per-IMEI,
  no-aggregation placeholder as already agreed, and continues independently
  of when (or whether) stages (i)–(v) here are ever executed.
