-- Migration 0023b (REWRITE, 2026-08-19): shipments.shipment_type CHECK
-- widened +1 value. Split from 0023a per Sprint-E instruction (see
-- 0023a's header for the full defect writeup and nine-table audit).
--
-- This table's original 5-child accounting (sent_emails,
-- shipment_value_deltas, shipment_replies, shipment_lines, shipments'
-- own self-referencing related_export_shipment_id) was correct and is
-- unchanged here — this file only widens shipment_type's CHECK. Runs
-- after 0023a so shipment_lines already carries the received_devices_new
-- repoint from that file; this file's own shipment_lines_new step
-- re-derives shipment_lines' shape from the (already-updated) live
-- shipment_lines table, so no drift between the two files' copies of it.
--
-- One new shipment_type value added:
--   TEMP_EXPORT_STANDARD - the new non-customs consignment type. Existing
--                           'OPR_REPAIR' value and default unchanged.
-- authorisation_id and procedure_code are relaxed from NOT NULL to
-- nullable — required for TEMP_EXPORT_STANDARD shipments, which per the
-- standing "no customs machinery" instruction have no OPR authorisation
-- and no procedure code. OPR_REPAIR creation code (opr.ts) continues to
-- always supply both; this is a widening, not a removal, of guarantees
-- for the existing flow.

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

CREATE TABLE shipment_lines_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organisation_id INTEGER NOT NULL REFERENCES organisations(id),
  shipment_id INTEGER NOT NULL REFERENCES shipments_new(id) ON DELETE CASCADE,
  received_device_id INTEGER NOT NULL REFERENCES received_devices(id),
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

DROP TABLE sent_emails;
DROP TABLE shipment_value_deltas;
DROP TABLE shipment_replies;
DROP TABLE shipment_lines;
DROP TABLE shipments;

ALTER TABLE shipments_new              RENAME TO shipments;
ALTER TABLE sent_emails_new            RENAME TO sent_emails;
ALTER TABLE shipment_value_deltas_new  RENAME TO shipment_value_deltas;
ALTER TABLE shipment_replies_new       RENAME TO shipment_replies;
ALTER TABLE shipment_lines_new         RENAME TO shipment_lines;

CREATE INDEX IF NOT EXISTS idx_shipments_org     ON shipments(organisation_id);
CREATE INDEX IF NOT EXISTS idx_shipments_auth    ON shipments(authorisation_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_shipments_org_ref ON shipments(organisation_id, reference);

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
-- Fail loudly if the recreate left anything inconsistent (verified
-- pattern, see 0023a's header for why this is not a bare foreign_key_check).
------------------------------------------------------------------
CREATE TABLE __fk_check_guard_0023b (ok INTEGER NOT NULL CHECK (ok = 1));
INSERT INTO __fk_check_guard_0023b (ok)
SELECT 0 FROM pragma_foreign_key_check() LIMIT 1;
DROP TABLE __fk_check_guard_0023b;
