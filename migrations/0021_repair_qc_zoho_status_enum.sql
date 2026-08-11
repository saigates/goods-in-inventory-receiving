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
-- SQLite can't ALTER a CHECK constraint in place, so this follows the same
-- recreate-and-copy dance used in migration 0008 for this exact table:
-- CREATE new-shape table, copy rows across unchanged, DROP old, RENAME.
-- Every column, FK, and index from 0008's received_devices is preserved
-- byte-for-byte except the status CHECK list gaining the two new values.

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

DROP TABLE received_devices;
ALTER TABLE received_devices_new RENAME TO received_devices;

CREATE INDEX IF NOT EXISTS idx_received_imei     ON received_devices(imei);
CREATE INDEX IF NOT EXISTS idx_received_sku      ON received_devices(sku);
CREATE INDEX IF NOT EXISTS idx_received_manifest ON received_devices(manifest_id);
CREATE INDEX IF NOT EXISTS idx_received_org      ON received_devices(organisation_id);
CREATE INDEX IF NOT EXISTS idx_received_status   ON received_devices(status);
CREATE INDEX IF NOT EXISTS idx_received_supplier ON received_devices(supplier_id);
