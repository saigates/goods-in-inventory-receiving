-- Migration 0024: C&E1154 worksheet rewrite (Item C).
--
-- Context: the old computeCe1154() assessed duty/VAT on "repair cost only".
-- That is wrong — the real FedEx OPR worksheet chain is:
--   compensatory value = device value + process charge + inbound freight + insurance
--   duty base           = process charge + non-EU inbound freight share + insurance
--   VAT base             = process charge + inbound freight + export freight + duty + value adjustment
--   duty                 = duty base * tariff rate
--   VAT (PVA, postponed) = VAT base * 20%
-- Device value enters the compensatory value but NEITHER tax base — that
-- is the point of Outward Processing Relief. See src/lib/oprImport.ts.
--
-- Additive-only — plain ADD COLUMN is safe here (same reasoning as 0009 /
-- 0020): none of these need a CHECK constraint enforced at the SQLite
-- level; the server-side validators in src/routes/opr.ts are the
-- authority. All new columns live on `shipments` (import-shipment-only in
-- practice, same convention as the existing repair_cost/duty_rate_pct
-- group and the 0020 outstanding-items columns) rather than a new child
-- table — keeps every existing call site that reads `shipment.*` fields
-- directly working unchanged.
--
-- device value itself is deliberately NOT a column — per the
-- anti-misdeclaration requirement, it must always be computed by the app
-- as sumLineValues(returningLines), never typed in. declared_invoice_total_gbp
-- below is the BROKER's declared figure, kept distinct and compared against
-- the computed sum.
--
-- (No explicit transaction wrapper: remote D1 rejects BEGIN/COMMIT
-- [CF 7500]; wrangler applies this file as a single batch.)

-- ── Worksheet inputs (process charge already exists as repair_cost/
-- repair_cost_currency/customs_exchange_rate — reused, not duplicated) ──
ALTER TABLE shipments ADD COLUMN inbound_freight_gbp REAL;
ALTER TABLE shipments ADD COLUMN non_eu_freight_share_gbp REAL;
ALTER TABLE shipments ADD COLUMN export_freight_gbp REAL;
ALTER TABLE shipments ADD COLUMN insurance_gbp REAL;
-- Operator-entered input with a DEFAULT of £1.31 (both real legs came
-- through at this value) — not a hard-coded constant in code. A future
-- entry differing in VALUE is fine (flagged only via the audit trail of
-- what was actually entered); a difference in MEANING is explicitly for
-- the owner to settle, not this migration or the app to interpret.
ALTER TABLE shipments ADD COLUMN value_adjustment_gbp REAL DEFAULT 1.31;

-- Commodity/tariff code for THIS entry (doubles as both the "commodity
-- code" and "tariff code" entry facts — they are the same HS code used to
-- look up the duty rate; no reason to duplicate the column).
ALTER TABLE shipments ADD COLUMN commodity_code TEXT;

-- Duty-override flag: OVR01|DUTY OVERRIDE CLAIMED is a fact recorded on
-- the declaration, not a side-effect of duty computing to zero. Default 0
-- (not claimed) — an import shipment declaring 0% duty must explicitly
-- set this or computeCe1154() refuses (see oprImport.ts).
ALTER TABLE shipments ADD COLUMN duty_override_claimed INTEGER NOT NULL DEFAULT 0;

-- ── Entry facts (CDS declaration timestamps + quantities) ──
ALTER TABLE shipments ADD COLUMN entry_accepted_at DATETIME;
ALTER TABLE shipments ADD COLUMN entry_cleared_at DATETIME;
-- Supplementary units: the customs-declaration quantity used for
-- discharge tracking. Falls back to the line count when NULL (COALESCE at
-- read time), same convention as reconciled_value_gbp (0019).
ALTER TABLE shipments ADD COLUMN supplementary_units INTEGER;

-- ── CDS-entry-declared bases/taxes (distinct from our OWN worksheet
-- computation above). A return leg's CDS entry states duty_base/vat_base/
-- duty/VAT even before we have entered the FedEx worksheet input
-- breakdown ourselves (e.g. R2: CDS entry known, worksheet pending —
-- "OP WS 875147276207" requested from FedEx, not yet supplied). These are
-- what computeCe1154() falls back to displaying, honestly labelled
-- "pending" on the input side, when the worksheet inputs above are still
-- NULL. Once the worksheet inputs ARE entered, computeCe1154() recomputes
-- from first principles and these become a cross-check, not the source. ──
ALTER TABLE shipments ADD COLUMN entry_duty_base_gbp REAL;
ALTER TABLE shipments ADD COLUMN entry_vat_base_gbp REAL;
ALTER TABLE shipments ADD COLUMN entry_duty_gbp REAL;
ALTER TABLE shipments ADD COLUMN entry_vat_gbp REAL;

-- ── Anti-misdeclaration structural gate (Section g) ──
-- declared_invoice_total_gbp is the BROKER-declared figure (e.g. FedEx's
-- £22,588.00) — compared against the app-computed sumLineValues() figure,
-- never substituted for it. declared_piece_count / declared_gross_weight_kg
-- are the same idea for packaging facts (e.g. "two boxes and 40kg").
ALTER TABLE shipments ADD COLUMN declared_invoice_total_gbp REAL;
ALTER TABLE shipments ADD COLUMN declared_piece_count INTEGER;
ALTER TABLE shipments ADD COLUMN declared_gross_weight_kg REAL;
-- Explicit acknowledgement gate — mirrors the existing repair_cost_confirmed_at
-- pattern (0020). NULL means "not acknowledged"; finalise is red-blocked
-- by IMP_MISDECLARATION_CHECK while a variance exists and this is NULL.
ALTER TABLE shipments ADD COLUMN misdeclaration_ack_at DATETIME;
ALTER TABLE shipments ADD COLUMN misdeclaration_ack_by_user_id INTEGER;
