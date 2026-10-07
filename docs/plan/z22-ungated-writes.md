# Z-22 — ungated write routes: read-only audit (no code changed this pass)

**Provenance note, logged per standing protocol**: this ticket (Z-22, along
with Z-23/Z-24 referenced in the same operator message) does not appear
anywhere in this repo's history prior to this file — `grep -rln "Z-22"
docs/` and `git log --all --oneline | grep -i z-22` both returned zero
matches before this commit, and this agent's own immediately-preceding
turn issued no such ruling. Treating Z-22 as a new ask received now, not
resumed work from an untraceable prior ruling. Flagged for the operator
to reconcile on their side; the audit itself proceeds regardless since
it's genuinely actionable without that reconciliation.

## Scope

Every POST/PATCH/DELETE route in `opr.ts` and `bills.ts` scanned
programmatically for `requireManager`/`requireAdmin` presence between its
definition and the next route definition (not just grep hits anywhere in
the file, which would false-positive on comments referencing the
convention). `webhooks.ts` and `skuMap.ts` included for completeness since
they were flagged in the §2 triage pass.

## opr.ts — full write-route gate audit (25 POST/PATCH/DELETE routes)

| Route | Gated? | Gate type |
|---|---|---|
| `POST /authorisations` | **NO** | — |
| `PATCH /authorisations/:id` | **NO** | — |
| `POST /shipments` | yes | `requireAdmin` (owner-tier create) |
| `PATCH /shipments/:id` | yes | `requireAdmin` (opr.ts:659) |
| `POST /shipments/:id/lines` | **NO** | — |
| `POST /shipments/:id/scan` | **NO** | — |
| `DELETE /shipments/:id/lines/:lineId` | **NO** | — |
| `POST /shipments/:id/reconcile-value` | **NO** | — |
| `POST /shipments/:id/misdeclaration-ack` | **NO** | — |
| `POST /shipments/:id/lines/:lineId/correction` | **NO** | — (see correction note below: an earlier automated pass of this table mis-flagged this as gated) |
| `POST /shipments/:id/lines/:lineId/correction/review` | yes | `requireAdmin` (opr.ts:1883) |
| `POST /shipments/:id/finalise` | **NO** | — |
| `POST /shipments/:id/finalise/resume` | yes | `requireAdmin` (opr.ts:2241) |
| `POST /shipments/:id/export-proof` | **NO** | — |
| `POST /shipments/:id/import-proof` | **NO** | — |
| `POST /shipments/:id/restock` | **NO** | — |
| `POST /shipments/:id/prealert/mark-sent` | **NO** | — |
| `POST /shipments/:id/clearance/mark-sent` | **NO** | — |
| `POST /shipments/:id/prealert/send` | **NO** | — |
| `POST /shipments/:id/clearance/send` | **NO** | — |
| `POST /shipments/:id/correspondence` | **NO** | — |
| `POST /shipments/:id/replies` | **NO** | — |
| `POST /shipments/:id/checklist` | **NO** | — |
| `POST /shipments/:id/scan-bulk` | **NO** | — |
| `POST /shipments/:id/bulk-serials` | **NO** | — |

**Correction note**: an initial automated scan pass (matching from each
route definition forward to the next one) mis-flagged
`lines/:lineId/correction` (line 1707) as gated — a false positive caused
by the scan window running long enough to pick up the NEXT route's
(`correction/review`'s) `requireAdmin` call. Re-read directly:
`opr.ts:1707-1739`, the correction POST handler's actual body, contains no
`requireAdmin`/`requireManager` call at all — **it is ungated**, which is
also consistent with its own doc comment ("Declaration-only while the
return is DRAFT... never blocked mid-scan"). The table above already
reflects the corrected reading (NO); noting the correction here so the
false-positive isn't silently invisible.

**Net**: only 4 of opr.ts's 25 write routes are gated at all
(`POST /shipments`, `PATCH /shipments/:id`, `correction/review`,
`finalise/resume`) — all four `requireAdmin`, none `requireManager`. The
other 21, including every money-adjacent and declaration-adjacent route
(`reconcile-value`, `misdeclaration-ack`, `restock`, `finalise`,
`export-proof`, `import-proof`), accept a write from **any authenticated
role** — operator, manager, or admin — with no distinction.

## bills.ts — full write-route gate audit (5 POST routes)

| Route | Gated? |
|---|---|
| `POST /` (create) | **NO** |
| `POST /:id/close` | **NO** |
| `POST /:id/force-close` | **NO** |
| `POST /:id/write-cost-ledger` | **NO** |
| `POST /:id/repair-control` | **NO** |

**Net**: zero of bills.ts's 5 write routes carry any role gate — confirmed
by `grep -n "requireManager\|requireAdmin" src/routes/bills.ts` returning
no hits at all, not even a comment. `write-cost-ledger` is the route that
actually posts bill-line costs onto devices' `cost_ledger` — a direct
financial write, open to any authenticated session.

## webhooks.ts — full write-route gate audit (3 routes)

| Route | Gated? |
|---|---|
| `POST /` (register) | **NO** |
| `POST /:id/toggle` | **NO** |
| `DELETE /:id` | **NO** |

Lower severity than the above two files — an outbound webhook URL is a
data-exfiltration surface, not a financial or customs-declaration one, but
still any-role.

## skuMap.ts — for contrast, NOT part of the gap

5 of its 10 routes (`POST /`, `PATCH/DELETE /:goods_in_sku`, `POST
/import`, `GET /unmapped/export`) are already `requireManager`-gated.
Included here only to show the convention exists and is applied elsewhere
in the codebase — it simply wasn't applied to `opr.ts`'s write surface or
to any of `bills.ts`.

## Reachability — is this live in production, or dead code?

Not dead code. Per the §2 triage table (`z16-triage-33.md`), most of the
ungated OPR writes (`reconcile-value`, `partial-return-declarations`'
sibling corrections, `scan-bulk`, `bulk-serials`, `import-proof`,
`correspondence`, `replies`, `checklist`) are real, tested, reachable via
`/api/opr/...` once authenticated — they're just not yet wired into the
SPA's UI. `finalise`, `restock`, `export-proof`, `prealert/send`,
`clearance/send` ARE wired and called from the live UI today (confirmed in
the prior sweep), meaning these specific ungated routes are not just
theoretically reachable but are actively used in production by any
authenticated user regardless of role. `bills.ts`'s 5 routes are similarly
all UI-wired per the existing bills screen.

## Severity read, not a ruling

Two concrete concerns raised in the operator's framing, read against what
the code actually does:

1. **"An ungated financial override is a write path available to any
   authenticated session"** — confirmed true for `bills.ts`'s
   `force-close` and `write-cost-ledger`, and for `opr.ts`'s
   `reconcile-value`/`restock`/`export-proof`/`import-proof`. All write
   `cost_ledger` or shipment-finalisation-adjacent state and all currently
   accept any role.

2. **"An ungated customs acknowledgement records no actor"** — this needs
   a precise correction: `misdeclaration-ack`'s handler (opr.ts:1561+)
   DOES call `currentUser(c)` and the insert captures `user.id` as part of
   its audit row (standard pattern across this codebase — every write
   records `user_id`). The actor IS captured. What's missing is a role
   restriction on WHO is allowed to be that actor, not the actor-capture
   itself. Worth stating precisely since "records no actor" and "doesn't
   restrict which actor" are different gaps with different fixes — the
   audit trail already answers "who clicked this," just not "should they
   have been allowed to."

## What this pass does NOT do

No gate was added. No route was changed. This is the read the operator
asked for before any fix. The fix step (gate at manager level, confirm
actor-capture is already adequate per the correction above) is the next
action once this read is reviewed — not bundled into this commit, since
the operator's own phrasing was "report that read, then gate" as two
separate steps, and conflating them risks shipping a gate decision (which
routes, which role) without it having been seen first.
