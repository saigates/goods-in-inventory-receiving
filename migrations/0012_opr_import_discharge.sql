-- OPR 3 — Import / Discharge flow: C&E1154 inputs + re-import proof on
-- shipments. Repair cost / customs exchange rate / duty rate are DATA per
-- import shipment (they vary per repair invoice), never inline in code.
--
-- (No explicit transaction wrapper: remote D1 rejects it [CF 7500];
-- wrangler applies each migration file as a single batch, which is the
-- supported atomicity.)

-- C&E1154 calculation inputs (import shipments only; NULL on exports):
--   repair_cost           — the repairer's invoice amount, as invoiced
--   repair_cost_currency  — ISO 4217 of that invoice (GBP needs no rate)
--   customs_exchange_rate — HMRC monthly customs rate used to convert the
--                           repair cost to GBP (required when non-GBP)
--   duty_rate_pct         — duty rate applied to the commodity (e.g. 0 for
--                           smartphones under 8517)
ALTER TABLE shipments ADD COLUMN repair_cost REAL;
ALTER TABLE shipments ADD COLUMN repair_cost_currency TEXT;
ALTER TABLE shipments ADD COLUMN customs_exchange_rate REAL;
ALTER TABLE shipments ADD COLUMN duty_rate_pct REAL;

-- Proof of re-import: the MRN of the 6121 import declaration. Distinct from
-- export_mrn (which an import shipment quotes via its related export).
ALTER TABLE shipments ADD COLUMN import_mrn TEXT;
