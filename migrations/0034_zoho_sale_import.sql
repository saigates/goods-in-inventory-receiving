-- Migration 0034 — Zoho outbound sale-import support columns.
--
-- Numbering: fresh `ls migrations/ | sort -V | tail` immediately before
-- writing this file confirms 0033 (sale_attribution) is the highest
-- applied migration; this is the next number.
--
-- ── Why new columns, not a reuse of 0033's existing five ──
-- 0033 added sold_invoice_no/sold_date/sold_channel/sold_price_pence/
-- attribution/vat_treatment/sold_shipment_id, all built around the
-- assumption that a "sold" fact means SOLD status + a real customer
-- price. The Zoho outbound reconnaissance (.deploy-checks/
-- zoho-outbound-reconnaissance-2026-09-09.md, Section 3) established
-- that out_entity_type='invoice' covers THREE non-revenue dispositions
-- (FBA_TRANSFER, GRADE_CHANGE_OUT) alongside real sales, and
-- out_entity_type='vendor_credit' is a fourth, explicitly-non-revenue
-- disposition (RETURN_TO_SUPPLIER) that must NEVER set status=SOLD or
-- populate sold_price_pence (explicit instruction — a vendor credit is
-- not a sale, and forcing it through the sale columns would silently
-- misclassify it as revenue in every downstream margin/report query).
--
-- disposition: the four-way (+UNCLASSIFIED) enum derived from
-- out_contact_id, per the reconnaissance note. TEXT, no DB CHECK
-- (mirrors cost_ledger.cost_type / received_devices.attribution
-- precedent — the TypeScript union in zohoSaleImport.ts is the
-- authority, not a DB constraint), so a new disposition value can be
-- added without a migration. NULL = not yet imported / not applicable.
--
-- credit_value_pence: the vendor-credit value, kept STRICTLY SEPARATE
-- from sold_price_pence per explicit instruction ("credit value goes in
-- its own field, never the sold-price field"). INTEGER pence, following
-- the Amendment-1 money-column convention (0033's own sold_price_pence).
-- NULL unless disposition='RETURN_TO_SUPPLIER'.
--
-- zoho_out_contact_id / zoho_out_entity_number: traceability back to the
-- source Zoho row (contact id used for the disposition classification,
-- and the invoice/credit-note number for human lookup) — nullable,
-- populated only by the Zoho importer, never by the manual sale path.
--
-- (No explicit transaction wrapper: remote D1 rejects BEGIN/COMMIT
-- [CF 7500]; wrangler applies this file as a single batch.)

ALTER TABLE received_devices ADD COLUMN disposition TEXT;
ALTER TABLE received_devices ADD COLUMN credit_value_pence INTEGER;
ALTER TABLE received_devices ADD COLUMN zoho_out_contact_id TEXT;
ALTER TABLE received_devices ADD COLUMN zoho_out_entity_number TEXT;

CREATE INDEX IF NOT EXISTS idx_received_devices_disposition ON received_devices(disposition);
