-- Migration 0023a (REWRITE, 2026-08-19): received_devices.status CHECK
-- widening +2 values, received_at column. Split out of the original
-- monolithic 0023 file per Sprint-E instruction: "a rewritten
-- table-recreation migration is its own reviewed unit" and "strong
-- preference for splitting the nine recreates into separate numbered
-- migrations so a partial batch leaves a diagnosable state instead of a
-- mystery."
--
-- 0023 has never been applied to production (confirmed: production's
-- d1_migrations table only lists IDs 1-22; production's live
-- received_devices CHECK constraint lacks TEMP_EXPORTED_STANDARD /
-- RETURNED_UNDER_STANDARD). It therefore has no released history to
-- protect and is being rewritten in place rather than patched forward.
--
-- DEFECT BEING FIXED (found 2026-08-19, forensic review): the original
-- 0023 recreated received_devices and repointed FOUR child tables
-- (device_events, shipment_lines, print_jobs, grade_audit) but MISSED
-- TWO tables that also carry a `NOT NULL REFERENCES received_devices(id)`
-- FK with no ON DELETE action (default NO ACTION): repair_jobs and
-- zoho_batch_devices — both introduced one migration later by
-- 0022_repair_jobs_and_zoho_queue.sql, after the four-table list (first
-- established by 0021 REVISION 3) was written. 0023 inherited that list
-- without re-deriving it against the schema as it stood by its own time.
--
-- NINE-TABLE AUDIT (2026-08-19, derived from the LIVE schema, not from
-- the original 0023's own header comment, to avoid repeating the same
-- class of error): of the 9 tables the original 0023 recreated, only
-- received_devices had an undercounted child list. shipments' 5-table
-- child list (sent_emails, shipment_value_deltas, shipment_replies,
-- shipment_lines, shipments' own self-referencing related_export_shipment_id)
-- was complete and correct; the other 7 recreated tables are FK leaves
-- (nothing references them) and needed no child accounting at all.
--
-- FK ENFORCEMENT ACROSS MULTI-STATEMENT DDL: re-verified this pass
-- (not assumed) against real `wrangler d1 migrations apply --local`,
-- extending 0021 REVISION-2's finding: neither `PRAGMA foreign_keys = OFF`
-- nor `PRAGMA defer_foreign_keys = TRUE` change D1's enforcement of an
-- implicit DELETE from DROP TABLE — both still raise
-- SQLITE_CONSTRAINT_FOREIGNKEY identically to the no-pragma case, tested
-- fresh against this exact received_devices/repair_jobs/zoho_batch_devices
-- shape with one live row seeded in each of the two previously-missed
-- children. Do not reintroduce either pragma as "the fix" without
-- re-verifying against a real `wrangler d1 migrations apply --local` run
-- first — this is D1's own execution layer, not vanilla SQLite, and a
-- raw python sqlite3 test is not sufficient evidence for it (per 0021's
-- own standing caution). The only working fix remains the recreate-all-
-- affected-tables-in-dependency-order pattern.
--
-- This file (0023a) recreates ONLY received_devices and its now-COMPLETE
-- six-table child set (device_events, print_jobs, grade_audit,
-- shipment_lines, repair_jobs, zoho_batch_devices) plus the plain
-- received_at column ALTER. It is split from 0023b (shipments +
-- shipment_type widening) and 0023c (removal_flags, independent new
-- table with no recreate) so that if any one of these three files fails
-- mid-batch, `d1_migrations` records exactly which one, instead of a
-- single 9-table monolith failing at an unrecorded internal offset.
--
-- Two new device statuses added to received_devices.status:
--   TEMP_EXPORTED_STANDARD  - mirrors EXPORTED_UNDER_OPR, for the new
--                              non-customs "temporary export, standard"
--                              consignment type.
--   RETURNED_UNDER_STANDARD - mirrors RETURNED_UNDER_OPR, the return-side
--                              counterpart.
-- See src/lib/deviceLifecycle.ts for the ALLOWED_TRANSITIONS wiring.
--
-- received_at (plain ALTER, no recreate needed) records when a device was
-- physically received, independent of created_at (row-insert time) —
-- backdatable via scan.ts's receive endpoints.

------------------------------------------------------------------
-- Plain column addition (no recreate required)
------------------------------------------------------------------
ALTER TABLE received_devices ADD COLUMN received_at DATETIME;

------------------------------------------------------------------
-- received_devices (parent) — status CHECK widened +2 values
------------------------------------------------------------------
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
      'QC_FAILED','READY_FOR_ZOHO',
      'TEMP_EXPORTED_STANDARD','RETURNED_UNDER_STANDARD'
    )),
  label_printed_at DATETIME,
  notes TEXT,
  created_by_user_id INTEGER,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME,
  buy_price REAL,
  currency TEXT NOT NULL DEFAULT 'GBP',
  vat_type TEXT,
  supplier_id INTEGER REFERENCES suppliers(id),
  received_at DATETIME,
  FOREIGN KEY (manifest_id)        REFERENCES manifests(id)        ON DELETE SET NULL,
  FOREIGN KEY (expected_device_id) REFERENCES expected_devices(id) ON DELETE SET NULL
);

INSERT INTO received_devices_new
  (id, organisation_id, uuid, imei, sku, brand, model, capacity, color, grade, source,
   manifest_id, expected_device_id, status, label_printed_at, notes,
   created_by_user_id, created_at, updated_at,
   buy_price, currency, vat_type, supplier_id, received_at)
SELECT
  id, organisation_id, uuid, imei, sku, brand, model, capacity, color, grade, source,
  manifest_id, expected_device_id, status, label_printed_at, notes,
  created_by_user_id, created_at, updated_at,
  buy_price, currency, vat_type, supplier_id, received_at
FROM received_devices;

------------------------------------------------------------------
-- Children of received_devices — COMPLETE six-table set (repointed
-- only; columns/indexes otherwise unchanged from their current shape).
------------------------------------------------------------------
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

-- ── repair_jobs — MISSING from the original 0023, added in this rewrite ──
CREATE TABLE repair_jobs_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organisation_id INTEGER NOT NULL REFERENCES organisations(id),
  device_id INTEGER NOT NULL REFERENCES received_devices_new(id),
  imei TEXT NOT NULL,
  fault_code TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'awaiting_qc', 'completed', 'cancelled')),
  qc_result TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (qc_result IN ('PENDING', 'PASSED', 'FAILED')),
  qc_fail_reason TEXT,
  qc_by INTEGER REFERENCES users(id),
  qc_at DATETIME,
  repair_cost_gbp REAL,
  parts_cost_gbp REAL,
  labour_cost_gbp REAL,
  cost_source TEXT,
  cost_source_reference TEXT,
  cost_recorded_at DATETIME,
  cost_recorded_by INTEGER REFERENCES users(id),
  opened_by_user_id INTEGER REFERENCES users(id),
  opened_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  closed_at DATETIME
);
INSERT INTO repair_jobs_new
  (id, organisation_id, device_id, imei, fault_code, status, qc_result, qc_fail_reason, qc_by, qc_at,
   repair_cost_gbp, parts_cost_gbp, labour_cost_gbp, cost_source, cost_source_reference, cost_recorded_at,
   cost_recorded_by, opened_by_user_id, opened_at, closed_at)
SELECT
  id, organisation_id, device_id, imei, fault_code, status, qc_result, qc_fail_reason, qc_by, qc_at,
  repair_cost_gbp, parts_cost_gbp, labour_cost_gbp, cost_source, cost_source_reference, cost_recorded_at,
  cost_recorded_by, opened_by_user_id, opened_at, closed_at
FROM repair_jobs;

-- ── zoho_batch_devices — MISSING from the original 0023, added in this rewrite ──
CREATE TABLE zoho_batch_devices_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id INTEGER NOT NULL REFERENCES zoho_batches(id) ON DELETE CASCADE,
  device_id INTEGER NOT NULL REFERENCES received_devices_new(id),
  imei TEXT NOT NULL,
  sku TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO zoho_batch_devices_new
  (id, batch_id, device_id, imei, sku, created_at)
SELECT
  id, batch_id, device_id, imei, sku, created_at
FROM zoho_batch_devices;

------------------------------------------------------------------
-- Drop ALL children first (dropping a table only checks constraints IT
-- declares, never incoming references to it — always safe before
-- parents, regardless of NO ACTION vs CASCADE), THEN the parent.
------------------------------------------------------------------
DROP TABLE device_events;
DROP TABLE print_jobs;
DROP TABLE grade_audit;
DROP TABLE shipment_lines;
DROP TABLE repair_jobs;
DROP TABLE zoho_batch_devices;
DROP TABLE received_devices;

ALTER TABLE received_devices_new    RENAME TO received_devices;
ALTER TABLE device_events_new       RENAME TO device_events;
ALTER TABLE print_jobs_new          RENAME TO print_jobs;
ALTER TABLE grade_audit_new         RENAME TO grade_audit;
ALTER TABLE shipment_lines_new      RENAME TO shipment_lines;
ALTER TABLE repair_jobs_new         RENAME TO repair_jobs;
ALTER TABLE zoho_batch_devices_new  RENAME TO zoho_batch_devices;

CREATE INDEX IF NOT EXISTS idx_received_imei     ON received_devices(imei);
CREATE INDEX IF NOT EXISTS idx_received_sku      ON received_devices(sku);
CREATE INDEX IF NOT EXISTS idx_received_manifest ON received_devices(manifest_id);
CREATE INDEX IF NOT EXISTS idx_received_org      ON received_devices(organisation_id);
CREATE INDEX IF NOT EXISTS idx_received_status   ON received_devices(status);
CREATE INDEX IF NOT EXISTS idx_received_supplier ON received_devices(supplier_id);

CREATE INDEX IF NOT EXISTS idx_device_events_device ON device_events(device_id);
CREATE INDEX IF NOT EXISTS idx_device_events_org    ON device_events(organisation_id);
CREATE INDEX IF NOT EXISTS idx_device_events_type   ON device_events(event_type);

CREATE INDEX IF NOT EXISTS idx_print_status   ON print_jobs(status);
CREATE INDEX IF NOT EXISTS idx_print_jobs_org ON print_jobs(organisation_id);

CREATE INDEX IF NOT EXISTS idx_grade_audit_device ON grade_audit(received_device_id);
CREATE INDEX IF NOT EXISTS idx_grade_audit_bulk   ON grade_audit(bulk_id);
CREATE INDEX IF NOT EXISTS idx_grade_audit_org    ON grade_audit(organisation_id);

CREATE INDEX IF NOT EXISTS idx_shipment_lines_device   ON shipment_lines(received_device_id);
CREATE INDEX IF NOT EXISTS idx_shipment_lines_shipment ON shipment_lines(shipment_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_shipment_lines_unique ON shipment_lines(shipment_id, received_device_id);

CREATE INDEX IF NOT EXISTS idx_repair_jobs_device ON repair_jobs(device_id);
CREATE INDEX IF NOT EXISTS idx_repair_jobs_org    ON repair_jobs(organisation_id);
CREATE INDEX IF NOT EXISTS idx_repair_jobs_imei   ON repair_jobs(imei);
CREATE INDEX IF NOT EXISTS idx_repair_jobs_status ON repair_jobs(status);

CREATE INDEX IF NOT EXISTS idx_zoho_batch_devices_batch  ON zoho_batch_devices(batch_id);
CREATE INDEX IF NOT EXISTS idx_zoho_batch_devices_device ON zoho_batch_devices(device_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_zoho_batch_devices_unique ON zoho_batch_devices(batch_id, device_id);

------------------------------------------------------------------
-- Fail loudly if the recreate left anything inconsistent. Per Sprint-E
-- instruction ("make the migration fail loudly if it reports anything").
-- NOTE: PRAGMA foreign_key_check returning rows does NOT itself abort a
-- migration (verified empirically this pass — a bare foreign_key_check
-- with violations present still returns success against
-- `wrangler d1 migrations apply --local`). The abort must be forced
-- explicitly: RAISE via a trigger-less technique is unavailable in plain
-- migration SQL, so this uses the one construct that DOES reliably abort
-- a statement, a UNIQUE-constraint self-collision, gated on the
-- foreign_key_check result being non-empty. See 0023c for the same
-- pattern reused after the shipments-side recreate.
------------------------------------------------------------------
CREATE TABLE __fk_check_guard_0023a (ok INTEGER NOT NULL CHECK (ok = 1));
INSERT INTO __fk_check_guard_0023a (ok)
SELECT 0 FROM pragma_foreign_key_check() LIMIT 1;
DROP TABLE __fk_check_guard_0023a;
