-- Migration 0023c (REWRITE, 2026-08-19, Sprint G re-split; follow-up pass
-- 2026-08-20 for M3/M4): removal_flags —
-- brand-new table, no recreate involved. THIRD and LAST in the new split
-- ordering, unchanged in position numerically but changed in meaning: it
-- now runs after BOTH parent recreates (0023a shipments, 0023b
-- received_devices + the single shared shipment_lines recreate) have
-- fully settled, not merely after received_devices alone.
--
-- New table for regrade-fix 2: when POST /grade downgrades a device to UG
-- while it is ACTIVE_INVENTORY, a flag row is written here for manual
-- pull-from-shelf review. Independent of Zoho-batch state (no application
-- code writes to zoho_batches directly, confirmed prior segment).
--
-- CASCADE-HAZARD FINDING — WHY THIS FILE'S POSITION IS SAFE (Sprint G,
-- G1): removal_flags.received_device_id carries `ON DELETE CASCADE`. The
-- general hazard (documented in full in 0023b's header): a CASCADE child
-- of a table that is later renamed-away-and-dropped does NOT fail loudly
-- if it is left pointing at the old copy — SQLite silently rewrites its FK
-- text to the renamed-away parent, and the final DROP of that old parent
-- silently fires the CASCADE and deletes the child's rows, with a clean
-- foreign_key_check and no error. That mechanism only bites a table that
-- (a) already has rows and (b) is left unrepointed across its parent's
-- rename. Neither condition holds here:
--   (a) removal_flags does not exist in production (F1: zero matches at
--       6cbe4e2) and this file is what creates it — it is a brand-new,
--       empty table at the moment its own CREATE TABLE statement runs, so
--       there are zero rows for any future misordering to destroy on THIS
--       deploy. This is deploy-specific reassurance, not a structural
--       reason it's safe in general.
--   (b) structurally: this file runs strictly after 0023a's shipments
--       swap and 0023b's received_devices swap, INCLUDING 0023b's own
--       final `DROP TABLE received_devices_old` statement. By the time
--       this file's CREATE TABLE removal_flags statement executes,
--       `received_devices` already IS the final, settled table — there is
--       no `received_devices_old` left in existence for this file's FK
--       clause to ever resolve against. removal_flags is created directly
--       against the final name; it is never pointed at a table that is
--       later renamed away, so the CASCADE-hazard's precondition (a
--       rename happening AFTER this table starts referencing its parent)
--       never arises for this table at all.
-- Confirmed empirically this pass: `/tmp/g1-removal-flags-order` (positive
-- — this file's current position, seeded removal_flags row, full
-- 0023a→0023b→0023c sequence, row survives with correct received_device_id
-- resolving to the final received_devices table) and `/tmp/g3-combined`
-- (full 9-table end-to-end sequence including this file in this position).
-- Both cleaned up.
--
-- CONTRAST — what would make this file's position UNSAFE: if this file
-- (or any future migration creating a CASCADE child of received_devices)
-- were moved to BEFORE 0023b's received_devices swap, or if 0023b's swap
-- were ever edited to omit dropping received_devices_old at its correct
-- point, a removal_flags row created in that window would have its FK
-- text silently rewritten to received_devices_old on the next rename, and
-- would be silently destroyed when received_devices_old is eventually
-- dropped — with no error and a clean foreign_key_check. This file's
-- current position, strictly after 0023b's own DROP TABLE
-- received_devices_old statement, is what keeps it out of that window.
--
-- M4 RECIPROCAL NOTE (Sprint G follow-up) — the MIRROR case, running the
-- other direction in time: everything above concerns removal_flags being
-- created too early relative to a received_devices swap that already
-- happened. The mirror case is a LATER migration recreating
-- received_devices AGAIN, after this file has run and removal_flags has
-- accumulated real rows. removal_flags is flagged in 0023b's own header
-- ("POST-0023 CHILDREN...") as the one member of that file's forward-
-- looking child list that carries ON DELETE CASCADE rather than NO
-- ACTION/implicit NO ACTION — meaning any future received_devices
-- recreate that follows this file MUST add removal_flags to its own
-- child audit and swap, or it silently reproduces the exact CASCADE-
-- hazard mechanism documented above: removal_flags' FK text gets
-- silently rewritten to that future migration's renamed-away
-- received_devices_old, and removal_flags' rows are silently deleted
-- when that old copy is eventually dropped, with a clean
-- foreign_key_check throughout. This file's own safety (established
-- above) says nothing about a later migration's safety — that
-- obligation is carried by 0023b's header, not repeated in full here,
-- but is recorded on this side too so a reviewer reading only this file
-- knows the CASCADE relationship this table carries has a forward
-- obligation attached to it, not just a backward one.
--
-- WHAT A FAILURE HERE LEAVES / DOES THE APP STILL FUNCTION (Sprint F/G
-- explicit ask): this file contains no recreate, no rename, no DROP of any
-- existing table — only a CREATE TABLE and three CREATE INDEX statements
-- against a table name (removal_flags) that does not yet exist. If any
-- statement here fails on a real (non-atomic) D1 deploy:
--   - If CREATE TABLE removal_flags itself fails: nothing exists yet, no
--     app impact (no code path writes to removal_flags before this
--     migration ships), re-run once the cause is fixed.
--   - If it succeeds but one of the three CREATE INDEX statements fails:
--     removal_flags exists and is fully usable (indexes are a query-speed
--     concern, not a correctness one); d1_migrations will still correctly
--     record 0023c as not-applied until the missing index statement is
--     re-run successfully. That re-run's success depends on this file
--     being re-run in full, which is ASSUMED, NOT VERIFIED — whether a
--     partially-failed D1 migration file is actually retried in full by
--     the platform, versus resumed from some other point or left for
--     manual intervention, remains the outstanding production D1
--     atomicity question (see 0023a/0023b headers). What IS true
--     regardless of that answer: CREATE TABLE IF NOT EXISTS (see the M3
--     fix below) and CREATE INDEX IF NOT EXISTS make every individual
--     statement in this file idempotent against being re-run, which is
--     the most this file itself can guarantee — it cannot by itself
--     guarantee that a re-run will actually happen automatically.
--   - There is no scenario in which a partial failure of this file leaves
--     `received_devices` or `shipments` in a broken state — this file only
--     ever reads their (already-final, already-settled) schema for its FK
--     clause; it never mutates either table.
-- M3 FIX (Sprint G follow-up): the original version of this file's
-- CREATE TABLE removal_flags had no IF NOT EXISTS guard, contradicting
-- this file's own narrative above ("CREATE INDEX IF NOT EXISTS makes
-- any successful earlier index statements idempotent against a
-- re-run") — that claim covered the index statements but not the table
-- statement one line above them, so a re-run after a failure that
-- landed strictly after CREATE TABLE succeeded would die on "table
-- removal_flags already exists" rather than actually retrying. Fixed by
-- adding IF NOT EXISTS below, matching this file's own three CREATE
-- INDEX statements, which already had it.
--
-- DEDUP / APPEND-ONLY DECISION (minor, Sprint G follow-up): no
-- uniqueness constraint is declared on (received_device_id, flagged_at)
-- or any other column combination. This is a deliberate decision, not
-- an oversight: a single device can legitimately be downgraded to UG,
-- pulled, re-graded upward, and later downgraded to UG again — each
-- occurrence is its own flag-worthy event, so removal_flags is
-- append-only by design and a uniqueness constraint would incorrectly
-- reject a second, legitimate flag for the same device.
--
-- FK CONVENTION NOTE (minor, Sprint G follow-up): flagged_by_user_id
-- and resolved_by_user_id are plain INTEGER with no REFERENCES users(id)
-- clause, unlike organisation_id and received_device_id immediately
-- below, which do declare one. This is consistent with the existing
-- mixed convention elsewhere in this migration set (e.g. 0023b's
-- print_jobs.created_by_user_id and grade_audit.user_id are also plain
-- INTEGER with no FK), not a new inconsistency introduced by this file.
-- Left unchanged pending a codebase-wide decision on that convention,
-- which is out of scope for this table.
--
-- GRADE CHECK NOTE (minor, Sprint G follow-up): old_grade/new_grade are
-- plain TEXT with no CHECK constraint restricting them to the grade
-- vocabulary ('A','B','C','UG') that received_devices.grade itself
-- enforces. Deliberately NOT added here yet, per instruction: adding it
-- now risks a mismatch with src/lib's normalizeGrade() write path if
-- that function's actual output vocabulary has not been confirmed
-- against this exact CHECK list first. Revisit once that confirmation
-- has happened.
--
-- STALE-SNAPSHOT NOTE (minor, Sprint G follow-up): imei and sku are
-- copied onto this table at flag-creation time as point-in-time
-- snapshots, not FK-derived live lookups. If a later SKU_CORRECTION-
-- style event changes received_devices.sku for the same device after a
-- removal_flags row already exists, this row's `sku` column will not
-- reflect that correction — it records what was true at the moment the
-- device was flagged, which is intentional for an audit trail, but
-- means this column must not be treated as a live mirror of
-- received_devices.sku when this table is read later.
------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS removal_flags (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organisation_id INTEGER NOT NULL REFERENCES organisations(id),
  received_device_id INTEGER NOT NULL REFERENCES received_devices(id) ON DELETE CASCADE,
  imei TEXT NOT NULL,
  sku TEXT,
  old_grade TEXT,
  new_grade TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT 'regrade_to_UG_while_active_inventory',
  flagged_by_user_id INTEGER,
  flagged_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  resolved_at DATETIME,
  resolved_by_user_id INTEGER,
  note TEXT
);

CREATE INDEX IF NOT EXISTS idx_removal_flags_device ON removal_flags(received_device_id);
CREATE INDEX IF NOT EXISTS idx_removal_flags_org    ON removal_flags(organisation_id);
-- Partial index (minor, Sprint G follow-up): the original plain index on
-- resolved_at served every query this table needs, but every real query
-- against this column is "find OPEN flags for an org" (resolved_at IS
-- NULL) — a plain index equally indexes the (larger, over time) resolved
-- rows that no query filters on. Narrowed to a partial index scoped to
-- exactly the open-flags case, on organisation_id (the actual filter
-- column for that query) rather than resolved_at itself.
CREATE INDEX IF NOT EXISTS idx_removal_flags_open ON removal_flags(organisation_id) WHERE resolved_at IS NULL;
