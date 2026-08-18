-- Migration 0028: bill builder (purchase + repair), append-only cost
-- ledger, and owner-paid freight invoices (Sprint B §1-§3).
--
-- ── One bill builder for two bill types (§1) ──
-- `bills` is deliberately ONE table for both `bill_type` values ('purchase'
-- | 'repair') — the Syncere repair invoice and an LW001 purchase invoice
-- have the same shape (vendor, date, invoice number, currency, total,
-- per-IMEI lines). `price_source` selects one of three pricing modes:
-- 'header' (one implicit line = the header total), 'per_line' (priced
-- groups, each optionally covering >1 serial), 'per_imei' (one price per
-- device). Per-IMEI is mandatory support from day one (not optional): the
-- 162-unit batch proves a header total cannot reconstruct true per-unit
-- variation (£160-£182 for the same model/storage).
--
-- Multi-currency (GBP/USD/AED): every bill_lines row that carries a price
-- ALSO carries the exchange rate actually used for that line
-- (exchange_rate_used) and the resulting GBP amount already rounded to
-- pence (unit_price_gbp). bills.gbp_total is the APPLICATION-COMPUTED sum
-- of those rounded per-line GBP amounts — never a re-conversion of the
-- header declared_total. bills.header_residual_gbp stores the (small)
-- difference between converting declared_total directly at the header
-- rate and the summed, independently-rounded lines — this is the
-- documented residual, not an apportioned fix-up. Never apportion a
-- converted header total across lines: that is the named historical
-- defect (£39,932 against a true £39,386) this schema exists to prevent.
--
-- rate_source is one of 'manual' | 'zoho' | 'hmrc_monthly'. exchange_rate/
-- rate_date on the header are the ACCOUNTING rate; a bill may additionally
-- carry customs_exchange_rate distinct from the accounting rate where the
-- two diverge (mirrors shipments.customs_exchange_rate, a separate
-- concept from any accounting rate, established in 0012).
--
-- Close rules: a bill can only move to status='closed' once
-- sum(bill_lines GBP) == declared_total_gbp, UNLESS force-closed — in
-- which case a row is written to `bill_close_overrides`, an APPEND-ONLY
-- log, reusing the shipment_misdeclaration_acks pattern (0025) rather than
-- a single mutable timestamp/actor pair. "Currently closed" is bills.
-- status = 'closed'; the override row is the permanent reasoned record of
-- WHY it was allowed to close unbalanced.
--
-- ── Cost ledger (§2) — append-only, typed, per device ──
-- cost_ledger is ONE typed ledger per device (cost_type IN ('purchase',
-- 'repair','freight')), not per-device columns — this is what lets item 5
-- (movement/reporting) read purchase and repair costs SEPARATELY for
-- free, and what lets a device sent for repair twice accumulate a SECOND
-- 'repair' row rather than overwriting the first. Never UPDATEd or
-- DELETEd by convention (same discipline as device_events/
-- shipment_value_deltas). provenance reuses the concept from 27b4d35's
-- worksheet_input_provenance guard: 'supplier-invoiced' (off a bill line),
-- 'derived' (apportioned freight), 'default-unverified' (assumed, e.g. a
-- grade-band average cost with no traceable source document).
--
-- ── Freight invoices (§3) — owner-paid, kept separate from customs freight ──
-- freight_invoices captures freight ACTUALLY INVOICED to the owner
-- (never an accrual/estimate) against one consignment (a shipment row —
-- the export shipment for the outbound leg, or the relevant import
-- shipment for a return leg). This is a DELIBERATELY NEW, separate table
-- from shipments.inbound_freight_gbp / shipments.export_freight_gbp,
-- which are broker-generated, whole-consignment customs figures already
-- feeding computeCe1154()'s duty/VAT bases and are NOT necessarily money
-- the owner paid. Per docs/plan/device-lifecycle-slice1.md's naming-
-- separation precedent (repair_jobs.repair_cost_gbp vs.
-- shipments.repair_cost/Ce1154.repair_cost_gbp — "must never share a
-- field, a name, or a code path"), the same boundary applies here: owner-
-- paid apportioned freight (this table + cost_ledger) vs. broker customs
-- freight (existing shipments columns, unchanged) are two distinct
-- fields, and the apportionment engine in freightApportionment.ts never
-- reads or writes the shipments customs-freight columns.
--
-- (No explicit transaction wrapper: remote D1 rejects BEGIN/COMMIT
-- [CF 7500]; wrangler applies this file as a single batch.)

CREATE TABLE IF NOT EXISTS bills (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organisation_id INTEGER NOT NULL REFERENCES organisations(id),
  bill_type TEXT NOT NULL,              -- 'purchase' | 'repair'
  vendor_name TEXT NOT NULL,
  bill_date DATE NOT NULL,              -- confirmed convention: Bill Date == purchase date, not a goods-in scan
  invoice_number TEXT NOT NULL,
  currency_code TEXT NOT NULL,          -- GBP | USD | AED (validated at the route layer via isValidCurrency)
  exchange_rate REAL,                   -- accounting rate, foreign units per GBP 1; NULL when currency_code = 'GBP'
  rate_date DATE,
  rate_source TEXT,                     -- 'manual' | 'zoho' | 'hmrc_monthly'
  -- Optional customs rate, distinct from the accounting rate above, for
  -- bills whose figures also feed a customs declaration (repair bills).
  customs_exchange_rate REAL,
  unit_count INTEGER NOT NULL,
  declared_total REAL NOT NULL,         -- header total, in currency_code
  price_source TEXT NOT NULL,           -- 'header' | 'per_line' | 'per_imei'
  -- Application-computed sum of bill_lines.unit_price_gbp (rounded to
  -- pence per line, then summed) — never a re-conversion of declared_total.
  gbp_total REAL,
  -- declared_total converted to GBP directly at the header exchange_rate
  -- (or declared_total itself when currency_code = 'GBP'). This is the
  -- HEADER'S OWN claimed total in GBP and is DELIBERATELY a separate
  -- column from gbp_total (the independently-summed line total) — the
  -- whole point of the §1 close rule is comparing these two against each
  -- other, so they must never be the same computation under two names.
  declared_total_gbp REAL,
  -- declared_total_gbp MINUS gbp_total — the stated residual from
  -- independent per-line rounding / declared-vs-actual mismatch. NULL
  -- until both figures are computed.
  header_residual_gbp REAL,
  status TEXT NOT NULL DEFAULT 'draft', -- 'draft' | 'closed'
  closed_at DATETIME,
  notes TEXT,
  created_by_user_id INTEGER REFERENCES users(id),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME
);
CREATE INDEX IF NOT EXISTS idx_bills_org ON bills(organisation_id, bill_type, status);

-- Append-only force-close record — the misdeclaration-ack pattern reused.
-- Never updated or deleted; a bill's presence of a row here alongside
-- status='closed' is what "force-closed" means to the application.
CREATE TABLE IF NOT EXISTS bill_close_overrides (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organisation_id INTEGER NOT NULL REFERENCES organisations(id),
  bill_id INTEGER NOT NULL REFERENCES bills(id),
  variance_gbp REAL NOT NULL,           -- sum(lines) - declared_total_gbp at override time, frozen
  reason TEXT NOT NULL,
  overridden_by_user_id INTEGER NOT NULL REFERENCES users(id),
  overridden_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_bill_close_overrides_bill ON bill_close_overrides(bill_id);

-- One row per priced line on a bill. In 'per_imei' mode each line covers
-- exactly one serial (see bill_line_serials); in 'per_line' mode a line
-- may cover several serials sharing one price (quantity > 1); in 'header'
-- mode there is exactly one bill_lines row per bill with quantity =
-- bills.unit_count and no attached serials at all.
CREATE TABLE IF NOT EXISTS bill_lines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organisation_id INTEGER NOT NULL REFERENCES organisations(id),
  bill_id INTEGER NOT NULL REFERENCES bills(id),
  line_no INTEGER NOT NULL,
  sku TEXT,
  description TEXT,
  quantity INTEGER NOT NULL DEFAULT 1,
  unit_price REAL,                      -- in bills.currency_code, before conversion
  exchange_rate_used REAL,              -- rate actually applied to THIS line (frozen; usually = bills.exchange_rate)
  unit_price_gbp REAL,                  -- rounded to pence — this is what cost_ledger and gbp_total read
  -- Set defensively when this row was reconstructed from a blank-key
  -- continuation row in the source file (see billBuilder.ts groupContinuationRows).
  is_continuation INTEGER NOT NULL DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_bill_lines_bill ON bill_lines(bill_id);

-- One row per serial attached to a bill line. Every bill_lines row in
-- per_imei/per_line mode must have count(bill_line_serials) == quantity
-- (enforced by billBuilder.ts, not a DB trigger — same convention as the
-- rest of this schema's app-layer invariants). received_device_id is
-- populated once the serial is matched against an existing received
-- device (either direction: device received before the bill arrived, or
-- bill line entered before the device is scanned in).
CREATE TABLE IF NOT EXISTS bill_line_serials (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organisation_id INTEGER NOT NULL REFERENCES organisations(id),
  bill_line_id INTEGER NOT NULL REFERENCES bill_lines(id),
  imei TEXT NOT NULL,
  received_device_id INTEGER REFERENCES received_devices(id),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_bill_line_serials_line ON bill_line_serials(bill_line_id);
CREATE INDEX IF NOT EXISTS idx_bill_line_serials_imei ON bill_line_serials(organisation_id, imei);
CREATE INDEX IF NOT EXISTS idx_bill_line_serials_device ON bill_line_serials(received_device_id);

-- Append-only, typed cost ledger — one row per cost EVENT, not per-device
-- columns. Never UPDATEd/DELETEd. Repair costs accumulate: a device sent
-- out twice gets two 'repair' rows, never an overwrite of the first.
CREATE TABLE IF NOT EXISTS cost_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organisation_id INTEGER NOT NULL REFERENCES organisations(id),
  received_device_id INTEGER NOT NULL REFERENCES received_devices(id),
  cost_type TEXT NOT NULL,              -- 'purchase' | 'repair' | 'freight'
  amount_gbp REAL NOT NULL,
  currency_code TEXT NOT NULL,          -- original currency this cost was invoiced in
  exchange_rate REAL,
  rate_date DATE,
  source_bill_line_id INTEGER REFERENCES bill_lines(id),      -- NULL for freight (sourced from freight_invoices instead)
  source_freight_invoice_id INTEGER,    -- see freight_invoices below; no FK type mixing with bill_lines
  provenance TEXT NOT NULL,             -- 'supplier-invoiced' | 'derived' | 'default-unverified'
  note TEXT,
  created_by_user_id INTEGER REFERENCES users(id),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_cost_ledger_device ON cost_ledger(received_device_id, cost_type);
CREATE INDEX IF NOT EXISTS idx_cost_ledger_org ON cost_ledger(organisation_id);

-- Owner-paid freight, ACTUALLY INVOICED only (no accruals/estimates).
-- One row per consignment leg. `shipment_id` is the consignment: the
-- export shipment for the 'outbound' leg, or the relevant import shipment
-- for a 'return' leg. Deliberately separate from shipments.
-- inbound_freight_gbp / export_freight_gbp (broker-generated customs
-- figures already feeding computeCe1154() — see the module comment
-- above). The AED 945.99 billed to Syncere (or any conversion of it) is
-- specifically NOT booked here — it is a repair-adjacent charge, not
-- consignment freight, and must never enter this apportionment.
CREATE TABLE IF NOT EXISTS freight_invoices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organisation_id INTEGER NOT NULL REFERENCES organisations(id),
  shipment_id INTEGER NOT NULL REFERENCES shipments(id),
  leg TEXT NOT NULL,                    -- 'outbound' | 'return'
  amount REAL NOT NULL,                 -- in currency_code, as actually invoiced
  currency_code TEXT NOT NULL,
  exchange_rate REAL,
  amount_gbp REAL NOT NULL,             -- frozen GBP figure the apportionment runs against
  invoice_ref TEXT,
  invoiced_at DATE,
  -- Set once apportionFreightByValue() has run for this invoice and
  -- written cost_ledger rows for every device on the consignment.
  apportioned_at DATETIME,
  created_by_user_id INTEGER REFERENCES users(id),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_freight_invoices_shipment ON freight_invoices(shipment_id, leg);
