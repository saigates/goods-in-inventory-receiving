# Migration rewrite drafts — under review, NOT deployed, NOT excluded from future adoption

Unlike `migrations-held/`, this directory is not a "never touch this
sprint" holding pen — it is a **reviewable staging area** for a
table-recreation migration rewrite the user explicitly asked to read
before it goes anywhere near `migrations/`.

## What's here

Split rewrite of `migrations/0023_temp_export_standard_and_received_at.sql`
(itself left unmodified in place), produced during Sprint E's E2 item
because E1 found 0023's artifacts (`TEMP_EXPORT_STANDARD`/
`TEMP_EXPORTED_STANDARD`/`RETURNED_UNDER_STANDARD` status values,
`received_at`) are live dependencies of shipping code (`src/types.ts`,
`src/lib/deviceLifecycle.ts`, `src/lib/oprValidation.ts`,
`src/lib/oprImport.ts`, `src/routes/scan.ts`, `src/routes/inventory.ts`,
`src/routes/opr.ts`, `public/static/app.js`) — so 0023 cannot simply be
held next to 0030; it must be fixed in place instead, since it has never
shipped to production and therefore carries no released history.

- `0023a_received_devices_status_and_received_at.sql` — recreates
  `received_devices` with the corrected 6-table child list (adds
  `repair_jobs`, `zoho_batch_devices`, both missed by the original 0023's
  4-table list, which was written against 0021's schema and never
  re-derived after 0022 added those two tables).
- `0023b_shipments_type_widening.sql` — recreates `shipments` (widened
  `shipment_type` CHECK, relaxed `authorisation_id`/`procedure_code`
  nullability). Its original 4-child accounting was already correct;
  split out purely for the "partial batch leaves a diagnosable state"
  reason below.
- `0023c_removal_flags.sql` — new `removal_flags` table, no recreate
  needed, copied verbatim from the original 0023.

## Why three files instead of one

Per explicit instruction: splitting the recreates into separate numbered
migrations means a partial-batch failure on a real (non-atomic) deploy
records exactly which sub-migration failed in `d1_migrations`, instead of
an opaque internal-statement-offset failure inside one giant file.

## What was empirically established (not assumed) before writing these

- `PRAGMA defer_foreign_keys = TRUE` does NOT prevent the `DROP TABLE`-
  triggered FK failure in D1's local engine — tested fresh in an isolated
  scratch wrangler project; fails identically to the already-known
  `PRAGMA foreign_keys = OFF` ineffectiveness from 0021 REVISION-2/3.
- `PRAGMA foreign_key_check` returning violation rows does NOT itself
  abort a migration — it must be paired with a `CHECK`-constraint guard
  that turns a non-empty result into an INSERT failure. Each of 0023a/
  0023b ends with:
  ```sql
  CREATE TABLE __fk_check_guard_NNNN (ok INTEGER NOT NULL CHECK (ok = 1));
  INSERT INTO __fk_check_guard_NNNN (ok)
  SELECT 0 FROM pragma_foreign_key_check() LIMIT 1;
  DROP TABLE __fk_check_guard_NNNN;
  ```
  An initial draft of this guard was inverted (silently succeeded even
  WITH violations present) — caught and corrected via direct empirical
  testing, not code review alone.
- Positive test: with the project's real `migrations/0001-0022_*.sql`
  applied, and exactly 1 seeded `repair_jobs` row + 1 seeded
  `zoho_batch_devices` row (matching the flagged race-condition
  severity — not an exaggerated "many rows" case), `0023a`→`0023b`→
  `0023c` all applied cleanly, both row counts were preserved, and
  `PRAGMA foreign_key_check` returned empty afterward.
- Negative test: a deliberately-reintroduced copy of the original bug
  (repair_jobs handling stripped back out of 0023a) correctly FAILED
  against the same seeded state, confirming the underlying SQLite FK
  check is itself a real safety net for this failure class, independent
  of the explicit guard (which exists for other, non-DROP-triggered
  inconsistency classes).
- Authoritative, non-synthetic reproduction of the ORIGINAL defect: the
  project's actual `migrations/0001-0022_*.sql` plus the actual
  production `migrations/0023_temp_export_standard_and_received_at.sql`
  file (not hand-retyped) were applied against the same 1-row seed and
  failed with `FOREIGN KEY constraint failed: SQLITE_CONSTRAINT
  (extended: SQLITE_CONSTRAINT_FOREIGNKEY)`, confirming the defect is
  real and reproducible outside the abstract schema analysis.

All of the above testing was done in isolated `/tmp` scratch wrangler
projects with distinct `database_id`s — the shared dev-server D1 state
under `.wrangler/state/v3/d1` was not touched.

## What is explicitly NOT done here

- **Not deployed.** Not moved into `migrations/`. Per instruction: "a
  rewritten table-recreation migration is its own reviewed unit and I
  want to read it first."
- **Not yet exercised by the test suite** — these files are outside
  `./migrations`, so `test/apply-migrations.ts` does not apply them.
  Once approved, moving them into `migrations/` (replacing the original
  0023 file) is the intended next step, at which point the existing
  511/8/519 suite becomes the acceptance gate.
- The nine-table audit that justified touching only `received_devices`
  (the other 8 recreated tables — `shipments` plus 7 FK-leaf tables —
  were confirmed correctly handled by the original 0023) lives in the
  Sprint E consolidated report, not duplicated here.
