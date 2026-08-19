-- Migration 0023c (REWRITE, 2026-08-19, Sprint G re-split): removal_flags —
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
--     re-run successfully, since D1 migrations that partially fail are
--     re-run in full — CREATE INDEX IF NOT EXISTS makes any successful
--     earlier index statements idempotent against a re-run.
--   - There is no scenario in which a partial failure of this file leaves
--     `received_devices` or `shipments` in a broken state — this file only
--     ever reads their (already-final, already-settled) schema for its FK
--     clause; it never mutates either table.
------------------------------------------------------------------
CREATE TABLE removal_flags (
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
CREATE INDEX IF NOT EXISTS idx_removal_flags_open   ON removal_flags(resolved_at);
