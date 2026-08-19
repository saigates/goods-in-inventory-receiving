-- Migration 0023c (REWRITE, 2026-08-19): removal_flags — independent new
-- table, no recreate needed. Split from 0023a/0023b per Sprint-E
-- instruction (see 0023a's header for the full defect writeup).
--
-- New table for regrade-fix 2: when POST /grade downgrades a device to
-- UG while it is ACTIVE_INVENTORY, a flag row is written here for manual
-- pull-from-shelf review. Independent of Zoho-batch state (no
-- application code writes to zoho_batches directly, confirmed prior
-- segment).
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
