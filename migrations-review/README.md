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
  `shipments_old`** — `shipment_lines` still points at it until 0023b. Its
  three own indexes (including the UNIQUE `idx_shipments_org_ref`) ARE
  dropped and recreated in-file, immediately after the rename, under the
  M6 pattern below — not deferred to a later file (an earlier draft of
  this fix proposed exactly that deferral and it was rejected; see M6).
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
  needed; its `CREATE TABLE` and index statements are functionally the
  same as the original 0023 (`IF NOT EXISTS` was added to the table
  statement per M3, so "unchanged" no longer describes it byte-for-byte),
  and its header was rewritten in Sprint G to document why running
  strictly after 0023b's final `DROP TABLE received_devices_old` keeps it
  outside the CASCADE-hazard window (see below).

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
enumerated by ON DELETE mode, across all of `migrations/0001-0028`. Four
CASCADE children exist in the whole graph: `print_jobs` and
`grade_audit` (children of `received_devices`, both correctly recreated in
0023b and now verified 1→1 by seeded row count, not merely by
`foreign_key_check`), `shipment_lines.shipment_id` (a newly-identified
CASCADE case this pass, previously not flagged as such — correctly handled
by the single-recreate in 0023b), and `removal_flags.received_device_id`
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

## The index/trigger/view-loss finding (M2/M5/M7) — a SECOND blindness, parallel to the CASCADE one

The CASCADE-hazard finding above says the test battery cannot see a
silently-deleted *row*. There is a second, independent blindness in the
same battery, discovered this pass: it cannot see a silently-lost
*schema object* either — an index, trigger, or view — because every test
in this directory asserts row counts and `foreign_key_check` results,
never `sqlite_master` contents.

This was not a hypothetical concern. `shipments` carries three named
indexes, including the UNIQUE `idx_shipments_org_ref` on
`(organisation_id, reference)`. The `RENAME` in 0023a's original
zero-exposure-window swap carries all three names to `shipments_old`
along with the table; because `shipments_old` is deliberately kept alive
until 0023b drops it, those three names stayed claimed by `shipments_old`
for the rest of 0023a's own file. The original version of 0023a
recreated the three indexes with `CREATE INDEX IF NOT EXISTS` at the end
of the file — which found the names already taken and **silently
no-oped**. Measured directly (not assumed) by querying
`pragma_index_list('shipments')` and `sqlite_master` after applying the
full 0001–0022 + 0023a + 0023b + 0023c sequence against a fresh scratch
DB: **0 of 3 indexes existed on the final `shipments` table**, including
the UNIQUE constraint, with a clean `foreign_key_check` and zero errors
throughout the whole run.

The significant consequence is not the defect itself but what it says
about the existing green results: `/tmp/g3-combined`'s end-to-end test
(zero row loss, clean `foreign_key_check`, no leftover `_old`/`_new`
tables) passed WHILE this was happening. All three of its assertions
were true at the same time a uniqueness constraint silently evaporated.
That is the same class of gap as a previously-fixed `BillDetailView()`
false-green bug elsewhere in this project: the check was real and passed
legitimately, but its coverage was narrower than its passing result
implied. `/tmp/g3-combined`'s result is accordingly demoted from *proof*
that the rewrite is safe to *partial proof* — proof of row/FK safety
only, not of schema-object safety.

**The fix taken (M6)**: explicit `DROP INDEX` statements immediately
after the `shipments` rename in 0023a itself (same file, not deferred to
0023b), freeing the three names, followed immediately by `CREATE INDEX`
without `IF NOT EXISTS` (a collision at that point, with the names just
freed, would mean something upstream is structurally wrong and should
fail loudly rather than vanish a second time). **Tightened (Sprint G
follow-up, 2026-08-20)**: the three `CREATE INDEX` statements were
originally placed after the three shipments-family children's own
`DROP TABLE`/`RENAME` statements, leaving the constraint-free window
spanning those ~9 intervening statements rather than the single statement
an earlier pass of this note claimed. They now sit directly after the
`DROP INDEX` block, before the children's `DROP TABLE`s — a pure
reorder, no behavioural change — so the window is the 3 `DROP INDEX` +
3 `CREATE INDEX` statements sitting immediately adjacent inside 0023a. A
cross-file deferral fix — moving the three `CREATE INDEX`
statements into 0023b, after 0023b's own `DROP TABLE shipments_old` — was
considered and rejected: it would leave the live, final-shaped
`shipments` table with **no uniqueness constraint at all** on
organisation/reference for the entire window between 0023a completing
and 0023b completing, which on a stalled non-atomic deploy could stay
open indefinitely while the app keeps writing, and any duplicates
admitted during that window would then make the eventual
`CREATE UNIQUE INDEX` fail against real data — turning a recoverable
stall into a data-repair job. The same explicit-drop-then-recreate
pattern was checked against every table 0023b itself recreates
(`received_devices` and its five non-shared children, plus
`shipment_lines`) and found to be unnecessary there: none of those tables
are left alive under their old names past the point their own indexes
are recreated (each old copy is fully `DROP TABLE`d — not
renamed-and-deferred — before its name's `CREATE INDEX IF NOT EXISTS`
statement runs), so `IF NOT EXISTS` there is an ordinary re-run guard,
not a mask over a live collision. See 0023a's and 0023b's own headers for
the full statement-by-statement reasoning.

**Triggers and views were checked too, not left as an unmeasured
category.** The same `sqlite_master` query, filtered to
`type IN ('trigger','view')`, was run against the same full sequence for
all eleven tables touched by 0023a+0023b+0023c: the result set is empty.
Zero triggers and zero views exist anywhere in this codebase's schema —
not a gap in the check, a measured absence. There is currently nothing in
either category for any of these recreates to lose, and this must be
re-confirmed by the same query if a future migration ever introduces the
first trigger or view in this codebase.

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
  before/after row count, not by this guard. **Guard-strength comparison,
  the two guards are not equally strong**: 0023a's own terminal guard
  runs while `shipments_old` still exists and `shipment_lines` is still
  pointing at it — that is legitimate and expected at that point (by
  design, shipment_lines is not repointed until 0023b), not a defect, but
  it means 0023a's guard cannot see the shipments graph as fully settled.
  Only 0023b's terminal guard, which runs after `shipment_lines` has been
  repointed and both `_old` parents dropped, carries that stronger
  meaning. A green 0023a run in isolation is not proof the shipments graph
  is settled; only a green 0023b run is.
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
- Sprint G follow-up, M2 (index-name collision, measured not assumed):
  the `(name, tbl_name, unique)` triple for every index on `shipments`
  was compared against the pre-0023 baseline after applying the full
  0001–0022 + 0023a + 0023b + 0023c sequence in a fresh scratch DB.
  Before the M6 fix: **0 of 3 present** (`idx_shipments_org`,
  `idx_shipments_auth`, and the UNIQUE `idx_shipments_org_ref` all
  silently no-oped against the already-claimed names on `shipments_old`).
  0023b's own recreated tables (`received_devices` and its five children,
  plus `shipment_lines`) were checked in the same run and were fully
  intact — this defect was confined to `shipments`' three indexes only.
  **Re-run against the M6-fixed files, in the same commit that applied
  the fix: 3 of 3 present, names and `unique` flags matching the
  pre-0023 baseline exactly** — see that commit's message for the exact
  query output.
- Sprint G follow-up, M7 (trigger/view completeness, measured not
  omitted): `SELECT type, name, tbl_name FROM sqlite_master WHERE type IN
  ('trigger','view')` run against the same full sequence, for all eleven
  tables touched by 0023a+0023b+0023c, returns an empty result set. Zero
  triggers and zero views exist anywhere in this codebase's schema — a
  measured absence, not an unmeasured category. Re-confirmed against the
  M6-fixed files in the same commit/run as the M2 re-check above.
- Sprint G follow-up, post-`e53a536` seeded row-preservation re-run
  (closing the M1 evidence gap): all prior seeded-row evidence in this
  file predates M1 (`received_at` ALTER removal, which changed the
  `INSERT...SELECT` column-list shape on `received_devices` — the one
  edit in that commit capable of silently misaligning a column during
  the copy). Re-run fresh, against the `e53a536`-committed file content
  exactly, in a two-phase scratch DB (real `migrations/0001-0022*.sql`
  applied first, then one seed row inserted directly into the pre-0023
  schema for every one of the 11 tables 0023a/0023b touch, THEN
  0023a→0023b→0023c applied on top): all 11 tables — `shipments` +
  `sent_emails`/`shipment_value_deltas`/`shipment_replies`;
  `received_devices` + `device_events`/`print_jobs`/`grade_audit`/
  `repair_jobs`/`zoho_batch_devices`; `shipment_lines` — confirmed 1→1,
  every non-key column value read back unchanged (including the
  `supplier_id=901` marker seeded specifically to catch M1-style
  column-list misalignment, which survived exactly). `received_at`
  itself: read back `NULL` immediately after the recreate (matching the
  fix's stated intent, since it has no pre-existing value anywhere to
  preserve), then confirmed genuinely present/writable via a follow-up
  `UPDATE ... SET received_at = <timestamp>` + read-back round-trip
  (mimicking the real backdating flow in `scan.ts`). `removal_flags`
  (0023c, not a recreate but included for completeness) accepted an
  insert cleanly. `PRAGMA foreign_key_check` empty, `d1_migrations`
  shows all 25 files recorded, no leftover `_old`/`_new`/
  `__fk_check_guard` tables. Negative test also re-run against this same
  committed 0023b content (not assumed still valid from the earlier
  pre-fix `/tmp/g3-neg` run): a scratch copy with `repair_jobs` handling
  stripped back out still fails loudly with `SQLITE_CONSTRAINT_FOREIGNKEY`
  on 0023b, with 0023a's changes (including its 3/3 recreated indexes)
  left intact and no partial 0023b artifacts persisted — confirming D1's
  local engine treats each migration file as its own failure/rollback
  unit. Narrowed index re-check (replacing the weaker "full expected
  index sets" method used for the original M2 write-up): the
  `(name, tbl_name, unique)` triple for all three UNIQUE indexes in the
  touched graph — `idx_shipments_org_ref` (unique=1),
  `idx_zoho_batch_devices_unique` (unique=1), `idx_shipment_lines_unique`
  (unique=1) — confirmed present against the pre-0023 baseline in the
  same run; the other 8 non-unique indexes were not re-verified by this
  stricter method, per instruction that only the constraint-bearing three
  warrant it. All scratch dirs used for this re-run were cleaned up
  afterward; the shared dev-server D1 state was not touched.
- **Local-versus-hosted atomicity — scope of the negative-test finding
  above, stated explicitly.** The negative test two entries up (stripping
  `repair_jobs` handling back out of a scratch copy of 0023b) showed
  0023a's changes staying intact with no partial 0023b artifacts
  persisted after 0023b failed. That result is specific to
  **`wrangler d1 migrations apply --local`** (the local D1 engine, which
  this whole review has run against exclusively) — it demonstrates that
  *this* local engine treats each migration *file* as its own
  failure/rollback unit. It does **not** answer the outstanding
  hosted/remote D1 atomicity question: nothing here has been run against
  a real Cloudflare-hosted D1 database, and the local result is not
  evidence either way for whether hosted D1 rolls back a failed file the
  same way. Two further limits, unaddressed by this or any other finding
  in this file: (1) **9-file batch atomicity is unaddressed** — even
  granting per-file rollback, nothing here shows what happens to files
  that already committed earlier in the same `wrangler d1 migrations
  apply` invocation if a later file in that batch fails (i.e. whether the
  whole batch is transactional, or each file's commit is independent and
  irreversible once done); and (2) **this finding does not reduce the
  need for the M6 fix** — the DROP-INDEX/CREATE-INDEX exposure inside
  0023a that M6 fixes is a real window regardless of what the answer to
  either atomicity question turns out to be, since it exists even within
  a single file's own statement sequence. This addendum does not alter
  the pessimistic "assumed, unverified" framing already carried by
  0023a's/0023b's/0023c's own `DROP TABLE IF EXISTS` prologues and
  RE-RUN SAFETY notes — those remain written for the worst case
  (non-atomic hosted deploy) on purpose.

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
  0023 file) is the intended next step. **Post-M2, the existing test
  suite by itself is NOT a safe acceptance gate for that step** — it
  proved capable of passing green (`/tmp/g3-combined`) while a UNIQUE
  index was silently lost, because its assertions cover rows and FK
  consistency only. Making the move safe requires either adding a
  schema-snapshot assertion (comparing `sqlite_master`'s `(name,
  tbl_name, unique)` triples, and ideally trigger/view names, against the
  pre-migration baseline) to the adoption criteria, or treating the
  manual `sqlite_master` checks performed in this review as a
  once-only substitute that must be re-run if these files are edited
  again before the move.
- The full G1 ON-DELETE audit table (recreated parent / child / ON DELETE
  mode / handled / row-count evidence) lives in `0023b`'s file header, not
  duplicated here in full — this README summarizes its conclusions only.
