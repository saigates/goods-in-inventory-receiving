-- Migration 0022: Device Lifecycle slice 1 (C15-D37) — repair_jobs table
-- and Zoho upload-queue tables. Depends on migration 0021 having already
-- added 'QC_FAILED'/'READY_FOR_ZOHO' to received_devices.status.
--
-- Field list for repair_jobs is the CONFIRMED, authoritative list from
-- docs/plan/device-lifecycle-slice1.md "Amendment 1 resolution" (option b,
-- compatibility layer) — repair_cost_gbp/parts_cost_gbp/labour_cost_gbp/
-- cost_source/cost_source_reference/cost_recorded_at/cost_recorded_by.
-- GBP-only by design (slice 1); no currency column here (see that doc).
--
-- NAMING COLLISION NOTE (mandatory naming rule, dev instruction
-- 2026-08-11): repair_jobs.repair_cost_gbp is the IN-HOUSE repair cost.
-- It is NOT the same value as shipments.repair_cost (OPR's overseas-
-- repairer invoice amount, the customs VAT base) or
-- Ce1154.repair_cost_gbp (src/lib/oprImport.ts) which is that invoice
-- amount converted to GBP. These three are deliberately namespaced by
-- ACCESS PATH, not by column rename (the repair_jobs field list above is
-- already a ratified design-doc decision): every reference to this
-- in-house figure is nested under a repair_job/job object
-- (repair_job.repair_cost_gbp), every OPR reference stays nested under
-- shipment/ce1154 (shipment.repair_cost, ce1154.repair_cost_gbp). No
-- top-level/bare repair_cost_gbp identifier is exported across module
-- boundaries in this migration's application code.

CREATE TABLE IF NOT EXISTS repair_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organisation_id INTEGER NOT NULL REFERENCES organisations(id),
  device_id INTEGER NOT NULL REFERENCES received_devices(id),
  imei TEXT NOT NULL,                 -- snapshot at job-start time, for by-IMEI lookups
  fault_code TEXT NOT NULL,           -- placeholder: present-and-non-empty free text, no controlled list
  status TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'awaiting_qc', 'completed', 'cancelled')),
  -- QC (Amendment 2 resolution): PENDING until recorded; a FAILED result
  -- requires qc_fail_reason to be non-null (enforced in application code,
  -- not a CHECK, since the requirement is conditional on qc_result).
  qc_result TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (qc_result IN ('PENDING', 'PASSED', 'FAILED')),
  qc_fail_reason TEXT,
  qc_by INTEGER REFERENCES users(id),
  qc_at DATETIME,
  -- ── 7 confirmed cost fields (Amendment 1 resolution) — GBP-only, null until costed ──
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
CREATE INDEX IF NOT EXISTS idx_repair_jobs_device ON repair_jobs(device_id);
CREATE INDEX IF NOT EXISTS idx_repair_jobs_org    ON repair_jobs(organisation_id);
CREATE INDEX IF NOT EXISTS idx_repair_jobs_imei   ON repair_jobs(imei);
CREATE INDEX IF NOT EXISTS idx_repair_jobs_status ON repair_jobs(status);
-- At most one OPEN (non-completed/cancelled) job per device — enforced in
-- application code (partial-unique-index emulation would need a WHERE
-- clause SQLite supports, but the exact "open" set is status-dependent
-- and clearer to check explicitly server-side, matching the existing
-- codebase convention of named validation checks over DB constraints for
-- business rules — see runExportValidation/runImportValidation).

-- ── Zoho upload queue (Workstream D) ──
-- One row per IMEI, no aggregation (per design doc + test #30). Existence-
-- only SKU check happens at repair/qc time (READY_FOR_ZOHO gate), not here.
CREATE TABLE IF NOT EXISTS zoho_batches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organisation_id INTEGER NOT NULL REFERENCES organisations(id),
  status TEXT NOT NULL DEFAULT 'GENERATED'
    CHECK (status IN ('GENERATED', 'CONFIRMED', 'FAILED')),
  device_count INTEGER NOT NULL,
  generated_by_user_id INTEGER REFERENCES users(id),
  generated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  confirmed_by_user_id INTEGER REFERENCES users(id),
  confirmed_at DATETIME,
  failed_reason TEXT,
  failed_at DATETIME
);
CREATE INDEX IF NOT EXISTS idx_zoho_batches_org    ON zoho_batches(organisation_id);
CREATE INDEX IF NOT EXISTS idx_zoho_batches_status ON zoho_batches(status);

CREATE TABLE IF NOT EXISTS zoho_batch_devices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id INTEGER NOT NULL REFERENCES zoho_batches(id) ON DELETE CASCADE,
  device_id INTEGER NOT NULL REFERENCES received_devices(id),
  imei TEXT NOT NULL,   -- snapshot at batch-generation time
  sku TEXT NOT NULL,    -- snapshot at batch-generation time
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_zoho_batch_devices_batch  ON zoho_batch_devices(batch_id);
CREATE INDEX IF NOT EXISTS idx_zoho_batch_devices_device ON zoho_batch_devices(device_id);
-- A device may not appear twice in the same batch.
CREATE UNIQUE INDEX IF NOT EXISTS idx_zoho_batch_devices_unique ON zoho_batch_devices(batch_id, device_id);

-- Audit log for confirm/fail actions — idempotency for #34 is checked by
-- application code (a CONFIRMED batch's second /confirm call is a no-op
-- that returns 200 without writing a second event), not by a unique
-- constraint here (a batch could legitimately fail then be regenerated as
-- a new batch row, so batch_id+event_type is not inherently unique).
CREATE TABLE IF NOT EXISTS zoho_batch_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id INTEGER NOT NULL REFERENCES zoho_batches(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,   -- 'GENERATED' | 'CONFIRMED' | 'FAILED'
  user_id INTEGER REFERENCES users(id),
  reason TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_zoho_batch_events_batch ON zoho_batch_events(batch_id);
