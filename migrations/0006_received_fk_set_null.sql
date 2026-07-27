-- Migration 0006: let received_devices survive their parent manifest.
--
-- Bug: deleting a manifest failed with FOREIGN KEY constraint failed because
--   received_devices.manifest_id → manifests(id)               had no ON DELETE
--   received_devices.expected_device_id → expected_devices(id) had no ON DELETE
-- expected_devices itself cascades from manifests, so the cascade was being
-- blocked the moment it tried to remove an expected_device that any
-- received_device pointed at.
--
-- Promise on the delete confirmation: "Received devices will remain in inventory."
-- The right behaviour is therefore ON DELETE SET NULL on both FKs: the device
-- keeps its own copy of sku/brand/model/imei/etc. and just unhitches from the
-- parent manifest + expected line.
--
-- SQLite needs the recreate-and-copy dance to change FK clauses.

-- (explicit transaction wrapper removed: remote D1 rejects it [CF 7500];
-- wrangler applies each migration file as a single batch, which is the
-- supported atomicity mechanism on D1.)

CREATE TABLE received_devices_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
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
  status TEXT NOT NULL DEFAULT 'received',
  label_printed_at DATETIME,
  notes TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (manifest_id)        REFERENCES manifests(id)        ON DELETE SET NULL,
  FOREIGN KEY (expected_device_id) REFERENCES expected_devices(id) ON DELETE SET NULL
);

INSERT INTO received_devices_new
  (id, uuid, imei, sku, brand, model, capacity, color, grade, source,
   manifest_id, expected_device_id, status, label_printed_at, notes, created_at)
SELECT
  id, uuid, imei, sku, brand, model, capacity, color, grade, source,
  manifest_id, expected_device_id, status, label_printed_at, notes, created_at
FROM received_devices;

DROP TABLE received_devices;
ALTER TABLE received_devices_new RENAME TO received_devices;

-- Recreate indexes (lost with the table)
CREATE INDEX IF NOT EXISTS idx_received_imei     ON received_devices(imei);
CREATE INDEX IF NOT EXISTS idx_received_sku      ON received_devices(sku);
CREATE INDEX IF NOT EXISTS idx_received_manifest ON received_devices(manifest_id);

-- (transaction-end statement removed — see note where the wrapper began.)
