# Migration rewrite drafts — under review, NOT deployed, NOT excluded from future adoption

Unlike `migrations-held/`, this directory is not a "never touch this
sprint" holding pen — it is a **reviewable staging area** for a
table-recreation migration rewrite the user explicitly asked to read
before it goes anywhere near `migrations/`.

## What's here (Sprint G ordering — shipments FIRST, received_devices SECOND)

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

**The file order flipped in Sprint G relative to the Sprint F draft.**
Previously `received_devices` ran first (as `0023a`) and `shipments` ran
second (as `0023b`), with `shipment_lines` — a child shared by both
parents — recreated TWICE (once in each file, referencing whichever
parent had already settled by that point). Sprint G's G2 item asked
whether that double recreation (double exposure window, double data copy,
for a table that only needs reshaping once) could be avoided. It can: by
running `shipments` first, `received_devices` second, and having each
parent's own file **defer dropping its own `_old` copy**, `shipment_lines`
can be recreated **exactly once**, in the second file, after both parents
have settled into their final names. That is the design now in place:

- `0023a_shipments_type_widening.sql` — recreates `shipments` (widened
  `shipment_type` CHECK, relaxed `authorisation_id`/`procedure_code`
  nullability) plus its 3 non-shared children (`sent_emails`,
  `shipment_value_deltas`, `shipment_replies`). Its 4-child accounting
  (now 3, with `shipment_lines` deliberately deferred) was already correct
  in the original monolithic 0023. **Deliberately does not drop
  `shipments_old`** — `shipment_lines` still points at it until 0023b.
- `0023b_received_devices_status_and_received_at.sql` — recreates
  `received_devices` (status CHECK +2 values, `received_at` column) with
  the corrected 5 non-shared-child list (adds `repair_jobs` and
  `zoho_batch_devices`, both missed by the original monolithic 0023's
  4-table list, which was written against 0021's schema and never
  re-derived after 0022 added those two tables). Then, in the same file,
  recreates `shipment_lines` **exactly once** — the single shared child —
  referencing both now-final parent tables, and only then drops both
  `shipments_old` and `received_devices_old` together. Contains the full
  Sprint G G1 ON-DELETE audit table and the CASCADE-hazard writeup in its
  header (see below).
- `0023c_removal_flags.sql` — new `removal_flags` table, no recreate
  needed, SQL content unchanged from the original 0023, but its header was
  rewritten in Sprint G to document why running strictly after 0023b's
  final `DROP TABLE received_devices_old` keeps it outside the
  CASCADE-hazard window (see below).

## Why three files instead of one

Per explicit instruction: splitting the recreates into separate numbered
migrations means a partial-batch failure on a real (non-atomic) deploy
records exactly which sub-migration failed in `d1_migrations`, instead of
an opaque internal-statement-offset failure inside one giant file.

## The CASCADE-hazard finding (Sprint F→G) — why `foreign_key_check` alone is not enough

Discovered investigating a reordering where `removal_flags` (0023c) was
placed BEFORE the `received_devices` recreate instead of after it. Unlike
a `NO ACTION` child — which fails loudly (`SQLITE_CONSTRAINT_FOREIGNKEY`)
if its parent is dropped while the child still points at the renamed-away
copy — an `ON DELETE CASCADE` (or, by the same mechanism, `SET NULL`)
child does NOT fail loudly if left out of its parent's zero-window swap.
SQLite still silently rewrites the CASCADE child's stored FK text to the
renamed-away old parent name (the same auto-rewrite-on-RENAME mechanism
that makes the whole zero-exposure-window pattern work in the first
place), but when that old parent is finally dropped, the CASCADE fires
**silently** — the child's rows are deleted, `foreign_key_check` returns
clean, and there is no error anywhere in the migration.

This means every `CHECK`-guard built on `pragma_foreign_key_check()` in
this directory (see below) is **structurally blind** to this failure
class. It can only ever catch `NO ACTION`/`RESTRICT` violations, because
those are the only ones that leave a dangling reference for
`foreign_key_check` to see — a CASCADE/SET NULL child's rows are just
gone, with a perfectly consistent (because now-smaller) database left
behind. Empirically demonstrated (`/tmp/f2-bystander`, `/tmp/f2-bystander2`,
`/tmp/f2-hazard`, all cleaned up): a bystander CASCADE-child table left out
of its parent's own swap went from 1 row to 0 rows with zero errors and a
clean `foreign_key_check` afterward.

**Scope, established by Sprint G's G1 re-audit (full table in 0023b's
header):** every child of both `received_devices` and `shipments`,
enumerated by ON DELETE mode, across all of `migrations/0001-0028`. Only
three CASCADE children exist in the whole graph: `print_jobs` and
`grade_audit` (children of `received_devices`, both correctly recreated in
0023b and now verified 1→1 by seeded row count, not merely by
`foreign_key_check`), and `shipment_lines.shipment_id` (a newly-identified
CASCADE case this pass, previously not flagged as such — correctly handled
by the single-recreate in 0023b), plus `removal_flags.received_device_id`
(new table, 0023c, discussed above). No additional silent-loss case was
found beyond the ordering-dependent `removal_flags` hazard. **Sprint E's
"eight of nine correct" verdict**: the outcome survives — no table's
recreate is actually unsafe once implemented as it now is — but the
evidentiary basis does not survive unchanged, since Sprint E's own test
(`foreign_key_check`) never seeded `print_jobs` or `grade_audit` and could
not have detected a CASCADE-class failure in either even if one had
existed. This pass closed that gap by seeding both directly and confirming
1→1 preservation by row count against the actual committed files.

**Mitigation on live impact, stated explicitly so this doesn't read as
more alarming than it is**: `removal_flags` does not exist in production
(F1: zero matches at `6cbe4e2`) and 0023c is what creates it — so at
deploy time there are zero rows for any misordering to destroy on THIS
specific run. The hazard is real for correctness, for any future re-run of
this migration set against a database that already has `removal_flags`
rows, and for any as-yet-unenumerated CASCADE child introduced by a future
migration — but it is not currently pointed at live data.

## What was empirically established (not assumed) before writing these

- `PRAGMA defer_foreign_keys = TRUE` does NOT prevent the `DROP TABLE`-
  triggered FK failure in D1's local engine — tested fresh in an isolated
  scratch wrangler project; fails identically to the already-known
  `PRAGMA foreign_keys = OFF` ineffectiveness from 0021 REVISION-2/3.
  Re-verified again in Sprint G against a real
  `wrangler d1 migrations apply --local` run: neither pragma changes D1's
  enforcement of an implicit DELETE from DROP TABLE.
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
  testing, not code review alone. **This guard is structurally blind to
  the CASCADE-hazard finding above** — it can only catch `NO ACTION`
  violations, never a silent CASCADE/SET NULL row loss. CASCADE/SET NULL
  children in this rewrite are verified separately, by seeded
  before/after row count, not by this guard.
- Positive test: with the project's real `migrations/0001-0022_*.sql`
  applied, and exactly 1 seeded `repair_jobs` row + 1 seeded
  `zoho_batch_devices` row (matching the flagged race-condition
  severity — not an exaggerated "many rows" case), `0023a`→`0023b`→
  `0023c` all applied cleanly, both row counts were preserved, and
  `PRAGMA foreign_key_check` returned empty afterward.
- Negative test: a deliberately-reintroduced copy of the original bug
  (repair_jobs handling stripped back out of 0023b) correctly FAILED
  against the same seeded state, confirming the underlying SQLite FK
  check is itself a real safety net for this failure class, independent
  of the explicit guard (which exists for other, non-DROP-triggered
  inconsistency classes). Re-run in Sprint G against the new file
  ordering/content (`/tmp/g3-neg`) with the same result.
- Sprint G, G1: seeded `print_jobs` and `grade_audit` (the two
  `received_devices` CASCADE children, never previously row-tested) with
  real rows and confirmed 1→1 preservation by direct row count against
  the actual committed files (`/tmp/g1-cascade-audit`), closing the
  evidentiary gap described above.
- Sprint G, G2: built and validated (both positive, with a realistic
  multi-table shape, and negative, with a deliberately-broken variant) the
  single-shipment_lines-recreate design now in `0023b`
  (`/tmp/g2-single-recreate`, `/tmp/g2-negtest`).
- Sprint G, end-to-end: full `0023a`→`0023b`→`0023c` sequence in its final
  form, seeded with a row in every one of the 9 originally-recreated
  tables plus every 0023b child, run against a realistic base schema
  (`/tmp/g3-combined`) — zero row loss, clean `foreign_key_check`, no
  leftover `_old`/`_new` tables. Negative-tested (`/tmp/g3-neg`): omitting
  `repair_jobs` from the candidate `0023b` still fails loudly at the
  correct point.
- Sprint F: confirmed SQLite rewrites a table's OWN self-referencing FK
  text on its own rename, not just other tables' FK text pointing at it
  (`/tmp/f2-selfref`) — relevant to `shipments.related_export_shipment_id`.
- Authoritative, non-synthetic reproduction of the ORIGINAL defect: the
  project's actual `migrations/0001-0022_*.sql` plus the actual
  production `migrations/0023_temp_export_standard_and_received_at.sql`
  file (not hand-retyped) were applied against the same 1-row seed and
  failed with `FOREIGN KEY constraint failed: SQLITE_CONSTRAINT
  (extended: SQLITE_CONSTRAINT_FOREIGNKEY)`, confirming the defect is
  real and reproducible outside the abstract schema analysis.

All of the above testing was done in isolated `/tmp` scratch wrangler
projects with distinct `database_id`s — the shared dev-server D1 state
under `.wrangler/state/v3/d1` was not touched by any of it.

## What is explicitly NOT done here

- **Not deployed.** Not moved into `migrations/`. Per instruction: "a
  rewritten table-recreation migration is its own reviewed unit and I
  want to read it first."
- **Not yet exercised by the test suite** — these files are outside
  `./migrations`, so `test/apply-migrations.ts` does not apply them.
  Once approved, moving them into `migrations/` (replacing the original
  0023 file) is the intended next step, at which point the existing test
  suite becomes the acceptance gate.
- The full G1 ON-DELETE audit table (recreated parent / child / ON DELETE
  mode / handled / row-count evidence) lives in `0023b`'s file header, not
  duplicated here in full — this README summarizes its conclusions only.
