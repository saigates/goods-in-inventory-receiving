-- Migration 0008: Authentication & multi-tenancy foundation + device
-- lifecycle state machine + generalised device_events audit log.
--
-- Covers Priorities 1, 2, 3 of the "Goods-In App Evolution" brief:
--   1. organisations + users tables; organisation_id backfilled onto every
--      domain table (defaulted to a single seeded org so existing data is
--      never lost or reassigned).
--   2. received_devices gains a first-class `status` enum (RECEIVED as the
--      default) covering the full lifecycle, including the export/return/
--      sold statuses which are defined now but have no enabled transitions
--      yet (those workflows are a later phase).
--   3. device_events: append-only audit trail. Every future status change
--      goes through src/lib/deviceLifecycle.ts#transitionDevice(), which
--      writes the received_devices UPDATE and the device_events INSERT in
--      one atomic D1 batch.
--
--      Design decision on scan_events: we do NOT drop/rename scan_events.
--      It continues to serve as the lightweight "scan attempt" feed (drives
--      the Recent Scans panel) and also covers attempts that never produce
--      a device (rejected malformed IMEIs, not-yet-force-added
--      unreconciled scans). device_events is the new authoritative,
--      device-centric audit trail that the OPR customs process depends on:
--      every device mutation (receive / force-add / manual-receive /
--      status transition / reject-of-a-device) writes exactly one
--      device_events row. We backfill device_events below from existing
--      received_devices + scan_events so history isn't lost.
--
-- SQLite can't add PRIMARY KEY/UNIQUE/CHECK columns via plain ALTER TABLE,
-- so tables that need those get the recreate-and-copy dance (as in prior
-- migrations); everything else uses simple ADD COLUMN with a constant
-- DEFAULT so existing rows backfill cleanly.

BEGIN TRANSACTION;

-- ───────── 1. Organisations & Users ─────────

CREATE TABLE IF NOT EXISTS organisations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  slug TEXT UNIQUE,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Seed the single organisation every existing row will be attributed to.
INSERT OR IGNORE INTO organisations (id, name, slug) VALUES (1, 'Default Organisation', 'default');

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  name TEXT,
  role TEXT NOT NULL DEFAULT 'operator' CHECK (role IN ('operator', 'manager', 'admin')),
  organisation_id INTEGER NOT NULL REFERENCES organisations(id),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_users_org ON users(organisation_id);

-- Seed one admin user so the sandbox / dev-login has something to mint a
-- token for. Real deployments should invite additional users and rotate
-- this seed account's credentials.
INSERT OR IGNORE INTO users (id, email, name, role, organisation_id)
VALUES (1, 'admin@goodsin.local', 'Seed Admin', 'admin', 1);

CREATE TABLE IF NOT EXISTS suppliers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organisation_id INTEGER NOT NULL REFERENCES organisations(id),
  name TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_suppliers_org ON suppliers(organisation_id);

CREATE TABLE IF NOT EXISTS webhooks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organisation_id INTEGER NOT NULL REFERENCES organisations(id),
  url TEXT NOT NULL,
  secret TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_webhooks_org ON webhooks(organisation_id);

-- ───────── 2. organisation_id backfilled onto existing domain tables ─────────
-- Simple ADD COLUMN with a constant default — safe under SQLite's ALTER
-- TABLE rules and backfills every existing row to the seeded organisation.

ALTER TABLE manifests        ADD COLUMN organisation_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE manifests        ADD COLUMN created_by_user_id INTEGER;
ALTER TABLE expected_devices ADD COLUMN organisation_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE sku_catalog      ADD COLUMN organisation_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE print_jobs       ADD COLUMN organisation_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE print_jobs       ADD COLUMN created_by_user_id INTEGER;
ALTER TABLE scan_events      ADD COLUMN organisation_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE scan_events      ADD COLUMN user_id INTEGER;
ALTER TABLE grade_audit      ADD COLUMN organisation_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE grade_audit      ADD COLUMN user_id INTEGER;

CREATE INDEX IF NOT EXISTS idx_manifests_org        ON manifests(organisation_id);
CREATE INDEX IF NOT EXISTS idx_expected_org         ON expected_devices(organisation_id);
CREATE INDEX IF NOT EXISTS idx_sku_catalog_org      ON sku_catalog(organisation_id);
CREATE INDEX IF NOT EXISTS idx_print_jobs_org       ON print_jobs(organisation_id);
CREATE INDEX IF NOT EXISTS idx_scan_events_org      ON scan_events(organisation_id);
CREATE INDEX IF NOT EXISTS idx_grade_audit_org      ON grade_audit(organisation_id);

-- app_settings was a global singleton (id=1). Multi-tenancy means each org
-- needs its own print configuration, so we rekey it on organisation_id.
CREATE TABLE app_settings_new (
  organisation_id INTEGER PRIMARY KEY REFERENCES organisations(id),
  print_mode TEXT NOT NULL DEFAULT 'browser',
  printnode_api_key TEXT,
  printnode_printer_id_large INTEGER,
  printnode_printer_id_small INTEGER,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO app_settings_new (organisation_id, print_mode, printnode_api_key, printnode_printer_id_large, printnode_printer_id_small, updated_at)
SELECT 1, print_mode, printnode_api_key, printnode_printer_id_large, printnode_printer_id_small, updated_at
FROM app_settings WHERE id = 1;
DROP TABLE app_settings;
ALTER TABLE app_settings_new RENAME TO app_settings;

-- ───────── 3. received_devices: status enum + org/user attribution ─────────
-- Recreate-and-copy dance because SQLite can't ALTER a CHECK constraint or
-- a column default in place. Existing rows all have status='received'
-- (the only value ever written) — normalised to 'RECEIVED' below, with a
-- defensive fallback mapping for any historical 'graded'/'sold' values.

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
      'RETURNED_UNDER_OPR','SOLD','REJECTED'
    )),
  label_printed_at DATETIME,
  notes TEXT,
  created_by_user_id INTEGER,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME,
  FOREIGN KEY (manifest_id)        REFERENCES manifests(id)        ON DELETE SET NULL,
  FOREIGN KEY (expected_device_id) REFERENCES expected_devices(id) ON DELETE SET NULL
);

INSERT INTO received_devices_new
  (id, organisation_id, uuid, imei, sku, brand, model, capacity, color, grade, source,
   manifest_id, expected_device_id, status, label_printed_at, notes, created_at, updated_at)
SELECT
  id, 1, uuid, imei, sku, brand, model, capacity, color, grade, source,
  manifest_id, expected_device_id,
  CASE UPPER(status)
    WHEN 'RECEIVED' THEN 'RECEIVED'
    WHEN 'GRADED'   THEN 'ACTIVE_INVENTORY'
    WHEN 'SOLD'     THEN 'SOLD'
    ELSE 'RECEIVED'
  END,
  label_printed_at, notes, created_at, created_at
FROM received_devices;

DROP TABLE received_devices;
ALTER TABLE received_devices_new RENAME TO received_devices;

CREATE INDEX IF NOT EXISTS idx_received_imei     ON received_devices(imei);
CREATE INDEX IF NOT EXISTS idx_received_sku      ON received_devices(sku);
CREATE INDEX IF NOT EXISTS idx_received_manifest ON received_devices(manifest_id);
CREATE INDEX IF NOT EXISTS idx_received_org      ON received_devices(organisation_id);
CREATE INDEX IF NOT EXISTS idx_received_status   ON received_devices(status);

-- ───────── 4. device_events: append-only audit trail ─────────
-- No UPDATE/DELETE is ever issued against this table by application code —
-- enforced by convention (transitionDevice() / logDeviceEvent() are the
-- only writers) rather than a DB trigger, to keep D1 compatibility simple.

CREATE TABLE IF NOT EXISTS device_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organisation_id INTEGER NOT NULL REFERENCES organisations(id),
  device_id INTEGER REFERENCES received_devices(id),
  event_type TEXT NOT NULL,        -- e.g. RECEIVE, FORCE_ADD, MANUAL_RECEIVE, STATUS_CHANGE, REJECT, SCAN, GRADE_CHANGE
  from_status TEXT,
  to_status TEXT,
  user_id INTEGER REFERENCES users(id),
  reference TEXT,                  -- e.g. shipment / manifest id, free text
  metadata TEXT,                   -- JSON blob
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_device_events_device ON device_events(device_id);
CREATE INDEX IF NOT EXISTS idx_device_events_org    ON device_events(organisation_id);
CREATE INDEX IF NOT EXISTS idx_device_events_type   ON device_events(event_type);

-- Backfill: one synthetic RECEIVE event per existing received_devices row,
-- so "device.status == most recent event.to_status" holds for pre-existing
-- data too. from_status is NULL (first event in the device's life).
INSERT INTO device_events (organisation_id, device_id, event_type, from_status, to_status, user_id, reference, metadata, created_at)
SELECT
  rd.organisation_id, rd.id, 'RECEIVE', NULL, rd.status, NULL,
  CAST(rd.manifest_id AS TEXT),
  json_object('backfilled', true, 'source', rd.source, 'sku', rd.sku),
  rd.created_at
FROM received_devices rd;

-- Backfill: carry forward historical scan_events into device_events where
-- we can resolve them to a device by IMEI, tagged event_type='SCAN', so the
-- generalised log has continuity with pre-migration scan history.
INSERT INTO device_events (organisation_id, device_id, event_type, from_status, to_status, user_id, reference, metadata, created_at)
SELECT
  1, rd.id, 'SCAN', NULL, NULL, NULL,
  CAST(se.manifest_id AS TEXT),
  json_object('outcome', se.outcome, 'message', se.message, 'imei', se.imei, 'backfilled', true),
  se.created_at
FROM scan_events se
JOIN received_devices rd ON rd.imei = se.imei
WHERE se.outcome IN ('matched', 'duplicate');

COMMIT;
