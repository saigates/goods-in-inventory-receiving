# Phase 2 offline half (2026-08-21) — rehearsal, bundle freshness, full suite

**Context**: after the live half of Phase 2 halted on its first attempted
read (`gsk hosted d1_query` for `repair_jobs` returned `resource_not_found`
with an explicit "DO NOT retry this read command"), investigation (`gsk
hosted list`, `gsk hosted list --type d1`, `gsk login-info`) established
that this sandbox session is authenticated as `sagarsptl@gmail.com`, not
the account the Saigates production deployment is believed to live under
(`saigateslimited@gmail.com`). The live half (repair_jobs count,
zoho_batch_devices count, the `0031` collision query, and re-establishing
deployed-worker identity) is deferred to a session authenticated as
`saigateslimited@gmail.com` and is **not attempted here**.

The user explicitly split Phase 2 and authorised proceeding with everything
that needs no live D1 access now: *"Send the developer ahead with the
offline half now. Only the three live queries wait."* This doc records
that offline half's results. Two of its six items (the role-gate check and
the 9/27 decay note) were already completed and committed in `e73ea64`
before this doc was written; they are listed here for completeness, not
re-run.

All work below is against either a disposable `/tmp` SQLite scratch DB
(destroyed immediately after use, never checked into the repo) or the
existing git-tracked source tree at its current, clean HEAD. No live D1
access, no writes to any Cloudflare resource, no `gsk hosted` calls of any
kind in this doc's work.

## Item 1: ten-file dry-path rehearsal against the MD5-pinned 18 August export

**Question**: do all ten currently-held migration files (`0023a`, `0023b`,
`0023c`, `0024`-`0029`, `0031` — note: NOT `migrations-held/0030`, which is
a separately-held file outside this batch, confirmed by directory listing
before running) apply cleanly, with FK enforcement on, against a real
snapshot of production data, and does the `0031` unique index actually
create successfully (i.e. are there zero sku_catalog collisions in that
snapshot — a snapshot fact, not a live one)?

**Method**: fresh load of the export into a new, empty `/tmp` SQLite file
via Python's stdlib `sqlite3`, `PRAGMA foreign_keys = ON`, then
`executescript()` on each of the ten files in filename order, aborting the
whole run on the first exception (none occurred).

**Export re-verified by hash, not assumed from a prior pass's memory**:

```
$ md5sum /mnt/aidrive/prod-export-2026-08-18-pre-0029.sql
88185e6e61014db4ed1be34074bd29e3  /mnt/aidrive/prod-export-2026-08-18-pre-0029.sql
```

Matches the value recorded in every prior pass that has used this export
(`.deploy-checks/pre-0029-export.md`, `.deploy-checks/g5-offline-imei-and-repair-job-checks.md`).

**Baseline state on load** (confirms the export's own bookkeeping matches
the "0001-0022 applied, 0023+ pending" premise Phase 2 is testing):

```
received_devices = 398
expected_devices = 756
sku_catalog = 2781
repair_jobs = 0
zoho_batch_devices = 0
last migration row: (22, '0022_repair_jobs_and_zoho_queue.sql', '2026-08-11 16:54:39')
d1_migrations count: 22
```

**Migration application, in order**:

```
FK enforcement: (1,)
[1/10] APPLIED OK: 0023a_shipments_type_widening.sql
[2/10] APPLIED OK: 0023b_received_devices_status_and_received_at.sql
[3/10] APPLIED OK: 0023c_removal_flags.sql
[4/10] APPLIED OK: 0024_ce1154_worksheet_rewrite.sql
[5/10] APPLIED OK: 0025_misdeclaration_ack_and_value_adjustment_defaults.sql
[6/10] APPLIED OK: 0026_export_procedure_policy_defaults.sql
[7/10] APPLIED OK: 0027_worksheet_input_provenance.sql
[8/10] APPLIED OK: 0028_bills_cost_ledger_freight.sql
[9/10] APPLIED OK: 0029_manifest_bill_link.sql
[10/10] APPLIED OK: 0031_sku_catalog_unique_config_grade.sql
ALL TEN FILES APPLIED CLEANLY, NO ABORT.
```

**Post-migration verification**:

1. **Unique index present, exact expected DDL**:
   ```sql
   CREATE UNIQUE INDEX ux_sku_catalog_org_config_grade
     ON sku_catalog(
       organisation_id,
       UPPER(brand),
       UPPER(model),
       COALESCE(capacity, ''),
       UPPER(COALESCE(color, '')),
       COALESCE(grade, '')
     )
   ```
   — matches migration `0031`'s own `CREATE UNIQUE INDEX` statement
   verbatim, confirming it created successfully (an index that fails to
   create due to duplicate keys would abort the migration, which did not
   happen).

2. **`sku_catalog` row count unchanged**: `2781` before and after — the
   index creation neither removed nor rejected any row, meaning there were
   **zero collisions in the 18 August export** against the
   `(organisation_id, UPPER(brand), UPPER(model), COALESCE(capacity,''),
   UPPER(COALESCE(color,'')), COALESCE(grade,''))` key. This is a snapshot
   fact, not a live one — nothing has been read from any live session yet.
   A collision arriving in production after 18 August is exactly the
   scenario this offline check cannot see, and exactly the scenario that
   would make migration `0031` fail mid-batch; the live collision query is
   still required and is not superseded by this result.

3. **`repair_jobs` / `zoho_batch_devices` both 0 rows in the 18 August
   export, before and after migration**: both `0`, confirming the
   FK-repoint precondition these two `NO ACTION` children of
   `received_devices` depend on was never stress-tested by actual data in
   this snapshot. This is the **third** snapshot-level confirmation of the
   same fact — the 2026-08-11 export and this same 2026-08-18 export were
   already checked by `.deploy-checks/g5-offline-imei-and-repair-job-checks.md`'s
   Checks B/C — not a live count, and not a new finding beyond what those
   two prior snapshots already showed. Both tables are live, actively-
   written surfaces (`repair_jobs` via `startRepair()`; `zoho_batch_devices`
   via the Zoho batch-confirmation flow), so three snapshots agreeing is
   evidence toward, not satisfaction of, the deploy precondition — the two
   live counts are still required.

4. **FK repoint correctness**, via `PRAGMA foreign_key_list`:
   ```
   repair_jobs FKs: [(0,0,'users','opened_by_user_id','id','NO ACTION','NO ACTION','NONE'),
                     (1,0,'users','cost_recorded_by','id','NO ACTION','NO ACTION','NONE'),
                     (2,0,'users','qc_by','id','NO ACTION','NO ACTION','NONE'),
                     (3,0,'received_devices','device_id','id','NO ACTION','NO ACTION','NONE'),
                     (4,0,'organisations','organisation_id','id','NO ACTION','NO ACTION','NONE')]
   zoho_batch_devices FKs: [(0,0,'received_devices','device_id','id','NO ACTION','NO ACTION','NONE'),
                             (1,0,'zoho_batches','batch_id','id','NO ACTION','CASCADE','NONE')]
   ```
   Both tables' `device_id` FK correctly points at the `received_devices`
   table (which `0023b` drops and recreates) — confirming the repoint the
   0023-0029 hold was originally worried about did in fact resolve
   correctly in this rehearsal.

5. **Global FK integrity check**: `PRAGMA foreign_key_check` → `[]` (empty
   list — zero violations project-wide, not just for the two tables above).
   This directly demonstrates the `0023` FK-repoint hazard flagged in
   `.deploy-checks/pre-0029-export.md` does **not** fire against this
   export.

6. **Offline signal on the collision query itself** (the same query the
   live half will run against real production — run here for a sanity
   signal only, NOT a substitute for the live check the user required):
   ```sql
   SELECT organisation_id, UPPER(brand), UPPER(model), COALESCE(capacity,''),
          UPPER(COALESCE(color,'')), COALESCE(grade,''), COUNT(*) c
   FROM sku_catalog GROUP BY 1,2,3,4,5,6 HAVING c > 1;
   ```
   Result: `[]` — zero collision groups in this snapshot. Per the user's
   explicit instruction to treat a "clean" collision result with maximum
   scrutiny, this offline signal is evidence toward, not a substitute for,
   the live check — the export is dated (2026-08-18) and sku_catalog is
   confirmed (see `README.md`'s Data Architecture note added in `e73ea64`)
   to grow via ordinary receiving, so a clean result here does not rule out
   a collision having appeared since.

7. **9 UG-only configs still present and unchanged**: checked by exact
   `(brand, model, capacity, color)` lookup against the 9 configs listed in
   `.deploy-checks/g5-item2-catalog-grade-gap-sweep.md`. **First attempt
   used the doc's mixed-case literals (e.g. `Phantom Black`) and returned
   zero rows for all 9 — a false "gone" result**, traced immediately to
   `sku_catalog.color` being stored upper-case in this export (e.g.
   `PHANTOM BLACK`) while SQLite string comparison is case-sensitive by
   default. Re-run with `UPPER(column) = UPPER(?)` on both sides confirmed
   all 9 configs are present with exactly `['UG']` as their grade set,
   unchanged by the migration batch:
   ```
   SAMSUNG GALAXY S20 FE 128GB Cloud Navy: ['UG'] -- STILL UG-ONLY
   SAMSUNG GALAXY S21 256GB Phantom Gray: ['UG'] -- STILL UG-ONLY
   SAMSUNG GALAXY S23 FE 256GB Graphite: ['UG'] -- STILL UG-ONLY
   SAMSUNG GALAXY S24 256GB Phantom Black: ['UG'] -- STILL UG-ONLY
   SAMSUNG GALAXY S24 512GB Phantom Black: ['UG'] -- STILL UG-ONLY
   SAMSUNG GALAXY S24 FE 256GB Graphite: ['UG'] -- STILL UG-ONLY
   SAMSUNG GALAXY Z FLIP5 256GB Graphite: ['UG'] -- STILL UG-ONLY
   SAMSUNG GALAXY Z FLIP5 512GB Graphite: ['UG'] -- STILL UG-ONLY
   SAMSUNG GALAXY Z FOLD5 256GB Phantom Black: ['UG'] -- STILL UG-ONLY
   ALL 9 STILL UG-ONLY: True
   ```
   **Noted explicitly rather than silently corrected**: this case-mismatch
   is exactly the class of bug migration `0031`'s own collision query and
   unique index guard against by wrapping every text column in `UPPER()` —
   a live example, found by my own tooling mistake, of why that design
   choice matters. It does not change any conclusion above (the underlying
   data was never wrong, only my first query's WHERE clause), but is
   recorded here so a future reader doesn't dismiss a similar zero-match
   result as confirmed without checking case-sensitivity first.

**Cleanup**: `rm -rf /tmp/g5-phase2-rehearsal-v2`, confirmed via directory
listing that no `g5`-prefixed scratch *directories* remain under `/tmp`
(some unrelated `.txt` commit-message scratch files from earlier passes do
remain there and are out of scope for this cleanup).

**What this does and does not establish**: this rehearsal is strong,
positive evidence toward de-risking the eventual deploy — all ten files
apply cleanly, the FK-repoint hazard does not fire, and the collision query
comes back clean — against a real, hashed snapshot of production data. It
is explicitly **not** a substitute for the live half. The snapshot is three
days old relative to today and `sku_catalog` is now known to grow via
ordinary receiving; `repair_jobs`/`zoho_batch_devices` are both live,
actively-written surfaces. Per the user's standing instruction, the live
half must still run, with maximum scrutiny on a "clean" collision result
specifically because a false-clean here risks a mid-batch abort with
atomicity still unanswered.

## Item 2: bundle SHA-256 freshness

**Question**: does `dist/_worker.js` — the actual artifact `wrangler pages
deploy` would ship — correspond to the current, clean git HEAD, and is the
build deterministic (not an artifact of stale/incremental build state)?

**Method**: no prior methodology for this check exists anywhere in this
repo — confirmed by grep across `.deploy-checks/`, `migrations-held/`,
`README.md`, `public/tracker/index.html`, and the `gsk-hosted-deploy` skill
doc, all zero matches for "sha256"/"bundle freshness"/equivalent. This is a
newly-established check with no in-repo precedent, noted explicitly rather
than invented silently.

`dist/` is git-ignored (`git check-ignore dist` exits 0), so nothing here
touches version control directly; the check instead pairs the build output
hash with the exact commit SHA and working-tree cleanliness at build time.

**Pre-build state**:
```
$ git status --short
(empty)
$ git rev-parse HEAD
e73ea643d30647fa482682e5e30e0b8e391ef198
```
Zero uncommitted changes, HEAD matches `origin/main` (`git rev-parse HEAD
origin/main` returned identical SHAs).

**Build and hash**:
```
$ rm -rf dist && npm run build
vite v6.4.3 building SSR bundle for production...
✓ 93 modules transformed.
dist/_worker.js  269.30 kB
✓ built in 2.02s
$ sha256sum dist/_worker.js
d444aba22366d6f15e2add56a5a1677e7a1630a759a98e6f2e11012eefdf5228  dist/_worker.js
```

**Reproducibility**: this exact hash was produced twice from independent
`rm -rf dist && npm run build` invocations — once during the immediately
preceding turn, and again fresh in this turn — both from the same clean
`e73ea64` HEAD. Identical hash both times confirms the build is
deterministic for this commit, not an artifact of incremental build
caching.

**Result**: `dist/_worker.js` built from commit `e73ea643d30647fa482682e5e30e0b8e391ef198`
hashes to `d444aba22366d6f15e2add56a5a1677e7a1630a759a98e6f2e11012eefdf5228`,
reproducibly. Any deploy from this commit, from any account/session, should
produce this same artifact; if a future deploy's live hash (once the
tooling under the correct account exposes one) differs, that is itself a
signal worth investigating rather than assuming benign drift.

**Staleness note**: this doc (`g5-phase2-offline-half.md`) was itself
committed as `ae03bb3`, one commit after `e73ea64` — but `ae03bb3` is
doc-only (added this file, touched no `src/`, no `migrations/`, no build
config). It does not move HEAD's build output, so the hash above
(`d444aba2...`, built from `e73ea64`) remains the correct, current hash for
the repo's actual HEAD as of `ae03bb3`. If any future commit touches a
source file, this pairing goes stale and must be re-run and re-recorded
against the new HEAD — do not assume this hash still applies past the next
source-touching commit.

**What this reproducibility finding actually means for deploy, clarified
2026-08-21**: this project's `gsk hosted deploy` publishes the invoking
session's own local `npm run build` output, not a server-resolved Git
snapshot (see `.deploy-checks/g5-phase2-live-half.md`'s closing section
for the read-only correction and evidence). Given that, "any deploy from
this commit, from any account/session, should produce this same artifact"
is not a claim about the deploy mechanism pinning a hash — it is a claim
about **build determinism**: because three independent local builds from
`e73ea64` all hashed identically, a deploying session that (a) checks out
the intended commit and (b) runs `npm run build` fresh should reproduce
`d444aba2...` in its own `dist/`. The hash is therefore still useful as a
pre-deploy check — confirm the deploying session's fresh build matches it
before calling `gsk hosted deploy` — but it is a thing to *verify in that
session*, not a value the deploy tooling looks up or guarantees on its
own.

## Item 3: full test suite, re-run as its own explicit action this pass

**Why re-run rather than cite the prior gate-check**: the last actual
`npx vitest run` was during `e73ea64`'s pre-commit gate, before this pass's
rehearsal/bundle work. No source files have changed since (confirmed: same
clean HEAD, `git status --short` empty throughout this pass), so an
identical result was expected — but per the user's explicit item-by-item
Phase 2 checklist ("Same for bundle SHA-256 freshness, the full suite, the
ten-file dry-path...") this needed to be run and recorded as its own step,
not merely inferred from an earlier run.

```
$ npx vitest run
 Test Files  26 passed (26)
      Tests  518 passed | 8 skipped (526)
   Start at  14:39:09
   Duration  45.80s
```

**Result**: 26 test files, 518 passed, 8 skipped, 526 total, 0 failed, exit
code 0 — identical to the `e73ea64` pre-commit gate result, confirming no
regression and reproducibility of the suite itself.

## Items 4 & 5: role-gate check and 9/27 decay note — already complete

Both were completed and committed in `e73ea64`, before this doc was
written:

- **Role-gate check**: an operator-role synthetic probe (`test/_scratch_operator_catalog_probe.spec.ts`,
  created and deleted, never committed) confirmed the self-heal path on
  `POST /api/catalog` is not role-gated — identical `200`/self-heal
  behaviour as the earlier admin-role probe. See `README.md`'s User Guide
  addition and `.deploy-checks/g5-item2-catalog-grade-gap-sweep.md`'s
  correction addendum for the citations (`src/routes/catalog.ts` line 290,
  `src/routes/devices.ts` lines 451-454 as the only role-check in the
  routes tree, unrelated to catalog).
- **9/27 decay note**: added to `.deploy-checks/g5-item2-catalog-grade-gap-sweep.md`
  immediately after the original "9 configs / 27 rows" sentence, stating
  the figure is a point-in-time measurement, not a stable target.

Listed here for completeness only — not re-run or re-verified in this doc,
since they involve no live D1 access and were already gated (tsc + full
suite) and committed as part of `e73ea64`.

## Gates / discipline notes

- No live D1 access anywhere in this doc's work. No `gsk hosted` calls of
  any kind, no `wrangler d1 execute --production` calls.
- No writes to any tracked repo file's *data* — the rehearsal ran entirely
  against a disposable `/tmp` SQLite file (`/tmp/g5-phase2-rehearsal-v2/scratch.db`),
  created and destroyed within this doc's work, never checked into the
  repo.
- `dist/` is git-ignored and was rebuilt twice from a clean tree; neither
  build was committed (nor should be — it's a build artifact).
- `tsc --noEmit`: not separately re-run in this doc's work, since no
  `src/` file was touched by anything in this pass (rehearsal and build
  are read-only against source; this doc itself is documentation only).
  The last `tsc --noEmit` run was in `e73ea64`'s pre-commit gate, against
  the same commit this doc's build was performed from.
- `npx vitest run`: re-run explicitly in this doc's work (Item 3), fresh
  result recorded above, not merely cited from a prior pass.
- This doc itself is the pending file-creation task flagged in the prior
  turn's summary; writing it is the only file-system change this pass
  makes to the tracked repository.

## What remains — the live half, explicitly deferred

Per the user's instruction, only the following remain, and only once a
session authenticated as `saigateslimited@gmail.com` is available:

1. Identity establishment: `gsk login-info`, `gsk hosted list` (no filter),
   `gsk hosted list --type d1`; confirm whether the expected project id and
   a D1 database named `d6aea290-bd61-4f82-aa8d-94378b9f2fec-db` actually
   appear.
2. Re-establish deployed-worker identity and, if exposed, the commit/version
   it was built from — to confirm or correct the `6cbe4e2` belief (which,
   per the user's own correction, should be reported as "believed, per
   README; unverified from this session" until then).
3. The three original live queries — `repair_jobs` count,
   `zoho_batch_devices` count, and the `0031` collision query (with both
   pre-checks — schema presence and `GROUP BY`/index expression-list match
   — already confirmed offline in the prior pass and restated verbatim
   alongside the live query when it runs) — with every SQL statement
   pasted verbatim beside its output.

Scope for that live half, as authorised: read-only only. No deploy, no
`d1_execute`, no `--with-db`, nothing that creates or modifies a resource.
Stop and report — do not work around — any further "do not retry" signal.
