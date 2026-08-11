-- PRODUCTION NOTE (2026-08-11, post-deploy reconciliation): D1 tracks
-- migrations as applied by FILENAME, not by content — production's
-- d1_migrations ledger already records "0021_repair_qc_zoho_status_enum.sql"
-- as applied (2026-08-11 16:54:39), so this REVISION-3 file rewrite below
-- will NEVER re-run against production; it only affects new/from-scratch
-- database builds. Production actually ran REVISION 2 (the version that
-- recreated received_devices/device_events/shipment_lines but wrongly
-- treated print_jobs/grade_audit as "unaffected" by DROP TABLE
-- received_devices — see REVISION 3 note below for why that claim was
-- wrong). Both production print_jobs and grade_audit had 0 rows at
-- deploy time, so REVISION 2 running in production did not destroy real
-- data; the risk was to any future row, not a historical one.
--
-- Full 5-table DDL diff performed this reconciliation, comparing
-- production's live sqlite_master text (`gsk hosted d1_schema`) against
-- a from-scratch local D1 built on this corrected REVISION-3 file
-- (`wrangler d1 execute ... --local`): received_devices, device_events,
-- and shipment_lines are byte-identical (normalized) between production
-- and this file. print_jobs and grade_audit differ ONLY in FK-clause
-- placement/formatting (production expresses the FK as a trailing
-- `FOREIGN KEY (...) REFERENCES received_devices(id) ON DELETE CASCADE`
-- clause; this file inlines the same reference on the column) — same
-- columns, types, nullability, defaults, target table, and ON DELETE
-- CASCADE action in both. All 17 named indexes on these 5 tables match
-- exactly by name and SQL text. Conclusion: production, having run
-- REVISION 2, reached the SAME END STATE this REVISION-3 file produces.
-- The divergence between "what's recorded as applied" and "what this
-- file now contains" is cosmetic only — no forward migration (e.g. 0023)
-- is needed to reconcile production's schema.
--
-- Migration 0021: Device Lifecycle slice 1 (C15-D33) — status enum only.
--
-- This is deliberately the FIRST and ONLY schema change in this migration
-- (per explicit instruction: "status-enum migration first ... the
-- confirmed first domino"). It adds 'QC_FAILED' and 'READY_FOR_ZOHO' to
-- the received_devices.status CHECK enum. No repair_jobs / zoho_* tables
-- are created here — those are later migrations, gated on this one first
-- going green (test #27's seed-direct-into-QC_FAILED no longer throwing
-- D1_ERROR: CHECK constraint failed).
--
-- SQLite can't ALTER a CHECK constraint in place, so this needs the
-- recreate-and-copy dance used in migration 0008 for this exact table:
-- CREATE new-shape table, copy rows across unchanged, DROP old, RENAME.
--
-- REVISION 2 (post-first-deploy-attempt, 2026-08-11): the plain single-table
-- version of this migration (CREATE received_devices_new / copy / DROP
-- received_devices / RENAME — same shape as 0008) failed in production with
-- FOREIGN KEY constraint failed / SQLITE_CONSTRAINT_FOREIGNKEY (D1 error
-- 7500). Root cause, confirmed against production D1 (`gsk hosted d1_schema`
-- + row-count query) and reproduced locally via `wrangler d1 migrations
-- apply --local` before this fix:
--
--   * device_events.device_id and shipment_lines.received_device_id both
--     carry a FOREIGN KEY REFERENCES received_devices(id) with no ON DELETE
--     action (added in migrations 0008 and 0010 respectively).
--   * DROP TABLE received_devices is an implicit delete of every row in it;
--     SQLite's FK enforcement checks that against device_events/
--     shipment_lines and blocks it. Production device_events has 403 live
--     rows today (shipment_lines has 0, but carries the identical unguarded
--     FK shape, so it would hit the same failure once populated).
--   * This exact recreate-and-copy pattern succeeded in migration 0008
--     only because the database was still near-empty at that time.
--   * D1 does not support toggling FK enforcement mid-migration — verified
--     directly: `PRAGMA foreign_keys = OFF` and `PRAGMA defer_foreign_keys
--     = TRUE` were both tried against the real local D1/wrangler engine
--     (not just a raw sqlite3 file) and neither changes D1's enforcement
--     behaviour; both still fail with the identical error. Do not
--     reintroduce either pragma as "the fix" without re-verifying against
--     `wrangler d1 migrations apply --local` first — a plain python
--     sqlite3 test is not sufficient evidence for D1 (D1 wraps SQLite with
--     its own execution layer).
--   * A rename-first variant (ALTER TABLE received_devices RENAME TO
--     received_devices_old, then create the new-shape received_devices)
--     also fails: SQLite auto-rewrites child tables' FK reference text to
--     the new name on ALTER TABLE RENAME (confirmed by inspecting
--     sqlite_master directly, with and without `PRAGMA legacy_alter_table`),
--     so DROP TABLE received_devices_old still trips the same check.
--
-- REVISION 3 (this pass, 2026-08-11, post-deploy discovery): REVISION 2's
-- comment above claimed print_jobs and grade_audit were "unaffected"
-- because they use ON DELETE CASCADE. That claim was WRONG and the
-- resulting migration (as it ran in production earlier today) was UNSAFE.
-- Corrected understanding, verified with a seeded before/after local test
-- (3 print_jobs rows + 3 grade_audit rows inserted, migration run, counts
-- re-checked): DROP TABLE received_devices is an implicit DELETE of every
-- row in it. SQLite enforces FK actions on implicit deletes exactly as on
-- explicit ones — a NO-ACTION child (device_events, shipment_lines) BLOCKS
-- the delete if rows reference it, but an ON DELETE CASCADE child does the
-- opposite: it lets the delete through and silently deletes every one of
-- its OWN rows too. `PRAGMA foreign_key_check` afterwards reports zero
-- violations only because there is nothing left to violate — the child
-- rows are gone, not preserved. print_jobs and grade_audit are therefore
-- exactly as at-risk as device_events/shipment_lines, just via silent data
-- loss instead of a loud constraint error. (Production currently has 0
-- rows in both tables, confirmed via `gsk hosted d1_query`, so the
-- REVISION-2 migration that already ran in production today did not
-- destroy real data — but the migration file itself was still incorrect
-- and would destroy real print_jobs/grade_audit rows the next time either
-- table is populated, e.g. by a real print job or grade change.)
--
-- REAL FIX (revised): recreate ALL FIVE tables together (parent + all four
-- children with any FK pointing at received_devices — the two unguarded
-- NO ACTION children device_events/shipment_lines, AND the two ON DELETE
-- CASCADE children print_jobs/grade_audit) in dependency order — children
-- created and repointed at the NEW parent's temp name first, then ALL FOUR
-- old children dropped (dropping a table only checks constraints IT
-- declares, never incoming references to it, so this is always safe),
-- THEN the old parent is dropped (nothing references it any more — the
-- new children already point at *_new), then everything is renamed into
-- its final name in one go. Verified end-to-end against `wrangler d1
-- migrations apply --local` with a seeded database (not an empty one —
-- an empty-DB test would not have caught the print_jobs/grade_audit
-- cascade-wipe defect, since `PRAGMA foreign_key_check` reports zero
-- violations both when rows are correctly preserved AND when a CASCADE
-- has silently emptied a child with nothing left to check against).
--
-- device_events, shipment_lines, print_jobs and grade_audit are otherwise
-- UNCHANGED — same columns, same defaults, same indexes — this migration
-- only touches them because their FK's target table is being recreated
-- underneath them.

CREATE TABLE received_devices_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organisation_id INTEGER NOT NULL DEFAULT 1 REFERENCES organisations(id),
  uuid TEXT NOT NULL UNIQUE,
  imei TEXT NOT NULL UNIQUE,
  sku TEXT NOT NULL,
  brand TEXT,
  model TEXT,
  capacity TEXT,
  color TEXT,
  grade TEXT NOT NULL DEFAULT 'UG'
    CHECK (grade IN ('A','B','C','UG')),
  source TEXT NOT NULL
    CHECK (source IN ('manifest','unreconciled','manual')),
  manifest_id INTEGER,
  expected_device_id INTEGER,
  status TEXT NOT NULL DEFAULT 'RECEIVED'
    CHECK (status IN (
      'RECEIVED','SORTING','ACTIVE_INVENTORY','IN_HOUSE_REPAIR',
      'READY_FOR_EXPORT','IN_EXPORT_CONSIGNMENT','EXPORTED_UNDER_OPR',
      'RETURNED_UNDER_OPR','SOLD','REJECTED',
      'QC_FAILED','READY_FOR_ZOHO'
    )),
  label_printed_at DATETIME,
  notes TEXT,
  created_by_user_id INTEGER,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME,
  -- Added by migration 0009 (valuation/VAT) — must be preserved through
  -- this recreate-and-copy exactly as they exist today.
  buy_price REAL,
  currency TEXT NOT NULL DEFAULT 'GBP',
  vat_type TEXT,
  supplier_id INTEGER REFERENCES suppliers(id),
  FOREIGN KEY (manifest_id)        REFERENCES manifests(id)        ON DELETE SET NULL,
  FOREIGN KEY (expected_device_id) REFERENCES expected_devices(id) ON DELETE SET NULL
);

INSERT INTO received_devices_new
  (id, organisation_id, uuid, imei, sku, brand, model, capacity, color, grade, source,
   manifest_id, expected_device_id, status, label_printed_at, notes,
   created_by_user_id, created_at, updated_at,
   buy_price, currency, vat_type, supplier_id)
SELECT
  id, organisation_id, uuid, imei, sku, brand, model, capacity, color, grade, source,
  manifest_id, expected_device_id, status, label_printed_at, notes,
  created_by_user_id, created_at, updated_at,
  buy_price, currency, vat_type, supplier_id
FROM received_devices;

-- ── device_events: recreated only because its FK target is being recreated.
-- Column list, defaults and indexes are byte-for-byte identical to 0008's
-- definition — this is not a schema change to device_events itself.
CREATE TABLE device_events_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organisation_id INTEGER NOT NULL REFERENCES organisations(id),
  device_id INTEGER REFERENCES received_devices_new(id),
  event_type TEXT NOT NULL,
  from_status TEXT,
  to_status TEXT,
  user_id INTEGER REFERENCES users(id),
  reference TEXT,
  metadata TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO device_events_new
  (id, organisation_id, device_id, event_type, from_status, to_status, user_id, reference, metadata, created_at)
SELECT
  id, organisation_id, device_id, event_type, from_status, to_status, user_id, reference, metadata, created_at
FROM device_events;

-- ── shipment_lines: same rationale — recreated only to repoint its FK.
-- Column list, defaults and indexes byte-for-byte identical to 0010's
-- definition.
CREATE TABLE shipment_lines_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organisation_id INTEGER NOT NULL REFERENCES organisations(id),
  shipment_id INTEGER NOT NULL REFERENCES shipments(id) ON DELETE CASCADE,
  received_device_id INTEGER NOT NULL REFERENCES received_devices_new(id),
  imei TEXT NOT NULL,
  sku TEXT,
  brand TEXT,
  model TEXT,
  capacity TEXT,
  color TEXT,
  grade TEXT,
  unit_value REAL NOT NULL,
  currency TEXT NOT NULL DEFAULT 'GBP',
  added_by_user_id INTEGER,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO shipment_lines_new
  (id, organisation_id, shipment_id, received_device_id, imei, sku, brand, model, capacity, color, grade,
   unit_value, currency, added_by_user_id, created_at)
SELECT
  id, organisation_id, shipment_id, received_device_id, imei, sku, brand, model, capacity, color, grade,
  unit_value, currency, added_by_user_id, created_at
FROM shipment_lines;

-- ── print_jobs: MUST be recreated too — it carries an ON DELETE CASCADE
-- FK to received_devices(id) (migration 0001, line 80). REVISION 2 wrongly
-- assumed CASCADE made this "unaffected"; in fact CASCADE means DROP TABLE
-- received_devices would silently delete every print_jobs row instead of
-- blocking. Column list, defaults and indexes byte-for-byte identical to
-- production's current print_jobs (0001 + 0008's added org/user columns).
CREATE TABLE print_jobs_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  received_device_id INTEGER NOT NULL REFERENCES received_devices_new(id) ON DELETE CASCADE,
  printer TEXT NOT NULL DEFAULT 'DYMO LabelWriter 450',
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  sent_at DATETIME,
  organisation_id INTEGER NOT NULL DEFAULT 1,
  created_by_user_id INTEGER
);
INSERT INTO print_jobs_new
  (id, received_device_id, printer, payload_json, status, created_at, sent_at, organisation_id, created_by_user_id)
SELECT
  id, received_device_id, printer, payload_json, status, created_at, sent_at, organisation_id, created_by_user_id
FROM print_jobs;

-- ── grade_audit: MUST be recreated too — it carries an ON DELETE CASCADE
-- FK to received_devices(id) (migration 0004, line 85). Same rationale as
-- print_jobs above. Column list, defaults and indexes byte-for-byte
-- identical to production's current grade_audit.
CREATE TABLE grade_audit_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  received_device_id INTEGER NOT NULL REFERENCES received_devices_new(id) ON DELETE CASCADE,
  imei TEXT NOT NULL,
  old_grade TEXT,
  new_grade TEXT NOT NULL,
  actor TEXT NOT NULL DEFAULT 'operator',
  reason TEXT,
  bulk_id TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  organisation_id INTEGER NOT NULL DEFAULT 1,
  user_id INTEGER
);
INSERT INTO grade_audit_new
  (id, received_device_id, imei, old_grade, new_grade, actor, reason, bulk_id, created_at, organisation_id, user_id)
SELECT
  id, received_device_id, imei, old_grade, new_grade, actor, reason, bulk_id, created_at, organisation_id, user_id
FROM grade_audit;

-- Drop all four children FIRST (dropping a table only checks constraints
-- IT declares, never incoming references to it — this is always safe for
-- both NO ACTION and CASCADE children), THEN the parent (safe now:
-- nothing references the old received_devices any more, the new children
-- already point at received_devices_new).
DROP TABLE device_events;
DROP TABLE shipment_lines;
DROP TABLE print_jobs;
DROP TABLE grade_audit;
DROP TABLE received_devices;

ALTER TABLE received_devices_new RENAME TO received_devices;
ALTER TABLE device_events_new    RENAME TO device_events;
ALTER TABLE shipment_lines_new   RENAME TO shipment_lines;
ALTER TABLE print_jobs_new       RENAME TO print_jobs;
ALTER TABLE grade_audit_new      RENAME TO grade_audit;

CREATE INDEX IF NOT EXISTS idx_received_imei     ON received_devices(imei);
CREATE INDEX IF NOT EXISTS idx_received_sku      ON received_devices(sku);
CREATE INDEX IF NOT EXISTS idx_received_manifest ON received_devices(manifest_id);
CREATE INDEX IF NOT EXISTS idx_received_org      ON received_devices(organisation_id);
CREATE INDEX IF NOT EXISTS idx_received_status   ON received_devices(status);
CREATE INDEX IF NOT EXISTS idx_received_supplier ON received_devices(supplier_id);

CREATE INDEX IF NOT EXISTS idx_device_events_device ON device_events(device_id);
CREATE INDEX IF NOT EXISTS idx_device_events_org    ON device_events(organisation_id);
CREATE INDEX IF NOT EXISTS idx_device_events_type   ON device_events(event_type);

CREATE INDEX IF NOT EXISTS idx_shipment_lines_device   ON shipment_lines(received_device_id);
CREATE INDEX IF NOT EXISTS idx_shipment_lines_shipment ON shipment_lines(shipment_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_shipment_lines_unique ON shipment_lines(shipment_id, received_device_id);

CREATE INDEX IF NOT EXISTS idx_print_status   ON print_jobs(status);
CREATE INDEX IF NOT EXISTS idx_print_jobs_org ON print_jobs(organisation_id);

CREATE INDEX IF NOT EXISTS idx_grade_audit_device ON grade_audit(received_device_id);
CREATE INDEX IF NOT EXISTS idx_grade_audit_bulk   ON grade_audit(bulk_id);
CREATE INDEX IF NOT EXISTS idx_grade_audit_org    ON grade_audit(organisation_id);
