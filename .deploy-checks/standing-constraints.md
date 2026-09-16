# Standing constraints — read this before touching bulk queries, auth probes, or deploy

Docs-only. No handshake, no deploy, no code change accompanies this file
(this update included). Recorded 2026-09-14, after the Task Z read-only
pass, the deploy-state reconciliation, and the Task U/W deploy itself.
These five facts carry the same weight as the credential wall (i.e.:
forgetting one of them WILL produce a production incident, a burned
handshake, or a wasted investigation, not just a style nit).

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
approval. Two consecutive handshakes expired unapproved before this one
landed (`920b2f05...` for Task U, `6912107f...` for Task W) — both
confirmed via direct `action_status` query, not assumed. A failed
action's approval does not carry forward to a resubmission — a new
`pending_action_id` requires a fresh, explicit approval naming that new
ID (see §5 below for why the resubmission was needed). Report the TTL
prominently on every future submission so the operator can time their
click; do not resubmit a second time without the operator's explicit
go-ahead if a handshake expires again.

## 5. Deploy packages the sandbox directory tree, not the git tree

**`git status --porcelain` clean is necessary but NOT sufficient
evidence that a deploy will succeed.** The Cloudflare Workers for
Platform deploy pipeline packages the actual sandbox filesystem, not
just git-tracked files — a git-ignored artifact left on disk (log file,
core dump, cache, anything) still gets bundled into the source tree and
counts against the platform's 500MB uncompressed size limit, even
though it will never show up in `git diff` or a commit.

**What happened (2026-09-14, first Task U/W deploy attempt):** a
608MB `workerd` crash-dump file (`core`, git-ignored, never tracked)
was sitting in `/home/user/webapp/` — left behind by stray duplicate
`vitest`/`workerd` processes from an earlier attempt to get a clean
test-suite summary line, which had to be killed. `git status` was
clean; the deploy still failed: `Source tree exceeds the uncompressed
size limit (500MB); largest so far: core (579MB)`. The approved action
(`155d494f...`) executed and failed — terminal, not retryable — costing
one handshake. Root cause found, file deleted, resubmitted as a new
action (`1bcd49cb...`), fresh approval obtained, deploy succeeded.

**Standing pre-submit step, from now on:** before calling
`gsk hosted deploy`, run something equivalent to:
```
du -sh --exclude=node_modules --exclude=.git --exclude=dist .
```
and flag anything over ~50MB before submitting. **28MB is the
known-good figure** for this project's actual source (everything
excluding `node_modules`/`.git`/`dist`). This turns this whole class of
failure into a pre-submit warning instead of a burned handshake.

Also worth noting: `ulimit -c` in this sandbox is `unlimited`, so any
future `workerd`/`node` crash can silently deposit another large core
file. The size check above catches it either way, but it's the reason
this class of stray artifact can recur without any code change on our
part.

## 6. Task X — device correction route (2026-09-14)

`PATCH /api/devices/:id/correct` (src/routes/devices.ts, right after
`GET /:id`) landed: owner-only (role==='admin', `requireOwner()`, a local
boolean helper matching this file's own `requireManager()` idiom rather
than opr.ts's Response-returning `requireAdmin()`), pre-commitment gate
via `CORRECTION_LOCKED_STATUSES` (= `OPR_WORKFLOW_ONLY_STATUSES` ∪
`SOLD`), catalogue-only SKU with colour/grade always derived from the
chosen `sku_catalog` row, IMEI immutable (any `imei` key in the body at
all is a 422, not just a changed value), mandatory `reason`, a
`SKU_CORRECTION` event via `logDeviceEvent` (same event type/shape as
`inventory.ts:427-437`), queued-print-job invalidation/re-queue (same
pattern as `inventory.ts:365-398`), and a **prompt-not-cascade** flow for
the linked `expected_devices` row: `received_devices` is corrected
unconditionally on every call; the manifest line is only ever touched
when the caller explicitly passes `also_correct_manifest_line: true` on
the SAME call, and gets its own second `SKU_CORRECTION` event
(`metadata.target: 'expected_devices'`) rather than a silent write.
`bill_lines_flagged` is reported in the response, not written to a DB
column — no `needs_review`/flag column exists on `bill_lines` or
`bill_line_serials` (checked against migration 0028 before deciding
this).

10 tests in `test/deviceCorrectRoute.spec.ts` (5 named by the operator +
5 supporting), all passing standalone and inside the full 3-group split.
Verified live-production pre-image for the motivating device (IMEI
355178160488248, id 1319) via `gsk hosted d1_query` before writing the
route: `status='RECEIVED'` (pre-commitment, correctable),
`sku='APL-I13-128-MDN-A'` (MIDNIGHT), `expected_device_id=2602` whose
`expected_devices.sku` carries the SAME wrong value — so the real
correction the operator will make live is exactly the
prompt-not-cascade path this route is built to exercise, not a
synthetic edge case.

**Tool note:** `gsk hosted d1_query --sql "..."` is the correct way to
read production D1 from this sandbox — NOT raw
`wrangler d1 execute --remote` (that fails here with
`Invalid property: databaseId => Invalid uuid`, since this project's
`wrangler.jsonc` `database_id` is a Workers-for-Platform placeholder,
not a real Cloudflare D1 UUID). Use `gsk hosted d1_query` for every
production read from now on.

**Gap found and fixed before first deploy submission (same day,
master-checklist review):** the original `CORRECTION_LOCKED_STATUSES`
list could not see a device that had been pushed to Zoho, because "pushed
to Zoho" is not a `received_devices.status` value at all —
`READY_FOR_ZOHO` means "QC passed, awaiting the human's manual upload"
(still correctable, deliberately), and the actual push confirmation is a
human clicking "Close to inventory" in the UI, which calls
`closeToInventory()` (`repairWorkflow.ts:299-345`) — that stamps
`repair_jobs.closed_at` and moves the device to `ACTIVE_INVENTORY`, a
status this route already treats as freely correctable. Confirmed (not
assumed) that `repair_jobs.closed_at` on the device's most recent job is
the ONLY signal anywhere in the codebase for this: grepped every
`zoho_batches`/`zoho_batch_devices` reference in `src/` (only
`inventory.ts:308`'s own comment — *"no application code writes to
zoho_batches today"*) and confirmed live via `gsk hosted d1_query`
(0 rows in both tables in production). Fixed by adding an explicit
`repair_jobs.closed_at IS NOT NULL` check (most recent job, by id) right
after the status-lock check, returning the same 409 family. Zero live
devices were affected today (checked via `gsk hosted d1_query` before
and after the fix), but the gap was structural, not hypothetical, and
is now closed. Two new tests added (closed job → 409; open job →
still correctable) — 12 tests total in `test/deviceCorrectRoute.spec.ts`,
all green. Combined baseline after this fix: 765/8/773.

**Test-split pinning (master-checklist minor note):** the file-to-group
assignment now lives in `.deploy-checks/test-split-groups.txt` — regenerate
it only when a spec file is added/removed/renamed, in the same commit as
that change, so future run figures are comparable file-by-file across
runs, not just in aggregate.

**Deploy history for this route:** `f4550f7a-4769-42fe-80c8-090373e6f9c0`
landed the route+gates+12-tests bundle above at production version
`f62c877b` (commit `f96375a`) — approved by the operator, deployed clean
(no migrations, no asset diff). The operator then caught that the deploy
shipped **no UI**: `app.js` was untouched, so there was no way to reach
the route from the browser, and the planned acceptance test (operator
performs the IMEI `355178160488248` correction from the UI) could not be
performed. Same class of regression as Task L. Task X was marked back
down to 60% until a UI control actually exists — recorded here so this
specific failure mode (route deployed, no way to reach it) has a named
precedent to check against before any future "done" claim on a route
that's meant to be operator-facing.

**Second gap found while building the UI (same day, 3rd master-checklist
review) — the two-call cascade trap:** the original UI spec described
the manifest-line prompt as shown AFTER a successful correction, with
`also_correct_manifest_line: true` sent on a SECOND, follow-up PATCH.
Tracing this against the route's actual code (`oldSku` is read fresh
from `received_devices.sku` on every call, before the WHERE-based
UPDATE) showed that a second call could never see the original
mismatch — by the time it runs, `received_devices.sku` already equals
the corrected value, so the manifest line silently fails to cascade with
a plain 200 and no error, exactly the shape of the operator's own
`355178160488248` acceptance test (manifest line `id=2602`) failing
silently with a green toast on screen. Ruled by the operator: option (b)
— extend `GET /:id` to return the linked manifest line's `{id, sku}` so
the modal can decide whether to show the prompt BEFORE the operator ever
submits, and always send exactly one PATCH either way. Option (a) —
always cascade silently and report afterwards — was explicitly rejected:
"an always-on cascade that reports afterwards is a notification, not
consent," since the manifest line is evidence of what the supplier
originally said and overwriting it without asking destroys that
evidence.

**Route hardening riding the same bundle (three changes, all in
`PATCH /:id/correct`):**
  1. **Widened the cascade-eligibility condition** from
     `expectedRow.sku === oldSku` to `expectedRow.sku !== catalogRow.sku`
     — the real question is "does the manifest line match the device's
     CORRECTED sku", not "did it match what the device used to be
     wrong as". The narrower, pre-fix condition would let a manifest
     line that was wrong in some unrelated THIRD way pass through
     completely unflagged and unreported.
  2. **Explicit no-op signal.** `also_correct_manifest_line: true` used
     to collapse "genuine cascade applied" and "nothing to cascade" onto
     the same `manifest_line_also_wrong: false` — indistinguishable from
     each other. Added `manifest_line_cascade`, a tri-state
     (`'applied' | 'not_applicable_no_manifest_line' |
     'not_applicable_already_matches' | null`) that always states
     plainly why nothing happened when the caller asked for a cascade
     and didn't get a genuine one.
  3. **Test coverage for the exact two-call trap** that motivated all of
     this: call once (no cascade), then call again with the flag on a
     device whose sku has already moved — asserts the response reports
     `not_applicable_already_matches` explicitly rather than a bare
     `false`.

**UI built:** `Correct details` button next to `Move to…` in
`AllDevicesSubview` (`app.js`), visible only under `isAdmin()` (the
existing UI-decluttering convention — server's own 403 is the real
gate). `CorrectDeviceModal` fetches `GET /:id` on open (now returning
`manifest_line: {id, sku} | null`), lets the operator pick a SKU from
`state.catalog` (no free text), shows the derived colour/grade read-only,
shows IMEI read-only, requires a reason, and — only if the fetched
manifest line's sku differs from the pick — shows the
"the manifest line also reads X — correct it too?" checkbox BEFORE
submit, sending exactly one PATCH with `also_correct_manifest_line` set
from that checkbox's answer. Added `api.patch` to the `api` helper
(previously only `get`/`post`/`del` existed, even though the underlying
`http` axios instance already supported `.patch`). 409/422/403 responses
are surfaced via the existing `toast(err.response?.data?.error, 'err')`
pattern — the Zoho-push 409's date is shown verbatim, not swallowed.

**Tests added this bundle:** two hardening tests in
`deviceCorrectRoute.spec.ts` (the two-call trap, explicit
`not_applicable_already_matches`; and the widened-condition "third
value" case), plus two new tests for `GET /:id`'s `manifest_line` field
(null when unlinked; `{id, sku}` when linked) — 17 tests total in
`deviceCorrectRoute.spec.ts`. One test-authoring mistake caught and
fixed during this bundle: the new "third value" test originally reused
`model: 'IPHONE TESTQ'` + the exact same capacity/color/grade as the
pre-existing REJECTED test further down the same file — an org-scoped
catalogue collision on `ux_sku_catalog_org_config_grade`
(`organisation_id, brand, model, capacity, color, grade`), silently
absorbed by `INSERT OR IGNORE`, that caused whichever test ran second to
fail with a 422 (SKU not in catalogue) that had nothing to do with the
change under test. Fixed by using a distinct model name
(`IPHONE TESTTHIRD`) for the new test. Caught by running the full spec
file, not just the new tests in isolation — a reminder that
`uniqueSuffix()` only guarantees a unique SKU STRING, not a unique
catalogue config+grade key.

**Full-suite baseline after this bundle** (measured fresh, each group run
to completion this session): Group 1 165 passed/0 skipped/165 total
(unchanged — no files in this group touched), Group 2 192 passed/1
skipped/193 total (`deviceCorrectRoute.spec.ts` now carries 17 tests: 13
from the prior deploy's EXISTS-fix state + 4 new this bundle — the
two-call-trap test, the widened-condition "third value" test, and two
new `GET /:id` `manifest_line` tests), Group 3 348 passed/7 skipped/355
total (unchanged), Serial 65 passed/0 skipped/65 total (unchanged).
**Combined: 770 passed / 8 skipped / 778 total.** `tsc --noEmit` clean.
`npm run build` succeeds (307.38 kB).
