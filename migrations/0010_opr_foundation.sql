-- Migration 0010: OPR (Outward Processing Relief) Foundation — OPR 1 track.
--
-- CORRECTION (see migration 0018): the chief_number column below was named
-- from a fabricated premise — there is no "CHIEF number" on this
-- authorisation. It was renamed to op_authorisation_number in 0018; the
-- comments here are left as historical record of what this migration
-- actually applied, but must not be read as confirming a CHIEF-format
-- identifier exists.
--
-- Entities only (no export/import workflow yet — that's OPR 2/3):
--   1. opr_authorisations — a configurable Authorisation record. The real
--      values (Saigates Limited, EORI GB369979995000, CDS + [see 0018]
--      numbers, GBNCL001 supervising office, 8517130000 commodity scope,
--      1:1 yield, 6-month discharge) live as DATA in this table, never
--      inline in code. Both number formats are stored because HMRC paper
--      forms (C&E1154) want the OPR Authorisation Number while CDS
--      declarations want the CDS Authorisation Number — confusing them is
--      a known failure mode (renamed from "CHIEF" in 0018 — no such
--      identifier exists).
--   2. shipments — the consignment entity ABOVE devices: direction
--      (export|import), type (OPR_REPAIR), status, procedure code +
--      additional procedure code, consignee, carrier, incoterm, currency
--      (GBP enforced server-side per the "GBP not UKL" constraint; the
--      column default documents intent but src/routes/opr.ts is the
--      authority), ship date, and the linkage to the authorisation.
--   3. shipment_lines — device line snapshots. Value/attributes are FROZEN
--      at the time the device is added to the shipment (customs documents
--      must reflect what was declared, not what the device row later
--      becomes). received_device_id keeps the linkage; the snapshot columns
--      are the declared truth.
--
-- No device status transitions are wired here — READY_FOR_EXPORT →
-- IN_EXPORT_CONSIGNMENT etc. belong to the OPR 2 consignment builder.
--
-- (No explicit transaction wrapper: remote D1 rejects BEGIN/COMMIT
-- [CF 7500]; wrangler applies this file as a single batch.)

CREATE TABLE IF NOT EXISTS opr_authorisations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organisation_id INTEGER NOT NULL REFERENCES organisations(id),
  holder_name TEXT NOT NULL,                -- e.g. 'Saigates Limited'
  eori TEXT NOT NULL,                       -- e.g. 'GB369979995000'
  cds_number TEXT NOT NULL,                 -- CDS-format, for CDS declarations
  chief_number TEXT,                        -- legacy CHIEF-format, for C&E1154 paper forms
  valid_from DATE NOT NULL,
  valid_to DATE NOT NULL,
  supervising_office_name TEXT,             -- e.g. 'HMRC S1756 IP-OP Customs Liverpool'
  supervising_office_code TEXT,             -- e.g. 'GBNCL001'
  commodity_scope TEXT,                     -- human description, e.g. 'Smartphones'
  commodity_codes TEXT,                     -- comma-separated codes, e.g. '8517130000'
  rate_of_yield TEXT NOT NULL DEFAULT '1:1',
  discharge_period_months INTEGER NOT NULL DEFAULT 6,
  notes TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME
);
CREATE INDEX IF NOT EXISTS idx_opr_auth_org ON opr_authorisations(organisation_id);
-- One CDS number is one authorisation — duplicates would make the
-- shipment → authorisation linkage ambiguous.
CREATE UNIQUE INDEX IF NOT EXISTS idx_opr_auth_cds ON opr_authorisations(organisation_id, cds_number);

CREATE TABLE IF NOT EXISTS shipments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organisation_id INTEGER NOT NULL REFERENCES organisations(id),
  reference TEXT NOT NULL,                  -- human reference, unique per org
  direction TEXT NOT NULL CHECK (direction IN ('export','import')),
  shipment_type TEXT NOT NULL DEFAULT 'OPR_REPAIR'
    CHECK (shipment_type IN ('OPR_REPAIR')),
  status TEXT NOT NULL DEFAULT 'DRAFT'
    CHECK (status IN ('DRAFT','FINALISED','CANCELLED')),  -- FINALISED wired in OPR 2
  authorisation_id INTEGER NOT NULL REFERENCES opr_authorisations(id),
  procedure_code TEXT NOT NULL,             -- '2100' | '2200' (export), '6121' (import) — validated server-side
  additional_procedure_code TEXT,           -- 'B51' | 'B02' | NULL — validated server-side (2100+B51 forbidden)
  consignee_name TEXT,                      -- overseas repairer / vendor
  consignee_address TEXT,
  carrier TEXT,                             -- e.g. 'FedEx'
  carrier_account TEXT,
  incoterm TEXT,                            -- e.g. 'DAP'
  currency TEXT NOT NULL DEFAULT 'GBP',     -- GBP enforced server-side ("GBP, not UKL")
  ship_date DATE,
  -- import shipments reference the export they discharge (OPR 3 uses this):
  related_export_shipment_id INTEGER REFERENCES shipments(id),
  export_mrn TEXT,                          -- captured at finalisation (OPR 2)
  notes TEXT,
  created_by_user_id INTEGER,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME
);
CREATE INDEX IF NOT EXISTS idx_shipments_org ON shipments(organisation_id);
CREATE INDEX IF NOT EXISTS idx_shipments_auth ON shipments(authorisation_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_shipments_org_ref ON shipments(organisation_id, reference);

CREATE TABLE IF NOT EXISTS shipment_lines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organisation_id INTEGER NOT NULL REFERENCES organisations(id),
  shipment_id INTEGER NOT NULL REFERENCES shipments(id) ON DELETE CASCADE,
  received_device_id INTEGER NOT NULL REFERENCES received_devices(id),
  -- ── Snapshot columns: frozen at the moment the line is added. ──
  imei TEXT NOT NULL,
  sku TEXT,
  brand TEXT,
  model TEXT,
  capacity TEXT,
  color TEXT,
  grade TEXT,
  unit_value REAL NOT NULL,                 -- from received_devices.buy_price at add time
  currency TEXT NOT NULL DEFAULT 'GBP',
  added_by_user_id INTEGER,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_shipment_lines_shipment ON shipment_lines(shipment_id);
CREATE INDEX IF NOT EXISTS idx_shipment_lines_device ON shipment_lines(received_device_id);
-- A device appears at most once per shipment.
CREATE UNIQUE INDEX IF NOT EXISTS idx_shipment_lines_unique ON shipment_lines(shipment_id, received_device_id);
