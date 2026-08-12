-- Migration 0023: TEMP_EXPORTED_STANDARD device statuses + shipment_type
-- enum widening, received_at on received_devices, removal_flags table.
--
-- Production row counts confirmed via `gsk hosted d1_query` immediately
-- before writing this file: shipments=0, shipment_lines=0, sent_emails=0,
-- shipment_value_deltas=0, shipment_replies=0. Per standing instruction
-- ("zero rows means recreate, any rows means route flag"), this AUTHORISES
-- the full recreate-and-copy widening of shipments.shipment_type's CHECK
-- rather than a route-flag workaround.
--
-- received_devices=193, device_events=403 (non-zero, pre-existing
-- territory already solved by migration 0021's proven pattern) —
-- print_jobs=0, grade_audit=0 also confirmed.
--
-- Because shipment_lines is simultaneously a child of received_devices
-- (via received_device_id, NO ACTION) and of shipments (via shipment_id,
-- ON DELETE CASCADE), and BOTH parents need their CHECK widened in this
-- same pass (received_devices.status: +2 values; shipments.shipment_type:
-- +1 value), this is a combined 9-table recreate, not two independent
-- 5-table ones: received_devices_new, device_events_new,
-- shipment_lines_new (repointed at BOTH new parents), print_jobs_new,
-- grade_audit_new, shipments_new, sent_emails_new,
-- shipment_value_deltas_new, shipment_replies_new — all parents created
-- before any child that references them, rows copied, then ALL children
-- dropped before either parent, then both old parents dropped, then
-- everything renamed into final names. Dependency-order lesson carried
-- forward from migration 0021 REVISION 3: dropping a table only checks
-- constraints IT declares, never incoming references to it — so children
-- always drop safely before parents regardless of NO ACTION vs CASCADE.
--
-- Two new device statuses added to received_devices.status:
--   TEMP_EXPORTED_STANDARD  - mirrors EXPORTED_UNDER_OPR, but for the new
--                              non-customs "temporary export, standard"
--                              consignment type.
--   RETURNED_UNDER_STANDARD - mirrors RETURNED_UNDER_OPR, the return-side
--                              counterpart.
-- Design: READY_FOR_EXPORT and IN_EXPORT_CONSIGNMENT remain SHARED
-- precursor statuses for both flows (reused, not duplicated) — only the
-- final finalise-time transition diverges by shipment.shipment_type. See
-- src/lib/deviceLifecycle.ts for the ALLOWED_TRANSITIONS wiring.
--
-- One new shipment_type value added to shipments.shipment_type:
--   TEMP_EXPORT_STANDARD - the new non-customs consignment type. Existing
--                           'OPR_REPAIR' value and default unchanged.
--
-- received_at (plain ALTER, no recreate needed) records when a device was
-- physically received, independent of created_at (row-insert time) —
-- backdatable via scan.ts's receive endpoints.
--
-- removal_flags is a new table for regrade-fix 2: when POST /grade
-- downgrades a device to UG while it is ACTIVE_INVENTORY, a flag row is
-- written here for manual pull-from-shelf review.

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
-- shipments (parent) — shipment_type CHECK widened +1 value
------------------------------------------------------------------
CREATE TABLE shipments_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organisation_id INTEGER NOT NULL REFERENCES organisations(id),
  reference TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('export','import')),
  shipment_type TEXT NOT NULL DEFAULT 'OPR_REPAIR'
    CHECK (shipment_type IN ('OPR_REPAIR','TEMP_EXPORT_STANDARD')),
  status TEXT NOT NULL DEFAULT 'DRAFT'
    CHECK (status IN ('DRAFT','FINALISED','CANCELLED')),
  authorisation_id INTEGER REFERENCES opr_authorisations(id),
  procedure_code TEXT,
  additional_procedure_code TEXT,
  consignee_name TEXT,
  consignee_address TEXT,
  carrier TEXT,
  carrier_account TEXT,
  incoterm TEXT,
  currency TEXT NOT NULL DEFAULT 'GBP',
  ship_date DATE,
  related_export_shipment_id INTEGER REFERENCES shipments_new(id),
  export_mrn TEXT,
  notes TEXT,
  created_by_user_id INTEGER,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME,
  ducr TEXT,
  ead_mrn TEXT,
  finalised_at DATETIME,
  finalised_by_user_id INTEGER,
  repair_cost REAL,
  repair_cost_currency TEXT,
  customs_exchange_rate REAL,
  duty_rate_pct REAL,
  import_mrn TEXT,
  mucr TEXT,
  reconciled_value_gbp REAL,
  customs_entry_ref TEXT,
  vat_evidence_ref TEXT,
  repair_cost_confirmed_at DATETIME,
  repair_cost_confirmed_by_user_id INTEGER
);
-- NOTE: authorisation_id and procedure_code are relaxed from NOT NULL to
-- nullable here — required for TEMP_EXPORT_STANDARD shipments, which per
-- the standing "no customs machinery" instruction have no OPR
-- authorisation and no procedure code. OPR_REPAIR creation code (opr.ts)
-- continues to always supply both; this is a widening, not a removal, of
-- guarantees for the existing flow.

INSERT INTO shipments_new
  (id, organisation_id, reference, direction, shipment_type, status,
   authorisation_id, procedure_code, additional_procedure_code,
   consignee_name, consignee_address, carrier, carrier_account, incoterm,
   currency, ship_date, related_export_shipment_id, export_mrn, notes,
   created_by_user_id, created_at, updated_at,
   ducr, ead_mrn, finalised_at, finalised_by_user_id, repair_cost,
   repair_cost_currency, customs_exchange_rate, duty_rate_pct, import_mrn,
   mucr, reconciled_value_gbp, customs_entry_ref, vat_evidence_ref,
   repair_cost_confirmed_at, repair_cost_confirmed_by_user_id)
SELECT
  id, organisation_id, reference, direction, shipment_type, status,
  authorisation_id, procedure_code, additional_procedure_code,
  consignee_name, consignee_address, carrier, carrier_account, incoterm,
  currency, ship_date, related_export_shipment_id, export_mrn, notes,
  created_by_user_id, created_at, updated_at,
  ducr, ead_mrn, finalised_at, finalised_by_user_id, repair_cost,
  repair_cost_currency, customs_exchange_rate, duty_rate_pct, import_mrn,
  mucr, reconciled_value_gbp, customs_entry_ref, vat_evidence_ref,
  repair_cost_confirmed_at, repair_cost_confirmed_by_user_id
FROM shipments;

------------------------------------------------------------------
-- Children of received_devices (recreated only to repoint FK)
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

------------------------------------------------------------------
-- Children of shipments (recreated only to repoint FK)
------------------------------------------------------------------
CREATE TABLE sent_emails_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organisation_id INTEGER NOT NULL,
  shipment_id INTEGER NOT NULL,
  kind TEXT NOT NULL,
  to_email TEXT NOT NULL,
  subject TEXT NOT NULL,
  provider TEXT NOT NULL DEFAULT 'gmail',
  provider_message_id TEXT,
  status TEXT NOT NULL,
  error TEXT,
  user_id INTEGER,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (shipment_id) REFERENCES shipments_new(id)
);
INSERT INTO sent_emails_new
  (id, organisation_id, shipment_id, kind, to_email, subject, provider, provider_message_id, status, error, user_id, created_at)
SELECT
  id, organisation_id, shipment_id, kind, to_email, subject, provider, provider_message_id, status, error, user_id, created_at
FROM sent_emails;

CREATE TABLE shipment_value_deltas_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organisation_id INTEGER NOT NULL,
  shipment_id INTEGER NOT NULL,
  old_value_gbp REAL NOT NULL,
  new_value_gbp REAL NOT NULL,
  difference_gbp REAL NOT NULL,
  note TEXT,
  user_id INTEGER,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (shipment_id) REFERENCES shipments_new(id)
);
INSERT INTO shipment_value_deltas_new
  (id, organisation_id, shipment_id, old_value_gbp, new_value_gbp, difference_gbp, note, user_id, created_at)
SELECT
  id, organisation_id, shipment_id, old_value_gbp, new_value_gbp, difference_gbp, note, user_id, created_at
FROM shipment_value_deltas;

CREATE TABLE shipment_replies_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organisation_id INTEGER NOT NULL,
  shipment_id INTEGER NOT NULL,
  from_mailbox TEXT NOT NULL,
  summary TEXT NOT NULL,
  received_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  logged_by_user_id INTEGER,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (shipment_id) REFERENCES shipments_new(id)
);
INSERT INTO shipment_replies_new
  (id, organisation_id, shipment_id, from_mailbox, summary, received_at, logged_by_user_id, created_at)
SELECT
  id, organisation_id, shipment_id, from_mailbox, summary, received_at, logged_by_user_id, created_at
FROM shipment_replies;

------------------------------------------------------------------
-- shipment_lines — dual child of BOTH received_devices AND shipments;
-- repointed at both *_new parents in the same CREATE.
------------------------------------------------------------------
CREATE TABLE shipment_lines_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organisation_id INTEGER NOT NULL REFERENCES organisations(id),
  shipment_id INTEGER NOT NULL REFERENCES shipments_new(id) ON DELETE CASCADE,
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

------------------------------------------------------------------
-- Drop ALL children first (dropping a table only checks constraints IT
-- declares, never incoming references to it — always safe before parents,
-- regardless of NO ACTION vs CASCADE), THEN both old parents.
------------------------------------------------------------------
DROP TABLE device_events;
DROP TABLE print_jobs;
DROP TABLE grade_audit;
DROP TABLE sent_emails;
DROP TABLE shipment_value_deltas;
DROP TABLE shipment_replies;
DROP TABLE shipment_lines;
DROP TABLE received_devices;
DROP TABLE shipments;

ALTER TABLE received_devices_new       RENAME TO received_devices;
ALTER TABLE shipments_new              RENAME TO shipments;
ALTER TABLE device_events_new          RENAME TO device_events;
ALTER TABLE print_jobs_new             RENAME TO print_jobs;
ALTER TABLE grade_audit_new            RENAME TO grade_audit;
ALTER TABLE sent_emails_new            RENAME TO sent_emails;
ALTER TABLE shipment_value_deltas_new  RENAME TO shipment_value_deltas;
ALTER TABLE shipment_replies_new       RENAME TO shipment_replies;
ALTER TABLE shipment_lines_new         RENAME TO shipment_lines;

CREATE INDEX IF NOT EXISTS idx_received_imei     ON received_devices(imei);
CREATE INDEX IF NOT EXISTS idx_received_sku      ON received_devices(sku);
CREATE INDEX IF NOT EXISTS idx_received_manifest ON received_devices(manifest_id);
CREATE INDEX IF NOT EXISTS idx_received_org      ON received_devices(organisation_id);
CREATE INDEX IF NOT EXISTS idx_received_status   ON received_devices(status);
CREATE INDEX IF NOT EXISTS idx_received_supplier ON received_devices(supplier_id);

CREATE INDEX IF NOT EXISTS idx_shipments_org     ON shipments(organisation_id);
CREATE INDEX IF NOT EXISTS idx_shipments_auth    ON shipments(authorisation_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_shipments_org_ref ON shipments(organisation_id, reference);

CREATE INDEX IF NOT EXISTS idx_device_events_device ON device_events(device_id);
CREATE INDEX IF NOT EXISTS idx_device_events_org    ON device_events(organisation_id);
CREATE INDEX IF NOT EXISTS idx_device_events_type   ON device_events(event_type);

CREATE INDEX IF NOT EXISTS idx_print_status   ON print_jobs(status);
CREATE INDEX IF NOT EXISTS idx_print_jobs_org ON print_jobs(organisation_id);

CREATE INDEX IF NOT EXISTS idx_grade_audit_device ON grade_audit(received_device_id);
CREATE INDEX IF NOT EXISTS idx_grade_audit_bulk   ON grade_audit(bulk_id);
CREATE INDEX IF NOT EXISTS idx_grade_audit_org    ON grade_audit(organisation_id);

CREATE INDEX IF NOT EXISTS idx_sent_emails_shipment ON sent_emails(shipment_id);
CREATE INDEX IF NOT EXISTS idx_sent_emails_org      ON sent_emails(organisation_id);

CREATE INDEX IF NOT EXISTS idx_shipment_value_deltas_shipment ON shipment_value_deltas(shipment_id);
CREATE INDEX IF NOT EXISTS idx_shipment_value_deltas_org      ON shipment_value_deltas(organisation_id);

CREATE INDEX IF NOT EXISTS idx_shipment_replies_shipment ON shipment_replies(shipment_id);
CREATE INDEX IF NOT EXISTS idx_shipment_replies_org      ON shipment_replies(organisation_id);

CREATE INDEX IF NOT EXISTS idx_shipment_lines_device   ON shipment_lines(received_device_id);
CREATE INDEX IF NOT EXISTS idx_shipment_lines_shipment ON shipment_lines(shipment_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_shipment_lines_unique ON shipment_lines(shipment_id, received_device_id);

------------------------------------------------------------------
-- removal_flags — new table for regrade-fix 2 (UG downgrade while
-- ACTIVE_INVENTORY). Independent of Zoho-batch state (zero application
-- code writes to zoho_batches today, confirmed prior segment).
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
