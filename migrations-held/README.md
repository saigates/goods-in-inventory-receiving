# Held migrations — NOT applied by `test/apply-migrations.ts`, NOT deployed

Files in this directory are deliberately **outside** `migrations/` so that
neither the test suite (`test/apply-migrations.ts` / `vitest.config.ts`,
which apply every file under `./migrations`) nor `gsk hosted deploy`
(which — per direct empirical evidence, see below — auto-applies every
migration file present in `migrations/` that production's `d1_migrations`
tracking table does not yet record, as one atomic part of the same
approved deploy action) will pick them up.

## Why 0030 is here

`0030_expected_devices_condition_derived_from_grade.sql` is a
recreate-and-copy migration over the live production `expected_devices`
table (756 rows at last audit). Per explicit user instruction (2026-08-19),
it must not ship as a side effect of deploying the already-held batch, and
its own pre-flight cross-tab needs to be re-run fresh immediately before
it is deployed on its own. See `.deploy-checks/pre-0029-export.md` for the
migration-mechanics investigation and `.deploy-checks/lw001-16-catalog-coverage.md`
for the related sweep-scope caveat.

**CORRECTION (2026-08-19):** the batch referenced above is **0023–0029
(seven files)**, not "0024–0029 (six)" as originally written here.
Production's own `d1_migrations` table (in the same md5-verified export
cited below) shows only IDs 1-22 ever applied — nothing for 0023 — and
production's live `received_devices` CHECK constraint independently
confirms 0023 was never run (it lacks the two status values 0023 adds).
**Separately, and more urgently: forensic review of 0023 itself found a
real, blocking defect** — it recreates `received_devices` and repoints
four child tables' foreign keys (`device_events`, `shipment_lines`,
`print_jobs`, `grade_audit`) but misses two more that also carry a
`NO ACTION` FK into it, `repair_jobs` and `zoho_batch_devices` (both added
one migration later, by 0022, after 0023's four-table list was written and
apparently never re-derived against the by-then-current schema). Deploying
0023 as written would raise `FOREIGN KEY constraint failed` and abort
(not silently corrupt data) the moment either table holds a row at deploy
time — `repair_jobs` is confirmed to be an actively-written feature
(`src/lib/repairWorkflow.ts`), not dormant. **The entire 0023-0029 batch is
therefore held, not just 0030** — see `.deploy-checks/pre-0029-export.md`'s
own 2026-08-19 addendum for the full forensics, empirical reproduction,
and rollback-statement writeup. Fixing 0023 is its own reviewed unit, not
attempted in this pass.

## Mechanism confirmation (resolved 2026-08-19, previously unconfirmed)

Two earlier passes (documented in `.deploy-checks/pre-0029-export.md`)
treated this as "probably auto-applies, but inferential only" because the
`gsk hosted` control-plane read path was down and couldn't be exercised
live. This pass found **direct empirical confirmation** without needing a
live control-plane read: the durable production export already retrieved
and saved at `/mnt/aidrive/prod-export-2026-08-18-pre-0029.sql` (md5-
verified, see that same doc) contains production's actual `d1_migrations`
table as of 2026-08-18 — i.e. AFTER the 2026-08-11 deploy of commit
`6cbe4e2`. It shows:

```
(18, '0018_opr_authorisation_number_rename.sql', '2026-08-11 16:29:03')
(19, '0019_shipment_value_reconciliation.sql',   '2026-08-11 16:29:03')
(20, '0020_communication_tracker.sql',           '2026-08-11 16:29:03')
(21, '0021_repair_qc_zoho_status_enum.sql',       '2026-08-11 16:54:39')
(22, '0022_repair_jobs_and_zoho_queue.sql',       '2026-08-11 16:54:39')
```

Three previously-unapplied migration files (0018/0019/0020) were all
recorded as applied at the **identical** timestamp, and two more
(0021/0022, applied in a follow-up same-day commit `7408f03` fixing an FK
constraint failure) share a second identical timestamp — both pairs
consistent with "every migration file present in `migrations/` and not
yet tracked gets applied together, as one batch, during a single `gsk
hosted deploy` action," not a mechanism that lets an operator choose a
subset. This corroborates (rather than merely being consistent with) the
`migration_status`/`schema_verification` deploy-result-payload fields
documented in the `gsk-hosted-deploy` skill, and README's own prose
("wrangler applies any migration file not yet recorded as applied on that
Worker's tracking table").

**Conclusion: `gsk hosted deploy` auto-applies every migration file under
`migrations/` that isn't yet in production's `d1_migrations` table, with
no user-facing option to apply a subset.** Holding 0030 back therefore
requires exactly what this directory does — keeping the file physically
outside `migrations/` until it is deployed deliberately on its own.

## Restoring 0030 when ready to deploy it

```
git mv migrations-held/0030_expected_devices_condition_derived_from_grade.sql \
       migrations/0030_expected_devices_condition_derived_from_grade.sql
```

Then re-run the fresh pre-flight cross-tab against production (do not
reuse the 2026-08-18 one without re-verifying — production data may have
changed), `npx vitest run` to confirm the tests below still pass with
0030 back in the applied set, and only then deploy.

**CORRECTION (2026-08-20) — the `git mv` alone is NOT sufficient, and the
"three tests below" this section used to point at were never actually
listed here (a dangling reference — this section originally ended right
after that sentence).** The specific, previously-uninspected assumption
that needs correcting: `test/manifestConditionDerivation.spec.ts`'s
`it.skip('the expected_devices.grade CHECK constraint rejects a raw
grade outside A/B/C/UG at the DB level ...')` (line 161) does **NOT**
auto-flip to a passing `it(...)` just because the migration file moves
back into `migrations/`. It is a bare, hardcoded `it.skip(...)` call —
confirmed by grep (zero filesystem/glob/env condition anywhere in the
file, in `test/apply-migrations.ts`, or in `vitest.config.ts`) and by
running that spec file alone before and after an unrelated migration
rename this same day (identical 8 passed / 1 skipped both times, proving
the skip cannot react to any migration file's presence or absence). This
had been carried forward across sprints as if it *were* self-correcting
(see the comment block directly above that `it.skip` at the time of
writing, which frames it as "restore this to `it(...)` the same time
0030 is moved back into `migrations/`" — an instruction for a human to
act on, not a mechanism that fires on its own). **Restoration checklist,
in order:**
1. `git mv` the migration file back (command above).
2. Manually edit `test/manifestConditionDerivation.spec.ts` line 161
   from `it.skip(...)` to `it(...)` (and update the test's own title
   string, which currently says "skipped while migration 0030 is held
   out of migrations/" — that clause becomes stale the moment step 1
   runs).
3. Re-run the fresh pre-flight cross-tab against production per above.
4. `npx vitest run` — confirm the now-unskipped test passes for real
   against the live CHECK constraint, not just that the suite total
   changed.
5. Only then deploy.

**6. Check for a numbering collision with `0031` before restoring `0030`
under its original filename — added 2026-08-21.** Migration
`0031_sku_catalog_unique_config_grade.sql` ships in the 0023-0029+0031
batch (i.e. before this held file is restored). Its own header comment
records that it was itself "renumbered from a locally-drafted 0030
before this commit was ever pushed anywhere" — this project has
therefore already once avoided exactly this collision by renumbering.
`gsk hosted deploy` (and this project's `d1_migrations` table generally)
tracks applied migrations by insertion order at apply time, not by
filename — so restoring this held file under its ORIGINAL name `0030`
after `0031` has already shipped would create a file numbered LOWER
(`0030`) than one already applied (`0031`), but that file would itself
be applied at a HIGHER `d1_migrations` id than `0031`'s. That is the
same out-of-order shape as the `0023a`/`0023b`/`0023c` incident
documented in `migrations-review/README.md`'s "Adoption precondition"
section (ids 30-32 landing after 0024-0029's ids 24-29), arrived at
legitimately rather than by mistake this time — but not automatically
safe merely because it's deliberate.

**Before running step 1 above**, check whether `0031` (or any other
migration that has shipped in the meantime) has already claimed a
number this held file would collide or interleave with, and if so,
**rename this held file to the next available number instead of
restoring it as `0030`** — the same remedy `0031` itself already used.
Do not restore it under `0030` once any migration numbered `0030` or
higher has shipped; check the current `migrations/` listing and this
directory before deciding the new number, and update every reference
to "0030" in this README, the tracker backlog entry, and
`.deploy-checks/pre-0029-export.md` / `lw001-16-catalog-coverage.md` to
match the new filename at that time — this note does not pre-select the
new number, since it depends on whatever else has shipped by then.

## Future migration `0032` — duplicate sweep required before the `startRepair()` index fix

The `startRepair()` check-then-insert race (`src/lib/repairWorkflow.ts`
lines 71-79, logged as an Open defect in `public/tracker/index.html`) is
expected to be fixed by a future migration adding a partial unique index
on `repair_jobs(device_id)` WHERE `status IN ('open','awaiting_qc')`,
the same fix shape migration `0031` used for `sku_catalog` (its own
header cites this exact defect as precedent). At the time `0031` was
written, `repair_jobs` was confirmed to have 0 rows in both the
2026-08-11 and 2026-08-18 production exports (see
`.deploy-checks/g5-offline-imei-and-repair-job-checks.md`) — so a
`CREATE UNIQUE INDEX` at that time would have had nothing to collide
against. **That evidence goes stale the moment this held batch (which
ships the repair-cost surfaces, `postRepairCostToLedger()` and the
`/repair/cost` and `/repair/cost-ledger` routes) deploys and bench staff
begin actively opening repair jobs** — the deferral window between "this
batch ships" and "the unique-index migration is written" is exactly the
period during which `repair_jobs` could first become non-empty with the
race still unfixed, and a live duplicate-open-job sweep from before that
window says nothing about after it.

**Requirement**: whatever migration eventually adds this index (next
available number after this batch, referred to informally as "0032")
MUST be preceded by a FRESH duplicate-open-job sweep of live
`repair_jobs` — the same query shape as
`.deploy-checks/g5-offline-imei-and-repair-job-checks.md` check (B), but
against a live read taken immediately before that migration is written,
not a reused snapshot. If the sweep finds any device with more than one
simultaneously open/awaiting_qc repair job, those duplicates must be
resolved (which job stays open is an app-level decision, not a migration
concern) before the unique index is added, or `CREATE UNIQUE INDEX` will
abort exactly as `0031`'s did for `sku_catalog` collisions — the same
failure mode, on a table that by then may no longer be empty.
