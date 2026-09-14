# Standing constraints — read this before touching bulk queries or auth probes

Docs-only. No handshake, no deploy, no code change accompanies this file.
Recorded 2026-09-14, after the Task Z read-only pass and the deploy-state
reconciliation earlier the same day. These four facts carry the same
weight as the credential wall (i.e.: forgetting one of them WILL produce
a production incident or a wasted investigation, not just a style nit).

## 1. D1 bound-parameter cap = 100 per query

Cloudflare D1 rejects any prepared statement bound with more than ~100
parameters. Any query that builds `IN (${ids.map(() => '?').join(',')})`
from a caller-supplied or row-derived array breaks once that array
exceeds the cap — not gracefully, as a 500.

This is not theoretical: it is what half-finalised shipment 1 (52/155
stuck) during the STEP 0-3 remediation, and it was independently
re-discovered while building Task U's resume route (three separate
queries written with an IN-list on device ids/lines would have 500'd on
the exact 155-device incident shipment; caught by the existing 162-device
serial-suite fixture before commit, not by a test written for the
purpose).

**The fix pattern:** join through `shipment_lines.shipment_id` (a single
bound parameter) instead of binding a list of ids. See `opr.ts`'s
`GET /shipments/:id` (export_progress), the finalise route's
`exportedCount` re-query, and `POST /shipments/:id/finalise/resume`'s
stranded-device query — all three were rewritten this way.

**Project-wide inventory (Task Z, 2026-09-14, exhaustive grep for
`.map(() => '?')` / `IN (${...})` patterns across `src/routes/*.ts`):**

| Site | Bound today | Risk | Status |
|---|---|---|---|
| `opr.ts:2519-2521` (bulk-serial lookup) | `BULK_SERIAL_CAP = 500` (opr.ts:2482) | **Guaranteed failure** — the cap itself exceeds the 100-param limit, and this is the bulk route, so it will only ever be called with large inputs | Not yet fixed |
| `inventory.ts:183` (`POST /grade`) | none — no cap on `ids.length` at all | Guaranteed failure once a bulk regrade exceeds ~100 ids | Not yet fixed |
| `manifests.ts:458` (`POST /:id/apply-sku-to-batch`) | implicit only — bounded by how many pending lines on one manifest share an exact model/capacity/color/grade signature | Latent — breaks on a large single-manifest batch with >~100 identical-signature lines | Not yet fixed |

**Confirmed NOT at risk (checked and cleared, not assumed):**
- `scan.ts` — zero matches of the pattern anywhere in the file.
- `opr.ts:1254` — that line is a comment inside the `/discharge` doc-block;
  the actual `/discharge` query is join/subquery-based, no scaling IN-list.
- `manifests.ts:128-367` (the manifest upload/parse route) — zero matches
  in that range; the actual IN-list site in this file is line 458,
  outside it.
- `devices.ts:39,259` (`status IN (...)`) — bounded by the fixed
  `DEVICE_STATUSES` enum (~14 values, validated before binding), never
  near 100 regardless of caller input.
- `bills.ts:311` — `IN (SELECT ...)` subquery bound with a single
  parameter (`bill_id`), not a per-row list — not the same pattern.

**Do not fix the three real sites until Task U/W's deploy has landed and
been verified.** One change at a time through a deploy pipeline that has
already lost two handshakes to expiry. Chunking is the preferred fix
over lowering caps (a 500-serial lookup is a reasonable thing for an
operator to want) — see the Master Checklist for the specific approach
per site.

## 2. Auth-middleware ordering breaks 401-vs-404 route probing

`src/index.tsx:36-45` registers `app.use('/api/*', authMiddleware)`
before any `app.route('/api/opr', oprRoute)` (or any other route)
registration. This means an unauthenticated request to ANY `/api/*`
path — real, fictitious, or misspelled — returns an identical 401.

**A 401-vs-404 probe cannot tell you whether a specific route is
registered.** This was proven via controls (a deliberately fictitious
path and a known-pre-existing path both returned 401 alongside the
route actually being tested) during the 2026-09-14 deploy-state
reconciliation, after this exact probe had been treated as reliable
for a full prior pass.

**The only reliable test for "is this code live":** diff the actual
served asset (`/static/app.js`, or the worker's compiled output) against
local source, or check `worker_get`'s `row_ctime`/version metadata. This
retires the 401/404 probe for good — do not reintroduce it.

## 3. The credential wall

(Existing constraint, carried forward for equal listing — see prior
runbooks for detail: real per-person accounts are off-limits as test
fixtures; live `gsk`/git-remote actions must be bracketed with identity
checks.)

## 4. Deploy-approval discipline

`gsk hosted deploy` always returns `pending_approval` with a
`pending_action_id` and an `expires_at` TTL. Only the operator's own
banner click or explicit typed confirmation naming that ID constitutes
approval. Two consecutive handshakes have already expired unapproved
(`920b2f05...` for Task U, `6912107f...` for Task W) — both confirmed
via direct `action_status` query, not assumed. Report the TTL
prominently on every future submission so the operator can time their
click; do not resubmit a second time without the operator's explicit
go-ahead if a handshake expires again.
