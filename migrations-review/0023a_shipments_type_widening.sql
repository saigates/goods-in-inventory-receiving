-- Migration 0023a (REWRITE, 2026-08-19, Sprint G re-split): shipments
-- recreate — shipment_type CHECK widened +1 value, authorisation_id /
-- procedure_code relaxed to nullable. FIRST in the new split ordering
-- (previously LAST as 0023b) — see "SPLIT ORDERING" below for why.
--
-- Split from the original monolithic 0023 (migrations/0023_temp_export_
-- standard_and_received_at.sql, left unmodified in place, never deployed)
-- per Sprint-E instruction: "a rewritten table-recreation migration is
-- its own reviewed unit." See 0023b's header for the full nine-table
-- audit and the ON DELETE-mode audit table (Sprint G, G1).
--
-- SPLIT ORDERING (Sprint G, G2 — reversed from the previous Sprint F
-- draft): shipments recreates FIRST, received_devices SECOND (0023b).
-- The naive alternative — received_devices strictly last, with
-- shipment_lines recreated twice (once here referencing the not-yet-
-- touched received_devices, once more in 0023b re-deriving from the
-- by-then-updated copy) — was built and empirically validated
-- (/tmp/f2-final-reorder, now cleaned up) but rejected: it doubles
-- shipment_lines' exposure window and copies its data twice for a table
-- that only needs reshaping once. Instead, shipment_lines is intentionally
-- left UNTOUCHED by this file — it keeps pointing at the current
-- (pre-widening) shipments table across this migration and into 0023b,
-- where it is recreated EXACTLY ONCE, after BOTH parents have settled
-- into their final names. Empirically validated end-to-end (this pass,
-- /tmp/g3-combined, now cleaned up): full 0023a→0023b→0023c sequence
-- against a seeded copy of all 9 originally-recreated tables plus every
-- one of the 6 received_devices children — zero row loss, clean
-- foreign_key_check, no leftover _old/_new tables.
--
-- This table's 4-child accounting (sent_emails, shipment_value_deltas,
-- shipment_replies, plus shipments' own self-referencing
-- related_export_shipment_id) was already correct in the original 0023
-- and is unchanged here — the only defect in the original monolith was
-- received_devices' undercounted child list (see 0023b's header).
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
--
-- ZERO-EXPOSURE-WINDOW SWAP: the old shipments table is renamed away and
-- the new one renamed into place as two ADJACENT statements (zero
-- statements where "shipments" resolves to nothing), matching 0023b's
-- pattern. shipments_old is deliberately NOT dropped by this file — see
-- "WHAT A FAILURE HERE LEAVES" below.
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

------------------------------------------------------------------
-- ZERO-EXPOSURE-WINDOW SWAP for shipments and its 3 children that are
-- NOT shared with received_devices (sent_emails, shipment_value_deltas,
-- shipment_replies). shipment_lines is DELIBERATELY excluded from this
-- swap — see the file header. Old parent renamed away and new parent
-- renamed into place as adjacent statements; shipments_old is left
-- standing (not dropped) because shipment_lines' live FK clause still
-- reads (after this rename) "REFERENCES shipments_old(id)" and dropping
-- it now would trip that constraint. It is dropped by 0023b, once
-- shipment_lines has been repointed at the final `shipments` table.
------------------------------------------------------------------
ALTER TABLE shipments     RENAME TO shipments_old;
ALTER TABLE shipments_new RENAME TO shipments;

DROP TABLE sent_emails;
DROP TABLE shipment_value_deltas;
DROP TABLE shipment_replies;

ALTER TABLE sent_emails_new           RENAME TO sent_emails;
ALTER TABLE shipment_value_deltas_new RENAME TO shipment_value_deltas;
ALTER TABLE shipment_replies_new      RENAME TO shipment_replies;

-- shipments_old intentionally NOT dropped here. See header + 0023b.

CREATE INDEX IF NOT EXISTS idx_shipments_org     ON shipments(organisation_id);
CREATE INDEX IF NOT EXISTS idx_shipments_auth    ON shipments(authorisation_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_shipments_org_ref ON shipments(organisation_id, reference);

CREATE INDEX IF NOT EXISTS idx_sent_emails_shipment ON sent_emails(shipment_id);
CREATE INDEX IF NOT EXISTS idx_sent_emails_org      ON sent_emails(organisation_id);

CREATE INDEX IF NOT EXISTS idx_shipment_value_deltas_shipment ON shipment_value_deltas(shipment_id);
CREATE INDEX IF NOT EXISTS idx_shipment_value_deltas_org      ON shipment_value_deltas(organisation_id);

CREATE INDEX IF NOT EXISTS idx_shipment_replies_shipment ON shipment_replies(shipment_id);
CREATE INDEX IF NOT EXISTS idx_shipment_replies_org      ON shipment_replies(organisation_id);

-- NOTE: no idx_shipment_lines_* here — shipment_lines is untouched by
-- this file; its indexes are recreated once, in 0023b, alongside its
-- single recreation.

------------------------------------------------------------------
-- WHAT A FAILURE HERE LEAVES / DOES THE APP STILL FUNCTION (Sprint F/G
-- explicit ask). If any statement in this file fails on a real
-- (non-atomic) D1 deploy:
--   - Before the swap block: `shipments` is untouched, still the
--     pre-widening table. No app impact; the deploy simply needs a
--     re-run once the cause is fixed. d1_migrations correctly records
--     0023a as not-applied.
--   - During/after the swap block but before this file's guard: the app
--     is DOWN for anything touching shipments (TEMP_EXPORT_STANDARD
--     shipment creation, OPR flows) — `shipments` and its 3 recreated
--     children are in one of a few well-defined intermediate states
--     (e.g. shipments_new created but not yet swapped in, or swapped in
--     but sent_emails/shipment_value_deltas/shipment_replies still mid-
--     drop-and-rename). `shipment_lines` itself is NEVER broken by this
--     file (it isn't touched), so anything reading/writing
--     shipment_lines directly by id continues to work throughout.
--   - shipments_old surviving past this file's end (by design, until
--     0023b) is diagnosable, not a mystery: `SELECT name FROM
--     sqlite_master WHERE name = 'shipments_old'` after this file
--     should show the table if and only if 0023b has not yet completed.
--     If it is still present after the full 0023a+0023b+0023c batch is
--     supposed to have finished, that is itself the fault signal — 0023b
--     did not reach its final DROP TABLE shipments_old statement.
------------------------------------------------------------------
CREATE TABLE __fk_check_guard_0023a (ok INTEGER NOT NULL CHECK (ok = 1));
INSERT INTO __fk_check_guard_0023a (ok)
SELECT 0 FROM pragma_foreign_key_check() LIMIT 1;
DROP TABLE __fk_check_guard_0023a;
