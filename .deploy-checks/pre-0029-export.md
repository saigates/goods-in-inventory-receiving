# Pre-0024–0029 deploy export (production, before this deploy)

- Date: 2026-08-18 (this pass, revised after control-plane visibility issue
  was resolved)
- Trigger: `gsk hosted d1_query` initially confirmed working (prior pass),
  then found to return `resource_not_found` again in a follow-up pass under
  this session's GSK_PROJECT_ID (d6aea290-...). Escalated rather than
  proceeding. User resolved it from their side (see below) — this was a
  control-plane / session-binding visibility gap, NOT data loss and NOT a
  wrong-target risk.

## Production identity — positively confirmed this pass

- **Production hostname**: https://d6aea290-bd61-4f82-aa8d-94378b9f2fec.vip.gensparksite.com
  (matches this session's own GSK_PROJECT_ID — confirmed via README.md).
- `GET /api/health` → `{"ok":true,"ts":"2026-08-18T15:2x:xx.xxxZ"}` (200) —
  our actual app, not a stray/unrelated worker.
- `GET /tracker/` → 200, serves "Goods In — Master Checklist" (our real
  tracker page, 88446 bytes).
- `GET /static/app.js` pulled and md5-compared against every git revision of
  public/static/app.js: **exact match to commit 5978311** (last commit to
  touch app.js before 6cbe4e2). No commit between 5978311 and 6cbe4e2 touches
  app.js, and no commit AFTER 6cbe4e2 matches (later commits — 278299b,
  a3add76, 9df135d, 44f6d4e, 8c71b2d, 7b3d590 — all touch app.js and none
  hash-match). This positively confirms production is running **6cbe4e2**,
  exactly as README.md's deploy history claims (deployed 2026-08-11).
- The `ff2edf75-4d0d-4beb-9330-ba7f69646d48.vip.gensparksite.com` worker
  surfaced by `gsk hosted list` under a DIFFERENT project id is CONFIRMED
  NOT OURS — user fetched its /api/health and got an HTML "Phone Repair
  Management System" login page (Tailwind login screen, quote/invoice print
  areas), not our JSON health shape. Unrelated project sharing account
  visibility. No mis-binding occurred; nothing to fix on our side.

## Export artifact — retrieved and independently verified this pass

- Download URL: https://www.genspark.ai/api/files/s/4aMkF1tG
  (file-wrapper URL — requires authenticated session; plain curl gets 403,
  DownloadFileWrapper tool succeeds. This is expected behavior, not evidence
  of a broken/fake artifact.)
- Retrieved via DownloadFileWrapper → /home/user/prod-export.sql (1,731,470
  bytes, 6147 lines).
- File terminates cleanly (`;\n`, no truncation).
- 24 `CREATE TABLE` statements, table names match expected schema
  (expected_devices, received_devices, shipments, shipment_lines, manifests,
  opr_authorisations, users, etc. — plus d1_migrations).
- 5,780 total `INSERT INTO` statements — matches the prior pass's reported
  record count exactly.
- Loaded into an in-memory sqlite3 DB (Python stdlib) and queried directly —
  not just grepped — to get real GROUP BY semantics.

## RAW, un-collapsed grade × condition cross-tab (the actual gate check for
## migration 0030, run properly this time — no UPPER() folding anywhere)

```
SELECT grade, condition, COUNT(*) FROM expected_devices GROUP BY grade, condition;

('A',  'REFURBISHED', 197)
('A',  'Refurbished', 218)
('C',  'Raw',          19)
('C',  'Used',         11)
('UG', 'Raw',           6)
('UG', 'UG',          296)
('UG', 'Used',          9)
sum: 756
```

This is the true seven-cell distribution, SQLite's default (case-sensitive,
BINARY-collation) GROUP BY — confirmed no grade value other than A/C/UG
exists in production (grade='B' count = 0), and confirmed 5 distinct raw
condition strings exist (REFURBISHED, Raw, Refurbished, UG, Used — i.e. the
'Refurbished'/'REFURBISHED' case split is real and exactly as documented in
src/lib/condition.ts's audit comment).

**This exactly matches migration 0030's audited baseline, cell for cell.**

## Resolved: the "30 vs 20 USED" open arithmetic question from the prior pass

Migration 0030's comment states post-migration USED should total 30. A naive
sum of rows currently LABELED 'Used' gives 11 (C/Used) + 9 (UG/Used) = 20 —
this was flagged as an unreconciled discrepancy.

Resolved by deriving from GRADE (not from today's condition label), which is
what deriveConditionFromGrade() / migration 0030 actually do:
  - USED  = COUNT(grade='C')  = 19 + 11 = 30  ✓ (grade B doesn't exist, 0 rows)
  - RAW   = COUNT(grade='UG') = 6 + 296 + 9  = 311 ✓
  - REFURBISHED = COUNT(grade='A') = 197 + 218 = 415 ✓
  - 415 + 30 + 311 = 756 ✓

The 9 rows currently labeled condition='Used' but graded 'UG' derive to RAW
post-migration (grade wins), not USED — that's the entire source of the
20-vs-30 gap. No data anomaly; migration 0030's stated totals are correct.

## Deploy scope for THIS deploy

~~Migrations 0024-0029 only.~~ **CORRECTION (2026-08-19, in-place addendum,
file not renamed):** this was wrong. Direct evidence from this same export's
own `d1_migrations` table (grepped precisely: `INSERT INTO "d1_migrations"`
lines) shows only IDs 1-22 ever applied to production — nothing for `0023`
or higher. Independently confirmed by inspecting this export's own
`received_devices` CREATE TABLE (lines ~100-122): production's live
`status` CHECK constraint does NOT include `TEMP_EXPORTED_STANDARD` /
`RETURNED_UNDER_STANDARD`, the two values migration 0023 adds — so 0023
itself has never run against production. **The true undeployed/held set is
0023 through 0029 (seven files), not 0024-0029 (six).** No evidence was
found anywhere in git history of a separate 0023-only deploy between
`6cbe4e2` (2026-08-11, last confirmed production deploy) and now; commit
`b9d2dcc` (introducing 0023) landed one day after `6cbe4e2`, and no commit
in between mentions a deploy action. This correction also propagates to
`migrations-held/README.md` and `README.md`'s stale "22 migrations" line —
see those files' own 2026-08-19 notes. This does not change 0030's
held-back status, which remains for the separate, additional reason stated
below.

0030 is explicitly HELD BACK per user instruction
(recreate-and-copy over 756 live expected_devices rows; deploy separately
once tooling has proven itself further). The raw cross-tab above IS the
gate check required immediately before 0030's eventual deploy — captured
now, to be re-verified fresh (not reused) immediately before that migration
actually runs, since production data may have changed in the interim.

## D1 forensics on migration 0023 itself — BLOCKING DEFECT FOUND (2026-08-19)

Per explicit sprint instruction, migration 0023
(`0023_temp_export_standard_and_received_at.sql`) was read in full and
checked against production's live schema (this same export file) before
any deploy attempt. Three required answers, verbatim:

1. **Does it recreate `received_devices`?** Yes — full recreate-and-copy
   (`CREATE received_devices_new` / `INSERT ... SELECT` / `DROP
   received_devices` / `RENAME received_devices_new TO received_devices`),
   to widen the `status` CHECK by two values.

2. **Does the `INSERT INTO ... SELECT` enumerate every column present in
   the live production schema (this export's lines 100-122), or a stale
   list?** The column list itself is NOT stale — diffed programmatically,
   0023's `received_devices_new` CREATE and INSERT column lists are exactly
   production's 23 pre-existing columns (`id` through `supplier_id`) plus
   the one new `received_at` column, in the same order, nothing added or
   dropped. **Correction (2026-08-20):** this entry originally said "22
   pre-existing columns" — an off-by-one in the count, not in the list
   itself. This export's own `received_devices` CREATE TABLE (lines 100-122
   inclusive — 23 lines, one column declaration per line) re-derives the
   correct figure as 23; `id` through `supplier_id` is 23 names, not 22.
   No column was ever dropped or added by 0023 — this was a counting error
   in this write-up, not a defect in the migration. **However**, see
   finding 3 below — the migration is unsafe for an entirely different
   reason than a stale column list.

3. **Every table carrying a foreign key into `received_devices`, and what
   happens to those references during the recreate:** grepped this export
   file directly (`REFERENCES received_devices` / `REFERENCES
   "received_devices"`) and found **six** referencing tables, not the four
   migration 0021's REVISION-3 fix (and 0023's own header comment, which
   explicitly claims a "combined 9-table recreate" covering exactly those
   four) accounts for:
   - `device_events.device_id` — recreated by 0023 (`device_events_new`,
     repointed). Handled.
   - `shipment_lines.received_device_id` — recreated by 0023
     (`shipment_lines_new`, repointed). Handled.
   - `print_jobs.received_device_id` (`ON DELETE CASCADE`) — recreated by
     0023 (`print_jobs_new`, repointed). Handled.
   - `grade_audit.received_device_id` (`ON DELETE CASCADE`) — recreated by
     0023 (`grade_audit_new`, repointed). Handled.
   - **`repair_jobs.device_id`** (created by migration 0022, `NOT NULL
     REFERENCES received_devices(id)`, no `ON DELETE` action specified —
     i.e. `NO ACTION`) — **NOT mentioned anywhere in 0023, not recreated,
     not repointed.**
   - **`zoho_batch_devices.device_id`** (also created by migration 0022,
     identical `NOT NULL REFERENCES received_devices(id)`, `NO ACTION`) —
     **also not mentioned anywhere in 0023.**

   0023's own header comment lists exactly what it believes are "all four
   children with any FK pointing at received_devices" (device_events,
   shipment_lines, print_jobs, grade_audit) — this is the same class of
   miscount migration 0021's REVISION 2 made and had to correct in
   REVISION 3 (see 0021's own extensive header comment on that incident),
   except this time nobody caught it: `repair_jobs` and
   `zoho_batch_devices` did not exist yet when 0021 was written (they were
   both introduced one migration later, by 0022), so 0021's accounting was
   correct for the schema at the time — but 0023 was written AFTER 0022
   and inherited 0021's four-table list without re-deriving it against the
   schema as it stood by 0023's own time, missing the two NEW children
   0022 had just added.

   **Consequence, reproduced empirically** (minimal in-memory sqlite3
   test, `PRAGMA foreign_keys = ON`, mirroring D1's enforcement per 0021's
   own verified finding that D1 cannot disable FK enforcement mid-migration):
   `repair_jobs`/`zoho_batch_devices` are `NO ACTION` children exactly like
   `device_events`/`shipment_lines` were before 0021's REVISION-3 fix —
   which per that fix's own established finding means `DROP TABLE
   received_devices` is BLOCKED (not silently corrupted — outright
   blocked) with `FOREIGN KEY constraint failed` the instant either table
   has even one row referencing a `received_devices` row. Confirmed via a
   from-scratch two-scenario test: (a) with a `repair_jobs` row present,
   `DROP TABLE received_devices` raises `sqlite3.IntegrityError: FOREIGN
   KEY constraint failed`; (b) with `repair_jobs`/`zoho_batch_devices`
   empty (0 rows each — production's ACTUAL current state, confirmed via
   0023's own header comment: "print_jobs=0, grade_audit=0 also
   confirmed" — though notably that comment never states `repair_jobs`/
   `zoho_batch_devices` counts, because it never considered those tables
   at all), the DROP succeeds cleanly.

   **This means migration 0023, AS WRITTEN TODAY, would only fail loudly
   (not corrupt data) if it were deployed at a moment `repair_jobs` or
   `zoho_batch_devices` has any rows** — and per `src/lib/repairWorkflow.ts`
   line 77 (`INSERT INTO repair_jobs (...)`), that table is an ACTIVE,
   currently-shipped feature (introduced by the same `b9d2dcc` sprint that
   introduced 0023 itself), not a placeholder. It is not populated in the
   md5-verified 2026-08-18 production export (0 rows, confirmed via
   `INSERT INTO "repair_jobs"` grep returning zero matches), so 0023 would
   likely still succeed if deployed RIGHT NOW against that exact snapshot —
   but this is a live, actively-written table, not a static one, so that
   safety window is not guaranteed to still hold by the time any deploy
   actually runs, and `zoho_batch_devices` is written by the (separate,
   unconfirmed-active) Zoho batch flow.

   **Branch outcome (per the sprint's own explicit branching instruction):
   an inbound FK would break — deploy track for 0023-0029 STOPS.** Per the
   same instruction, no attempt has been made to fix 0023 in this pass —
   rewriting a table-recreation migration is its own reviewed unit, and the
   fix pattern is not novel (0021 REVISION 3's dependency-order approach
   for exactly this NO-ACTION-child class of failure applies directly:
   `repair_jobs_new` and `zoho_batch_devices_new` need to be added to the
   same dependency-ordered create/copy/drop/rename sequence, created and
   repointed before any table that references `received_devices` is
   dropped) — but that rewrite itself, and its own from-scratch
   seeded-database verification against `wrangler d1 migrations apply
   --local` (per 0021's own established verification standard — an
   empty-DB test would not catch this, exactly as 0021's REVISION-2
   post-mortem already documented for the cascade-wipe case), is deferred
   to its own pass, not bundled into this one.

   0023 also does not touch `PRAGMA foreign_keys` anywhere (confirmed via
   grep — zero matches) — consistent with 0021's own established finding
   that D1 does not support toggling FK enforcement mid-migration and that
   attempting it is not "the fix."

## Rollback statement (per sprint instruction, written before any deploy attempt)

Given the finding above, this cannot be written as the simple "bundle-only
redeploy of `6cbe4e2`" case: **0023 is confirmed to include a
recreate-and-copy of `received_devices` and five other tables**, not an
additive-only change. Since the D1 forensics above found 0023 itself
defective and the deploy track is stopped before any deploy is attempted,
there is no post-deploy state to roll back FROM — but stating what recovery
would look like if this had been missed and deployed anyway, honestly, per
the instruction that an inability to write this paragraph is itself an
abort: if `repair_jobs`/`zoho_batch_devices` were non-empty at deploy time,
the migration's own `DROP TABLE received_devices` statement would fail with
`FOREIGN KEY constraint failed` — per the "DDL transactional caveat" in
`gsk-hosted-deploy`'s own skill doc, D1's HTTP API has no atomic
multi-statement DDL, so the statements before the failing `DROP` (the
`CREATE ... _new` tables and their `INSERT ... SELECT` copies) would already
be committed, leaving production in a **partial, non-bundle-revertible
state**: the original `received_devices`/`shipments` tables still present
and authoritative (the DROP that would have removed them never succeeded),
but orphaned `*_new` copy tables also present alongside them. Recovery in
that scenario would require manually dropping the orphaned `_new` tables
(safe — they hold copies, not the live data) via `d1_execute`, which
**IS** permitted for that narrow DDL-cleanup purpose since it is not
`d1_rebuild`/`d1_import`/`--with-db` — those three remain absolutely
prohibited per the sprint's own standing instruction, including as a
recovery step, and are not needed here since the live tables were never
touched. This paragraph could be written honestly (the instruction's own
abort condition — "if that paragraph cannot be written honestly, that is
itself an abort" — does not itself trigger), but the underlying finding
(a genuine, reproducible inbound-FK defect in 0023) is the actual abort
trigger per the D1 branch rule, independent of whether the rollback
paragraph itself was writable.

## Durability — resolved this pass

- `/home/user/prod-export.sql` (sandbox, ephemeral) — md5 88185e6e61014db4ed1be34074bd29e3
- Copied to `/mnt/aidrive/prod-export-2026-08-18-pre-0029.sql` (user's own
  AI Drive, outside the sandbox lifecycle) — md5-verified byte-identical.
- This satisfies "confirm retrievable independently of the given URL, or
  copy it somewhere that outlives the session" — the actual export DATA now
  lives in a location the user controls directly, not just a link to it.

## Coverage note (recorded per explicit user request, not a bug)

Grade `B` has **zero rows** in production (`COUNT(*) FROM expected_devices
WHERE grade='B'` = 0, confirmed in the raw cross-tab above — only A/C/UG
appear). Consequence: `deriveConditionFromGrade()`'s `B → USED` branch
(`src/lib/condition.ts`) is currently exercised **only by its unit test**,
never by live data. Not a defect — just a confidence/coverage fact worth
having on record before 0030 (which depends on that function) ships.

## Migration-mechanics investigation for the 0024–0029 deploy (this pass)

**Question**: does `gsk hosted deploy` apply migrations itself (so
schema-first ordering is guaranteed), or is that a separate manual step?

**Finding — re-test of `gsk hosted d1_query` under the confirmed project id
(d6aea290-...) FAILED again**, this time consistently across every read-only
`gsk hosted` probe tried:

```
d1_query      -> resource_not_found: "No D1 database deployed for project
                 d6aea290-...  Deploy with --with-db first."
d1_schema     -> resource_not_found: same message
worker_get    -> resource_not_found: "No worker deployed for project
                 d6aea290-...  Run `gsk hosted deploy` first to create one."
worker_stats  -> resource_not_found: "Stats only exist after a successful
                 deploy."
custom_domain_status -> resource_not_found: "No custom domain is bound..."
list          -> Found 1 hosted resource: the ff2edf75-... worker only
                 (confirmed NOT ours, per above) — zero resources under
                 d6aea290-...
```

This is a **stronger and different** failure than the earlier pass: last
time only D1 reads failed while production was independently confirmed
live. This time EVERY hosted-control-plane read for this project — worker,
D1, stats, custom domain — reports nothing provisioned at all, while an
independent plain HTTPS check in the same moment shows production is still
fully live and unchanged:

```
GET /api/health -> 200 {"ok":true,"ts":"2026-08-18T16:20:45.327Z"}
GET /tracker/   -> 200
```

Interpretation: the `gsk hosted` control plane currently cannot see ANY
resource for this project — not "the worker exists but D1 doesn't," but
"nothing is registered under this project id at all" from the control
plane's point of view — even though the actual Cloudflare Worker and its D1
data are demonstrably still serving real traffic. This looks like the same
class of session/control-plane visibility gap flagged earlier in this
deploy-check sequence, now worse (covering worker_get/stats/custom_domain
too, not just D1), not a new data-loss event — production traffic and data
are unaffected — but it means the safety rail this deploy explicitly
depends on (confirming `d1_query` works BEFORE trusting `gsk hosted deploy`
to sequence migrations correctly) cannot be exercised right now.

**Per explicit user instruction this pass ("if d1_query still returns
resource_not_found, hold — a worker-only deploy is worse than no deploy"):
this deploy is HELD.** No `gsk hosted deploy` call has been made. No
`--with-db`, `d1_rebuild`, or `d1_execute` call has been made either (all
three remain off-limits per standing instruction regardless of project
identification).

### Secondary findings from the same investigation (retained for when the
### control plane recovers and this is re-attempted)

- **No dedicated "apply migrations" subcommand exists.** `gsk hosted --help`
  lists exactly: `d1_query`, `d1_execute`, `d1_export`, `d1_import`,
  `d1_rebuild`, `d1_schema` for D1, plus worker/R2/secret/custom-domain
  commands. There is no `d1_migrate` / `migrations_apply`.
- **Circumstantial evidence that `gsk hosted deploy` bundles migration
  application into the same approved action** (not a separate step the
  agent must trigger):
  - The `gsk-hosted-deploy` skill documents a deploy action's result schema
    carrying `result.migration_status` (`applied`/`failed`/`seed_applied`/
    `seed_failed`), `result.migration_errors`, and `result.schema_verification`
    (`verified`/`incomplete`/`unavailable`) — fields that only make sense if
    migration application is something the deploy pipeline itself performs
    and reports on.
  - README.md's own deploy history (lines 456-458): "production is on
    commit `6cbe4e2` (deployed 2026-08-11 via an approved `gsk hosted
    deploy` action, 22/22 migrations applied...)" — describing ONE approved
    action that both shipped code and applied all pending migrations, not
    two separate approvals.
  - A second, earlier deploy entry (2026-07-29, lines 361-372) explicitly
    says the redeploy "also re-ran migration 0017 against prod D1 (wrangler
    applies any migration file not yet recorded as applied on that Worker's
    tracking table)" — again describing migration application as an
    automatic, built-in part of the same `gsk hosted deploy` invocation,
    keyed off a tracking table so already-applied migrations are skipped
    (idempotent), not something requiring a separate manual trigger.
  - There is no example anywhere in README's deploy history of a separate
    manual migration-apply step being run against production alongside a
    `gsk hosted deploy` action. Every recorded prod deploy either applied
    pending migrations automatically as part of the one approved action, or
    (the 197-IMEI-manifest-fix redeploy) explicitly noted "no migrations
    pending, so this was a code-only redeploy" — i.e. the deploy pipeline
    itself is what decides whether migrations run, based on what's pending.
  - **Not fully reconciled**: README also documents `npm run
    db:migrate:prod` (lines 294, 413) as a step in the LOCAL-DEV and BYOK
    (bring-your-own-Cloudflare-account) instructions — that script runs
    `wrangler d1 migrations apply webapp-production` directly against a
    user's OWN Cloudflare account, entirely outside the `gsk hosted deploy`
    pipeline. This is the alternate/legacy path for someone deploying to
    their own account (see the `cf-byok-deploy` skill), not evidence
    against automatic migration application under `gsk hosted deploy` —
    the two are different deploy mechanisms for two different account
    setups, not two steps of the same one. Conclusion: no contradiction,
    but this was inferential, not from one single unambiguous sentence
    naming the mechanism explicitly for the `gsk hosted deploy` path.
  - **Overall confidence**: schema-first ordering (migrations landing before
    the new worker version starts serving requests) is very likely achieved
    automatically by `gsk hosted deploy` for THIS deploy mechanism, based on
    the above — but this is inference from documented behavior and a result
    schema, not a single explicit guarantee statement, and it cannot be
    exercised live right now because the control plane read path is down
    for this project. Recommend treating this as "probably fine, but
    unverified for this specific attempt" rather than "confirmed safe."

## Migration content review — 0024, 0025, 0027, 0028, 0029 (this pass)

Read in full (0026 was already confirmed additive in the Check 2 pass).
None of the six drop or rewrite a column; all are additive:

- **0024** (`ce1154_worksheet_rewrite`): 15× `ALTER TABLE shipments ADD
  COLUMN` only (inbound_freight_gbp, non_eu_freight_share_gbp,
  export_freight_gbp, insurance_gbp, value_adjustment_gbp DEFAULT 1.31,
  commodity_code, duty_override_claimed NOT NULL DEFAULT 0,
  entry_accepted_at, entry_cleared_at, supplementary_units,
  entry_duty_base_gbp, entry_vat_base_gbp, entry_duty_gbp, entry_vat_gbp,
  declared_invoice_total_gbp, declared_piece_count,
  declared_gross_weight_kg, misdeclaration_ack_at,
  misdeclaration_ack_by_user_id). No DROP, no rewrite, no table recreate.
- **0025** (`misdeclaration_ack_and_value_adjustment_defaults`): 2×
  `CREATE TABLE IF NOT EXISTS` (shipment_misdeclaration_acks,
  value_adjustment_defaults) + indexes + one seed `INSERT`. Purely
  additive new tables.
- **0027** (`worksheet_input_provenance`): single `ALTER TABLE shipments
  ADD COLUMN worksheet_input_provenance TEXT`. Purely additive.
- **0028** (`bills_cost_ledger_freight`, Sprint B §1-§3 — this is the
  previously-unknown migration): 5× `CREATE TABLE IF NOT EXISTS` (bills,
  bill_close_overrides, bill_lines, bill_line_serials, cost_ledger,
  freight_invoices — 6 tables total) + indexes. No ALTER on any existing
  table. Purely additive new tables.
- **0029** (`manifest_bill_link`): single `ALTER TABLE manifests ADD
  COLUMN bill_id INTEGER REFERENCES bills(id) ON DELETE SET NULL` + one
  index. Purely additive, nullable, `ON DELETE SET NULL` (not CASCADE) so
  it cannot destructively cascade either.

**Confirmed: all of 0024-0029 (plus the already-checked 0026) are additive
only — every statement is `CREATE TABLE IF NOT EXISTS` or `ALTER TABLE ...
ADD COLUMN`. Zero `DROP COLUMN`, zero `DROP TABLE`, zero
recreate-and-copy-data pattern anywhere in the six files.** The user's
premise ("0024-0029 should all be additive, so rollback ought to be
bundle-only") is now independently confirmed true by direct inspection,
not assumed.

## Rollback plan (stated per user request, now with the additive-only
## confirmation above backing it)

- **Bundle rollback**: redeploy git commit `6cbe4e2` via `gsk hosted
  deploy` (that commit is what production is on today, positively
  confirmed above). Since all six pending migrations are additive-only,
  the OLD code at `6cbe4e2` continues to run correctly against a schema
  that has EXTRA (unused-by-it) columns/tables — additive schema changes
  are backward-compatible with older code by construction, so a
  bundle-only rollback is sufficient; there is no scenario among 0024-0029
  where old code would break against the new schema.
- **Data rollback**: the durable export at
  `/mnt/aidrive/prod-export-2026-08-18-pre-0029.sql` (md5-verified) is the
  fallback ONLY if something outside the migrations themselves corrupts
  data (e.g. a bad manual `d1_execute`, which is off-limits anyway) — not
  expected to be needed given the additive-only confirmation above. Using
  it would require `d1_rebuild` (drop+recreate) followed by `d1_import`,
  both destructive/approval-gated operations, and would lose any writes
  made to production between this export and the rebuild.
- **Net**: rollback should be bundle-only in the expected case. Data
  rollback is a documented but unlikely-to-be-needed fallback, gated
  behind operations already prohibited this pass unless the user
  explicitly authorizes them at that time.

## Current status: DEPLOY HELD

Per the user's explicit instruction, this deploy does not proceed while
`gsk hosted d1_query` (and, as newly found, every other hosted-control-plane
read for this project) returns `resource_not_found`. Nothing has been
applied. Next action is to re-test the control plane again before
attempting `gsk hosted deploy` for 0024-0029.

**SUPERSEDED (2026-08-19)**: see the correction addendum earlier in this
file — the true scope is 0023-0029 (seven files), and a blocking D1 defect
was found in migration 0023 itself (missing `repair_jobs`/
`zoho_batch_devices` FK repointing). The deploy track for this batch is
now stopped for that reason, not merely the control-plane instability
described above (which remains separately true and would have held the
deploy regardless).

**AMENDED (2026-09-07) — the "every `gsk hosted` read returns
`resource_not_found` for d6aea290-..., worker/D1/stats/custom_domain all
report nothing provisioned, while production is independently confirmed
live over plain HTTPS" pattern documented above (2026-08-18 entry) is now
understood NOT to be a D1/control-plane fault.** This session's sandbox
account context is shared between two unrelated Genspark accounts
(`saigateslimited@gmail.com`, owner of this project, and a second account
owning an unrelated worker `ff2edf75-...`) and can flip mid-session with
no warning. A `gsk hosted` read issued while the session context had
silently flipped to the OTHER account would see that account's own
resources (correctly reporting `ff2edf75-...` as found, per the `list`
output logged above) and correctly report `resource_not_found` for
`d6aea290-...` — because, from that account's point of view, it genuinely
owns no such resource. This reproduces every symptom recorded above
exactly: total control-plane blindness for this project's id specifically,
zero effect on the actual live Cloudflare Worker (which the flipped
session context has no authority over either way), and the earlier,
milder D1-only version of the same failure a few hours before it. The
original attribution to a "session/control-plane visibility gap" was a
reasonable inference at the time from the evidence available, but the
actual root cause is an identity/session-binding issue on the sandbox
side, not a Cloudflare/D1-side fault. Standing mitigation adopted this
session (Task 0, "Identity gate"): bracket every live `gsk hosted`
command with `gsk login-info` immediately before AND after, and require
`worker_get d6aea290-...` to resolve before trusting any other read for
this project; on failure of either, stop rather than retry, switch
accounts, or fall back to an unqualified command.

**This mechanism is no longer an inference — it has now been directly
OBSERVED three times: the 2026-08-18 incident documented above, a second
occurrence surfaced during the 588/619 forensic investigation, and a third
today (2026-09-07) caught one call apart from a clean success (`gsk
login-info` read `saigateslimited@gmail.com`, `worker_get` resolved
correctly, then a single subsequent `login-info` bracket check — with only
a local file edit in between, no live call — read `sagarsptl@gmail.com`).
The flip is time-driven, not triggered by any specific command: nothing
issued between the two checks could plausibly have caused a control-plane
identity change, which is itself the evidence that this is a session/
account-binding property of the sandbox, external to anything this project
does.**

**+12 test-delta breakdown (562→574, 2026-09-07)** — verified by `git diff 76c51e8 89fb02b` line-count, not retyped from memory: exactly 5 new `it()` blocks added to `test/deviceLifecycle.spec.ts` (the H0 direct-call gate + its "every other edge unaffected" scope test) and exactly 7 new `it()` blocks added to `test/repairWorkflow.spec.ts` (the bulk-path gate cases, numbered #44-#50 in-file) = 12, confirmed as the ONLY two files touched in that diff and the only source of new `it()` blocks — the pre-existing `ALLOWED_TRANSITIONS` data-driven sweep had its loop body edited (added `reasonMetadataFor()` calls) but not its iteration bounds, so it contributed zero to the count. Fresh full-suite re-run this session: 574 passed, 8 skipped, 29 files, 0 failed.

**STEP 5(b) finding (2026-09-07) — H2 eliminated, H1 promoted to rank 1.**
Checked whether `public/static/app.js`'s `BulkTransitionModal()` renders
`skipped` per-row outcomes distinctly from `transitioned`/`error` (H2's
stated premise: "if app.js does not render skipped rows, that presents as
nothing happened, no error"). It DOES:

```js
// public/static/app.js:1227 (current HEAD) / :1196 (production b9310dd)
const outcomeCls = { transitioned: 'badge-green', skipped: 'badge-amber', error: 'badge-red' };
...
// public/static/app.js:1286-1291 (current HEAD) / :1244 area (b9310dd)
allResults.map(r => h('div', { class: 'py-1.5 px-1 text-xs flex items-center gap-3' },
  h('span', { class: 'badge ' + (outcomeCls[r.outcome] || 'badge-slate') }, r.outcome),
  h('code', { class: 'mono flex-1' }, r.imei),
  r.from_status ? h('span', { class: 'text-slate-500' }, r.from_status) : null,
  r.message ? h('span', { class: 'text-slate-400 truncate max-w-xs' }, r.message) : null
))
```

Confirmed present since `278299b` (2026-08-12, `git log -S BulkTransitionModal`)
and byte-verified present, unchanged in shape, in production's currently-deployed
bundle `b9310dd` (`git show b9310dd:public/static/app.js` lines 1196/1244).
An amber badge, the literal word "skipped", the row's `from_status`, and any
server `message` are all rendered per-row in the same progress panel as
successful (`transitioned`, green) and `error` (red) rows — a skipped row is
not silent or indistinguishable, it is a differently-coloured row in the same
list.

**Conclusion: H2 is eliminated as written.** The premise "app.js does not
render skipped rows" is false for both the current codebase and the
currently-deployed production bundle. This finding is a UI-code citation
(source-level, confirming what ships), not yet a live browser-rendered
screenshot citation — a live browser check of the actual bulk-transition
modal showing a mixed batch (some skipped, some transitioned) has NOT been
run this session; per the standing rule that a rendered-verdict claim must
come from a browser check not source inspection, that browser run is the
next step before treating "operators can see skipped rows" as fully proven,
though the source evidence alone is already sufficient to eliminate H2's
specific mechanism as stated.

**H1 (Luhn checksum gate vs iPad alphanumeric Apple serials) is now rank 1**
by elimination, pending its own reproduction — not yet attempted. The
original operator complaint ("nothing happened, no error") remains
UNREPRODUCED under any hypothesis so far; H2's elimination narrows but does
not resolve it.

---

## Deploy of the H0 fix (89fb02b) to production — completed 2026-09-07

Deployed via `gsk hosted deploy d6aea290-bd61-4f82-aa8d-94378b9f2fec`, NOT
raw `wrangler deploy` — this project is hosted on Genspark's managed
Cloudflare account (`account_id: 7d2579beb52424d39cdd02c0983151e9`,
confirmed via `gsk hosted worker_get`), not the user's own BYOK account.
**`gsk hosted deploy` is accepted as the deploy command for this project
going forward.** `account_id 7d2579beb52424d39cdd02c0983151e9` is recorded
here as the durable identity anchor for this project — more reliable than
asserting against an email string, since the shared-sandbox identity
binding has now been observed to flip mid-session (see below).

Sequence: `gsk login-info` (saigateslimited@gmail.com) → `gsk hosted
worker_get` (resolved) → both git remotes confirmed already at `d9d6f61`
(no push needed — `git ls-remote` is independent of `gsk` identity and
was verified separately) → `gsk hosted deploy d6aea290-...` → returned
`code=pending_approval` (destructive-action handshake, not a single
atomic call as originally assumed) → user approved via the sandbox UI
banner → `gsk hosted action_wait` returned `code=ok, state=completed`,
version `f5707718-45bc-4ab2-9c5f-8f4e824e5203` → closing `gsk login-info`
held clean (saigateslimited@gmail.com) — **first clean bracket close in
six attempts.** Deploy log: preflight passed, `No migrations to apply!`
(consistent with the pre-deploy migrations re-check — tip `0031`, nothing
pending), only `/static/app.js` uploaded as a changed asset (3 unchanged).

Post-deploy verification, three independent checks, all agree:
- `curl` production root → HTTP 200.
- Local rebuild at `d9d6f61` (4 independent `rm -rf dist && npm run
  build` runs across two turns) → whole-tree hash
  `c6e68b33c286e5dac0ae90f4588be9ae7616eebb02096c182b1b688eaaf8a6a9`,
  identical every time.
- `curl`'d production's live `/static/app.js` directly → SHA-256
  `c6460563ee6a82fdb74472ba4cd1cf1b6891564e10df6c64db6bc94b3cd7fc23`,
  byte-identical to the local build's `dist/static/app.js`.

**The H0 bulk-transition reject/un-reject authorization-bypass fix is
confirmed live in production.** Bulk transitions to/from REJECTED are now
manager-only and reason-code-required, matching the single-device path.
The interim operational instruction to avoid the bulk screen for REJECTED
is withdrawn.

Both `origin/main` (GitHub) and `genspark/main` (SB-Git) reconciled and
confirmed at `d9d6f61` via `git ls-remote`, checked independently across
two separate turns with identical results both times — no commit exists
only on sandbox disk.

### Identity flip #7 — new failure mode observed

Immediately after the successful deploy and its closing `login-info`
check, a subsequent `gsk hosted d1_query` call (unrelated to the deploy
itself, part of the queued forensic work) failed with
`resource_not_found: "No D1 database deployed for project
d6aea290-..."`, and a follow-up `gsk hosted worker_get` on the same
project failed with `resource_not_found: "No worker deployed for
project d6aea290-..."` — for a project that had returned a clean
`code=completed` with a live deployment_url twice earlier in the same
turn, and was independently confirmed reachable via a direct `curl` to
its public URL around the same time. `gsk login-info` immediately after
confirmed the binding had flipped to `sagarsptl@gmail.com`. This is the
same flip mechanism observed on 2026-08-18 and in the 588/619
investigation, producing `resource_not_found` (not a permission error)
because from the wrong account's perspective the project genuinely isn't
in its namespace — consistent across all observed instances, not a new
error shape. **Confirmed: this flip occurred strictly AFTER the
deploy's own closing bracket had already succeeded** — the irreversible
action (the deploy itself) completed and was verified under a
confirmed-correct identity before the flip happened; only the
subsequent read-only forensic queries were interrupted and had to be
re-run in a later turn under a freshly re-opened, separately-verified
bracket.

---

## Forensic re-run — bulk-flag distribution and 588/619 history (2026-09-07)

Read-only, UUID-pinned (`--project-id d6aea290-bd61-4f82-aa8d-94378b9f2fec`),
run under a confirmed-clean bracket (`login-info` + `worker_get` both
checked immediately before).

**Bulk-flag distribution** (`device_events` where `metadata LIKE
'%"bulk":true%'`, grouped by `to_status`):
```
SORTING: 345   (100% of all bulk-flagged events)
```
Zero bulk-flagged events of any other `to_status`, and separately, only
2 REJECTED-direction events exist anywhere in the entire `device_events`
table (`RECEIVED→REJECTED`), neither of which is bulk-flagged (see below).

**Conclusion: H0 was a real authorization bypass but was never actually
exploited via the bulk path.** No historical bulk-REJECTED transition
ever occurred in production, so no audit remediation of past bulk
rejections is needed — this closes that question.

**Devices 588 and 619 — full event history** (the entire REJECTED-direction
event set in the table; these two rows are not a sample, they are the
complete set):

| device_id | event | from→to | when | metadata | bulk? |
|---|---|---|---|---|---|
| 588 | RECEIVE | null→RECEIVED | 2026-08-28 14:10:15 | sku APL-I15P-256-BLT-UG, grade UG, vat_type MARGIN, buy_price 323 | — |
| 588 | STATUS_CHANGE | RECEIVED→REJECTED | 2026-08-28 14:10:22 (7s later) | null | no |
| 619 | RECEIVE | null→RECEIVED | 2026-09-01 13:53:21 | sku APL-I13-128-BLU-A, grade A, vat_type MARGIN, buy_price 180 | — |
| 619 | STATUS_CHANGE | RECEIVED→REJECTED | 2026-09-01 14:03:41 (~10 min later) | null | no |

Both rejections: `user_id=2`, no bulk metadata, `metadata: null` on the
reject event itself. **Conclusion: 588 and 619 were single-device
mis-taps on the receive screen, not bulk-transition casualties.** The
7-second gap on 588 in particular reads as an immediate accidental tap
right after receiving. This redirects the operator's original "bulk did
nothing" complaint away from the bulk UI entirely for these two specific
devices — whatever produced the complaint, it did not go through the
bulk path for 588/619. H1 (Luhn/iPad-serial) reproduction remains the
open lead for the complaint itself; these two devices are now understood
as a separate, already-explained issue (operator UI slip), correctable
via the single-device UI with reason code `rejected_in_error` now that
the route is live.

---

## Roster provenance — 397/1 retired, 1120/13 (now 1133-total) is current

`by_vat_type_raw`'s per-org, status-unfiltered device count was queried
directly against `received_devices` this session (bypassing the
manager-gated HTTP endpoint, which the standing "no per-person account as
disposable fixture" rule puts off-limits for a login-based call): as of
2026-09-07, MARGIN 1120 / PVAT 13, table total 1133.

This does not match the previously-referenced "MARGIN 397 / PVAT 1"
figures used earlier in the project's history. Four targeted queries
(read-only, org-scoped, run under a single confirmed-clean bracket)
resolve the discrepancy exactly rather than leaving it open:

```
SELECT COUNT(*), COUNT(DISTINCT imei) FROM received_devices WHERE organisation_id=1
  → total_rows=1133, distinct_imei=1133   (no duplicate IMEI imports)

SELECT status, COUNT(*) ... GROUP BY status
  → RECEIVED 533, SORTING 401, IN_EXPORT_CONSIGNMENT 155,
    ACTIVE_INVENTORY 25, IN_HOUSE_REPAIR 17, REJECTED 2   (sums to 1133)

SELECT COUNT(*) WHERE created_at <= '2026-08-24 23:59:59'
  → 398   (exact match to the historical 24-Aug snapshot total)

SELECT DISTINCT organisation_id FROM received_devices
  → {1}   (single organisation, no cross-org contamination)
```

**Conclusion: 397/1 was the 24 August snapshot, now superseded by
genuine growth to 1133 total (1120 MARGIN / 13 PVAT).** The +735-device
delta since 24 Aug has a clean row-level explanation consistent with
organic growth: every row has a distinct IMEI (duplicate-import
hypothesis eliminated at the row level), the growth concentrates in
early-lifecycle statuses (RECEIVED + SORTING = 934 of 1133, i.e. mostly
recent/unprocessed intake, not stuck duplicates), and there is only one
organisation in the table. This does not fully rule out a subtler
placeholder-row mechanism (manifest-created rows for devices not
physically received) without a further cross-reference against
`expected_devices`/manifest scan events, which has NOT been run and is
noted here as optional follow-up, not yet needed to accept the
row-level duplicate-import hypothesis as eliminated.

**397/1 is retired from further reproduction.** `by_vat_type_raw` should
not be re-queried for provenance purposes going forward — 1120/13
(1133 total) is the current, accepted figure. The Zoho reconciliation
scope should be sized against ~1133 devices, not ~398 — roughly 3x the
previously-assumed scale.

---

## Placeholder-row hypothesis — DISPROVEN (2026-09-07)

Follow-up to the roster provenance finding above. Query (read-only,
org-scoped, bracketed):

```sql
SELECT COUNT(*) FROM received_devices rd
 WHERE rd.organisation_id = 1
   AND NOT EXISTS (SELECT 1 FROM device_events de
                    WHERE de.device_id = rd.id
                      AND de.event_type = 'RECEIVE');
```

Result: `cnt = 0`.

Every one of the 1133 `received_devices` rows has a corresponding
`RECEIVE` event. There are no manifest-created placeholder rows lacking
a physical-receipt act. Combined with the earlier finding (no duplicate
IMEIs, single organisation), the roster growth from 398 (24 Aug) to 1133
(now) is fully explained as genuine intake — no inflation mechanism
found. The Zoho reconciliation can proceed sized against ~1133 devices
without a data-integrity caveat on the row count itself.

## Task C investigation — ANSWERED: single-device REJECTED reachability, 2026-09-07

**Question**: was REJECTED reachable by a single tap / no confirmation on the
single-device screen, and does that explain devices 588/619's NULL-metadata
rejects?

**Finding — the reject mechanism, fully traced via git history + code**:

1. `POST /scan/reject` (src/routes/scan.ts:830) is NOT the culprit — it only
   logs a `scan_events`/`device_events` row with `deviceId: null` for a
   pre-receipt unreconciled-manifest-line rejection. It NEVER writes
   `received_devices.status`. Grep of the whole `src/` tree confirms the
   ONLY code path that can ever write `status = 'REJECTED'` is
   `transitionDevice()`, called from either the generic
   `POST /:id/transition` route or `POST /bulk-transition` — both gated by
   `checkRejectUnrejectGate()`.

2. That gate (manager-only + mandatory `reason_code`) was added in commit
   `84a57e7` ("Add REJECTED -> RECEIVED transition with scoped manager gate
   + reason codes"), timestamped **2026-09-01 15:40:04 UTC** — and its own
   commit message says explicitly it was written BECAUSE of devices 588 and
   619 (REJECTED previously had zero outbound edges, an unintentional dead
   end).

3. The corresponding UI change — `RejectReasonModal()` / `doTransition()`'s
   special-casing of the RECEIVED<->REJECTED edges — landed in `d64bc28`
   ("Add reject/un-reject reason-code UI"), **2026-09-01 16:14:11 UTC**,
   34 minutes later.

4. Device 588's reject event: **2026-08-28 14:10:22** — 4 days BEFORE the
   gate existed.
   Device 619's reject event: **2026-09-01 ~14:03** — same day but ~1h37m
   BEFORE `84a57e7` (15:40:04), and ~2h11m before the UI modal (16:14:11).

**Conclusion**: both incidents predate the fix entirely. At the time each
occurred, `AllDevicesSubview()`'s "Move to" `<select>` fired
`doTransition()` on a single `onchange` with NO special-casing — `doTransition()`
went straight to `runTransition(device, toStatus, {})` for every edge,
including RECEIVED->REJECTED, with no manager check, no reason-code
requirement, and no confirmation step of any kind. A single accidental
dropdown selection was sufficient. This is the exact "single-device mis-tap"
mechanism the forensic finding already inferred from the NULL metadata —
now confirmed against source history rather than inferred from data alone.

**Current code already closes this hole** (has done since 2026-09-01,
6 days before this session): `checkRejectUnrejectGate()` requires (a) the
caller be manager/admin, (b) an explicit reason_code from the enumerated
list, enforced server-side on both the single-device and bulk routes, with
`transitionDevice()` itself re-checking as a defence-in-depth backstop. The
UI additionally requires the operator to open `RejectReasonModal()` and
pick a reason before the request is even sent. A repeat of 588/619's exact
mechanism (accidental dropdown selection instantly firing the transition)
is no longer possible — the accidental selection now only opens a modal
requiring a deliberate second action.

**Task C recommendation**: no code change needed. The hardening the task
asked for is already live, predates this session, and structurally
prevents the reproduced mechanism. Recording this as investigated-and-
closed rather than shipping a redundant second layer. Flagging for the
user to confirm/override if they want additional hardening (e.g. a
generic "confirm this transition" step on ALL edges, not just
reject/unreject) — that would be a materially bigger change than "modest"
and was explicitly out of scope per the task's own instruction to defer
rather than expand.

## Session cutoff — iteration budget reached, work handed back

Identity flip **#8** observed this session (`gsk login-info` read
`sagarsptl@gmail.com` when `saigateslimited@gmail.com` was expected).
Per standing rule: no retry attempted. This blocked:
- Task A1's `genspark` remote push of commit `8cc3561` (the `origin` push
  DID succeed this session — confirmed by push output, `e0e26e9..8cc3561`).
- Task A2 (placeholder-row query) — skipped per its own explicit
  contingency instruction ("if the identity bracket fails, skip A2, go
  straight to Task B").

Work completed this session: Task A1 (partial — origin only),
Task B1 (carried over, reported to user), Task C (investigated and
answered in full, see above — recommend closing without a code change).

Work NOT started this session: B2 (pagination code), B3 (export fix
code), B4 (tests), D (deploy), E (H1 repro), F (docs filler). No source
files were modified this session — `src/routes/devices.ts`,
`src/routes/inventory.ts`, and `public/static/app.js` were read in full
but zero edits applied, so there is no uncommitted code risk to carry
into the next turn.
