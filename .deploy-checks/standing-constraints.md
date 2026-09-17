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

## §7 — Task M closed: supervising office `GBLIV002` confirmed by HMRC (2026-09-16)

**Ruling received, quoted in full:**

> *"The GBLIV002 is the correct reference for the IP/OP Supervising
> office."* — Neil Platts, Officer, Customs Liverpool Team, India
> Buildings, Liverpool.

This settles a genuine, previously-open disagreement, not a rubber
stamp. Before this ruling, the case against `GBLIV002` was reasoned and
well-sourced: HMRC's own published Appendix 17 list labels `GBLIV002`
as *"India Buildings (Freeport Authorisations Team)"* and places IP/OP
at `GBLIV001`, Graeme House — a different building, a different office
code, on the same published list this project relied on to validate
office codes elsewhere. The ruling above comes from an officer who
sits in India Buildings, on the IP/OP team, and who owns this specific
authorisation (`OP/0922/601/31`) — direct authority over the published
list's own labelling, which is now known to be stale or imprecise for
this code. **Recording this here specifically so nobody re-opens the
Appendix 17 objection from the published list alone in the future** —
the objection was reasonable at the time it was raised, and the
resolution is this named officer's direct confirmation, not a
correction to the published Appendix 17 text itself (which has not
been amended and should not be treated as authoritative for this code
going forward).

**Verified live in production before writing this note** (not merely
transcribed from the operator's message), via `gsk hosted d1_query`:

```
SELECT id, supervising_office_code, supervising_office_name, op_authorisation_number
FROM opr_authorisations WHERE id = 1;
```
→ `supervising_office_code = 'GBLIV002'`,
`supervising_office_name = 'HMRC S1756 IP-OP Customs Liverpool'`,
`op_authorisation_number = 'OP/0922/601/31'`.

This matches exactly what was already stored (corrected in an earlier
session — see `.deploy-checks/runbook-shipment1-finalise-2026-09-12.md`
line 61, "The supervising-office code (`GBLIV002`) was corrected on
`opr_authorisations` this session"). **No database write was made or
needed for this ruling** — the existing value is now HMRC-evidenced
rather than operator-asserted. `EXP_SUPERVISING_OFFICE` green and
`export_procedure_policy_defaults` (effective 2026-08-16) are confirmed
correct as a consequence; neither needs revisiting on this point.

**Also confirmed by HMRC, same correspondence:** Bills of Discharge are
not required for Outward Processing authorisation — the discharge
tracker in this codebase is internal record-keeping / audit trail, not
a statutory HMRC submission. This does not change the 180-day /
six-month re-import deadline (an authorisation condition, separate from
discharge returns) — **2 March 2027** stands unaffected.

Task M closes at 100%. No code, migration, or route change resulted
from this ruling — docs-only entry.

## §8 — Task X: the manifest-line-cascade modal race, its fix, the route's fourth state, and browser verification dropped a second time (2026-09-16)

**The real incident this section is about.** The operator performed the
Task X acceptance test on production device 1319 (IMEI
355178160488248): picked the corrected SKU, entered a reason, and
submitted. The device-row correction succeeded (one `SKU_CORRECTION`
event), but the manifest line's own cascade never fired —
`expected_devices` id=2602 was left at the old, wrong SKU
(`APL-I13-128-MDN-A`) with no error shown anywhere. Confirmed live via
`gsk hosted d1_query`: only one `SKU_CORRECTION` event exists for
device 1319, not the expected two.

**Root cause, confirmed by direct code read, not by recall or
assumption.** `CorrectDeviceModal`'s pre-submit mismatch check
(`public/static/app.js`) was:

```javascript
const manifestMismatch = !!ctx.manifestLine && !!ctx.sku_pick && ctx.manifestLine.sku !== ctx.sku_pick;
```

This is genuinely correct logic — it compares the manifest line's SKU
against the operator's newly-**selected** SKU (`ctx.sku_pick`), not the
device's stale current SKU, which is what the earlier route-side bug
did before its own fix (`expectedRow.sku === oldSku`, widened to
`!== catalogRow.sku` in the 2026-09-15 pass documented above §7). An
initial hypothesis that the modal repeated that exact class of mistake
was checked against the file and did **not** hold — worth recording
explicitly so it is not re-asserted later without a fresh read.

The actual defect was a **race**, not a logic error: `openCorrectDeviceModal()`
sets `ctx.manifestLine = null` and `ctx.loading = true` synchronously,
then asynchronously fetches `GET /devices/:id` (which populates
`ctx.manifestLine` from the response's `manifest_line` field) before
setting `ctx.loading = false`. The "Save correction" button's
`disabled` attribute was wired only to `ctx.busy`, never to
`ctx.loading`. An operator who picked the SKU and clicked Save before
that fetch resolved could submit with `ctx.manifestLine` still `null`
— `manifestMismatch`'s `!!ctx.manifestLine` guard then evaluates
`false` regardless of what the SKUs actually say, no prompt is shown,
`also_correct_manifest_line: false` is sent, and nothing on screen
indicates anything went wrong. This reproduces every observed symptom
on device 1319 exactly.

**Fix, two parts, both landed in commit `b685c13` (auto-backup) /
confirmed identical by this session's own edits — see the git note
below:**

1. **Modal** (`public/static/app.js`, `CorrectDeviceModal`): Save is
   now gated on `(ctx.busy || ctx.loading)`, not `ctx.busy` alone.
   Checked before landing this: `openCorrectDeviceModal`'s `.catch()`
   path already unconditionally clears `ctx.loading` on fetch failure
   (and shows an error toast), so this gate cannot freeze the button —
   the window is exactly the fetch's real round-trip, nothing more.
2. **Route** (`src/routes/devices.ts`, `PATCH /:id/correct`): the
   `manifest_line_cascade` response field gained a fourth state,
   `'divergent_not_requested'` — fires whenever a genuine
   manifest/device mismatch exists but the cascade flag was absent or
   false, for *any* reason (a genuine operator decline, this exact
   race, or a future bug not yet imagined). Previously this case
   collapsed to a bare `null`, indistinguishable from "no mismatch at
   all, nothing to report" — the same class of silent-success-that-
   wasn't the tri-state signal (§6, `70a2a9b`) was introduced to close,
   now closed one layer deeper: the route tells the truth about a real
   divergence regardless of what any particular UI does or fails to
   do, not just regardless of what the caller explicitly asked for.

**Tests**: 3 existing assertions in `test/deviceCorrectRoute.spec.ts`
updated (they hit the same "mismatch present, no cascade requested"
shape and were asserting the old bare-`null` behaviour), plus one new
dedicated test reproducing the device-1319 shape exactly — a genuine
mismatch with `also_correct_manifest_line` omitted from the body
entirely gets `'divergent_not_requested'`, contrasted in the same test
against a device with no manifest link at all, which correctly still
gets a plain `null`. Full suite: Group 1 165/0/165, Group 2 193/1/194
(+1 net test), Group 3 348/7/355, Serial 65/0/65 — **combined 771
passed / 8 skipped / 779 total** (up from 770/8/778). `tsc --noEmit`
clean. `npm run build` succeeds (307.41 kB).

**Browser verification dropped a second time.** A
`correct-device-race-ui.browser.mjs` script was written to prove the
race through a real rendered DOM (throttling/failing the live
`GET /devices/:id` call via Playwright's `context.route()`) — the kind
of claim this project's own standing rule says needs a browser check,
not a route test, to back a rendered-verdict statement. It cost three
separate debug cycles, all in the SCRIPT, not the product: a wrong
`POST /manifests` response field (`manifest.id` vs the route's actual
`manifest_id`), an unscoped `page.locator('select')` matching four
elements on the real page (subview filters and per-row "Move to"
pickers, not just the modal's own picker), and a `const modal`
temporal-dead-zone ordering bug. It never reached a clean pass. Ruled:
dropped — this is the **second** time browser verification has been
explicitly dropped on this project (the standing instruction earlier
in this project's history was "stop browser verification, drop
Playwright"; it came back for this one check and cost exactly what
that ruling anticipated). The script and its README registration were
deleted (commit `30b3e71`); the race is left proven by the direct code
read above and the route-level regression test, which is sufficient —
a one-line boolean-gate fix does not need DOM-level proof when the
route-side signal now makes the failure mode impossible to mistake for
"nothing to report" even under a different future race. **No further
`*.browser.mjs` work should be started on this project without an
explicit, separate operator instruction** — see
`test/browser/README.md`'s matching process note for the fuller
writeup and the fixture-cleanup confirmation (all `8604572`-prefixed
rows existed only in local D1, never remote, and were deleted with a
zero-count re-query before the harness was removed).

**Git note**: a `genspark auto-backup` commit (`b685c13`) landed
mid-session and already captured `devices.ts`, `app.js`, and
`test/deviceCorrectRoute.spec.ts` exactly as verified above — confirmed
by `git diff b685c13 -- <those three files>` returning empty before
any further commit was made, per the standing practice of diffing an
unexpected auto-backup against intended changes rather than trusting
it blindly. No amendment to those three files was needed.

**Ordering constraint carried forward, unchanged and still binding**:
this fix must not be deployed together with the Task AC lock. Device
1319 sits in `ACTIVE_INVENTORY`; the ruled Task AC fix adds
`ACTIVE_INVENTORY` (and downstream statuses) to
`CORRECTION_LOCKED_STATUSES`. Landing that before the operator re-runs
the device-1319 correction (same SKU, prompt now genuinely reachable,
cascade fires) would strand `expected_devices` id=2602 at the wrong SKU
with no operator-reachable fix path ever again. Sequence: deploy this
fix alone → operator re-runs the correction → confirm the cascade fired
(second `SKU_CORRECTION` event, `expected_devices` id=2602 updated) →
only then proceed to the Task Z bundle carrying the Task AC lock.
