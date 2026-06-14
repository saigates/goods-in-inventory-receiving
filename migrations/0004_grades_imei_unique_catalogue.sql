-- Migration 0004: strict grade set, IMEI uniqueness, grade audit, manual source
--
-- Grade rules (this prototype):
--   Only A | B | C | UG are valid.
--   Anything else from a supplier manifest is normalised to 'UG' at import.
--   UG = Ungraded (display label only — stored as UG).
--
-- Duplicate-IMEI rule (this prototype):
--   IMEI is now UNIQUE on received_devices at the DB level. The app already
--   checks before insert, but we want the constraint as the final safety net.
--
-- Schema migration is done via the standard SQLite recreate-and-copy dance
-- because SQLite can't ALTER TABLE ADD CONSTRAINT.

BEGIN TRANSACTION;

-- 1. Normalise existing grades on expected_devices to A|B|C|UG.
--    Anything else (B+, A-, NULL, empty, junk) → UG.
UPDATE expected_devices
SET grade = CASE
  WHEN grade IN ('A', 'B', 'C', 'UG') THEN grade
  ELSE 'UG'
END;

-- 2. Recreate received_devices with the constraints we want.
--    Grade CHECK + IMEI UNIQUE + 'manual' source allowed.
CREATE TABLE received_devices_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uuid TEXT NOT NULL UNIQUE,
  imei TEXT NOT NULL UNIQUE,                                 -- now strictly unique
  sku TEXT NOT NULL,
  brand TEXT,
  model TEXT,
  capacity TEXT,
  color TEXT,
  grade TEXT NOT NULL DEFAULT 'UG'
    CHECK (grade IN ('A','B','C','UG')),                     -- strict set
  source TEXT NOT NULL
    CHECK (source IN ('manifest','unreconciled','manual')),  -- adds manual
  manifest_id INTEGER,
  expected_device_id INTEGER,
  status TEXT NOT NULL DEFAULT 'received',
  label_printed_at DATETIME,
  notes TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (manifest_id) REFERENCES manifests(id),
  FOREIGN KEY (expected_device_id) REFERENCES expected_devices(id)
);

-- Copy data, normalising grade
INSERT INTO received_devices_new
  (id, uuid, imei, sku, brand, model, capacity, color, grade, source,
   manifest_id, expected_device_id, status, label_printed_at, notes, created_at)
SELECT
  id, uuid, imei, sku, brand, model, capacity, color,
  CASE
    WHEN grade IN ('A','B','C','UG') THEN grade
    ELSE 'UG'
  END,
  source, manifest_id, expected_device_id, status, label_printed_at, notes, created_at
FROM received_devices;

DROP TABLE received_devices;
ALTER TABLE received_devices_new RENAME TO received_devices;

-- Re-create indexes (UNIQUE on imei is now from the column constraint, but the
-- non-unique helper indexes from 0001 are gone after the drop, so recreate.)
CREATE INDEX IF NOT EXISTS idx_received_imei     ON received_devices(imei);
CREATE INDEX IF NOT EXISTS idx_received_sku      ON received_devices(sku);
CREATE INDEX IF NOT EXISTS idx_received_manifest ON received_devices(manifest_id);

-- 3. Grade-change audit trail.
CREATE TABLE IF NOT EXISTS grade_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  received_device_id INTEGER NOT NULL,
  imei TEXT NOT NULL,
  old_grade TEXT,
  new_grade TEXT NOT NULL,
  actor TEXT NOT NULL DEFAULT 'operator',
  reason TEXT,
  bulk_id TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (received_device_id) REFERENCES received_devices(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_grade_audit_device ON grade_audit(received_device_id);
CREATE INDEX IF NOT EXISTS idx_grade_audit_bulk   ON grade_audit(bulk_id);

COMMIT;
