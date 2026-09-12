# Runbook — finalising shipment OPR20260826003 (external ref OPR-20260902-003-155)

Prepared 2026-09-12, after the dry-run returned 12/12 GREEN,
`red_count = 0`, `amber_count = 0`, `validation.result = 'green'`.

**This is a runbook, not an action taken on the operator's behalf.**
Nothing in this pass called `/finalise`. The operator performs every step
below themselves.

## Where

Open the shipment in the app: Shipments → OPR20260826003 (internal
reference; external/FedEx-facing reference is OPR-20260902-003-155,
recorded in the shipment's notes field) → the shipment detail page.

## What you should see before clicking Finalise

All 12 validation checks green. If anything shows amber or red, STOP —
do not finalise — and get it corrected first. As of this runbook's
writing, all checks are green; if time has passed and something has
drifted (e.g. a device removed from the consignment), re-check before
proceeding.

## The action

Click the **Finalise export** button on the shipment detail page.

## Fields to leave EMPTY at finalise time

Do not fill in any of the following — they are outbound-declaration
fields captured later, once the actual customs entry exists, not
guessed or pre-filled now:
- `export_mrn`
- `ducr`
- `ead_mrn`
- `mucr`
- `import_mrn` (this is the RETURN leg's field in any case — never
  touched by an export shipment)

## What finalise does

- Blocks outright if `validation.result === 'red'` (any check red) —
  will not happen here, since the dry-run is clean, but this is the
  gate's actual behavior (`opr.ts:1529-1530`), not merely advisory.
- Sets `status = 'FINALISED'`, stamps `finalised_at` (defaults to now
  unless a value is explicitly supplied), stamps `finalised_by_user_id`.
- Transitions every device on the consignment (all 155 lines) from
  `IN_EXPORT_CONSIGNMENT` to `EXPORTED_UNDER_OPR`.

## ⚠️ THIS IS IRREVERSIBLE

There is no un-finalise route anywhere in this codebase. Once
`status = 'FINALISED'`, the shipment cannot be reopened, and the 155
devices cannot be pulled back into DRAFT via any button or API call.
If something is wrong after finalising, it becomes a correction problem
on the FINALISED record (and potentially a customs-declaration problem),
not an undo. Confirm everything is right before clicking.

## Not this runbook's concern (already handled or explicitly deferred)

- The supervising-office code (`GBLIV002`) was corrected on
  `opr_authorisations` this session — done, verified, not part of this
  action.
- The consignee identity (`Syncere Wireless FZE`, full address, `DAP`
  incoterm) was corrected this session — done, verified.
- The vendor code `SW001` is preserved in `notes` free text, pending a
  proper `consignee_code` column in a future Task L migration — not
  blocking finalise.
- The return leg (repair cost, freight, insurance, CIF/C&E1154 duty
  base) is a SEPARATE, later action on the import-side shipment once
  the devices come back — not part of finalising this export.

## Addendum — Task Q closed (recorded 2026-09-12, after production deploy)

**Closing note, docs-only, no deploy/handshake attached to this entry.**

Task Q (DRAFT header-edit UI + read-only render of `display_label`) is
closed. Sequence:

- `47a643c` shipped the edit card (`OprHeaderEditCard`), owner-gated
  (`isAdmin()`), scoped to the 9 fields agreed (`display_label`,
  `consignee_name`, `consignee_address`, `consignee_code`, `incoterm`,
  `ship_date`, `carrier`, `carrier_account`, `notes`) — deployed at
  worker version `76b47044`.
- A grep-confirmed gap surfaced immediately after that deploy: the
  read-only header (`<h2 id="opr-detail-ref">`) and fact grid still
  rendered only `s.reference`, never `s.display_label` — the operator's
  actual complaint (cannot see the correct external reference without
  opening the edit form) was still live.
- `8314316` fixed it: the header now renders `s.display_label ||
  s.reference`, with the immutable system reference shown alongside,
  muted, only when it differs from what's displayed (`sys: OPR20260826003`)
  — so the audit-key reference used everywhere else (URLs, FK joins, the
  shipments list) is never hidden. Two new integration tests
  (`test/oprFoundation.spec.ts`, "Task Q — owner-only PATCH of a
  hyphenated display_label") close the automated-coverage gap from the
  prior pass, where the owner-200/non-owner-403 behaviour for a
  hyphenated label had only been curl-verified, not asserted in the
  suite. Predicted delta (main +2/689, combined +2/754) matched exactly
  on a fresh run.
- **Browser-automation verification was attempted and dropped.** A
  throwaway Playwright script against the local dev server (real login
  as `owner@saigates.com`/local-only test password, a real fixture
  shipment, a real PATCH of `display_label`) could not reliably drive
  the SPA's client-side nav in this sandbox session across several
  attempts, and was abandoned rather than reported as a false PASS —
  see the prior turn's explicit stop-and-report rather than risk a
  fabricated pass.
- **Deployed** via `gsk hosted deploy`, pending action
  `02614d1d-9c62-4cbc-824f-e3be4ef5346f`, approved by the operator's own
  banner click (landed before any `action_approve` call from this
  session — same pattern as `af650f74`). New worker version
  `265b5479-760d-49c1-8979-992a0677f819`. No migration named; asset
  diff was exactly `+ /static/app.js`.
- **Operator confirmed the header render on production version
  `265b5479`** — a real logged-in human looking at the live page,
  substituting for the dropped browser automation per the standing
  credential-wall constraint (real per-person accounts are off-limits
  as sandbox fixtures, so a sandbox-driven click-through was never
  going to reach production credentials anyway; the operator's own eyes
  on the deployed page is the correct verification instrument here, not
  a downgrade from one).

Task Q status: **closed**. No further code, tests, or deploy action
pending against it.

## Addendum — Task S closed on a read alone (2026-09-12)

`discharge_period_months` on `opr_authorisations` id 1 (Saigates
Limited, org 1) was read directly from production: **already `6`**.
No write was needed — the value was correct going into this pass, not
merely "close enough."

The unit question the operator raised (six months vs. 180 days,
one day apart on the deadline, £36,031.71 at risk if wrong) is
resolved: **the authorisation document says six months.** The schema
(`discharge_period_months`, month-denominated, `addMonths()` day-of-
month-clamped arithmetic — `src/lib/oprImport.ts:81-90`, `:1074`) is
therefore already the correct representation; no migration, no new
day-denominated field, no value change.

Computed deadline for shipment 1, run through the actual production
`addMonths()` function against the real values (`ship_date =
2026-09-02`, `discharge_period_months = 6`):

```
addMonths("2026-09-02", 6) → "2027-03-02"
```

**2027-03-02 is the deadline of record.** (Six calendar months from
2 September is 2 March; "180 days" would have given 1 March — the
one-day discrepancy that triggered this whole check ran in the safe
direction, but was still worth resolving rather than assuming.)

Warning margin: `closingWindowDays = 30` (`src/lib/oprImport.ts:1056`,
a function-default parameter, not a named exported constant). Every
production call site uses the default — a `'closing'` status appears
once `days_remaining <= 30`, `'overdue'` once it goes negative. This
gives the operator a month's notice before the deadline automatically;
changing the margin, if ever wanted, is a single default-parameter
edit, not new work — noted, not built.

Task S status: **closed**, no code change, no migration, no deploy.

## Deferred — post-finalise reads (NOT run yet; shipment 1 is still DRAFT)

Per explicit instruction: do not prompt for finalise, and do not run
these until the operator has actually finalised shipment 1
themselves. When they do, run and record here:

1. **All 155 devices in `EXPORTED_UNDER_OPR`, shipment `FINALISED`** —
   confirm via `device_events` (latest `STATUS_CHANGE`/`EXPORT_FINALISED`
   row per device) and `shipments.status`, not just the finalise
   response body.
2. **All 155 present in `GET /opr/discharge`** with a `days_remaining`
   figure computed against the confirmed `2027-03-02` deadline — this
   is the entire point of Task S's threshold, and the join at
   `opr.ts:1254` (`JOIN opr_authorisations a ON a.id =
   s.authorisation_id`, INNER) makes this row's presence NOT a given
   for every shipment type (see the Task R addendum below) — for THIS
   shipment, `authorisation_id = 1` is set, so it is expected to appear,
   but confirm rather than assume.
3. **`export-proof` confirmed callable post-finalise** — a real
   `POST /opr/shipments/1/export-proof` call (or at minimum, a
   route-reachability check) proving the MRN/DUCR/EAD/MUCR fields can
   still be added once FedEx answers, without needing a second
   deploy or any code change. This was already read-confirmed as
   `status==='FINALISED'`-gated and repeatable (plain `UPDATE`, no
   idempotency lock) at `opr.ts:1655-1733` — this step is the live
   confirmation on the real, now-finalised row, not a re-read of the
   route.

## Addendum — Task R, still scope-only (2026-09-12)

Restated for the record, not re-investigated this pass:
`ALLOWED_TRANSITIONS` (`src/lib/deviceLifecycle.ts:91`) has no
`EXPORTED_UNDER_OPR → TEMP_EXPORTED_STANDARD` edge, and the `/discharge`
INNER JOIN at `opr.ts:1254` silently excludes any shipment with
`authorisation_id IS NULL` from the entire tracker — not merely from
sort order. Together these mean a naive regime conversion would (a) be
rejected by the state machine outright, or (b) if forced through some
other path, drop the converted shipment out of `/discharge` entirely,
reintroducing the exact invisible-forever failure a conversion feature
would exist to avoid. Still evidence-gated on FedEx/customs-agent
confirmation of the actual filed regime — not built, not scheduled.
