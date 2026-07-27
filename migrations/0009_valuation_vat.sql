-- Migration 0009: capture commercial value and VAT type at goods-in
-- (Priority 4). Additive-only — plain ADD COLUMN is safe here since none
-- of these need a CHECK constraint enforced at the SQLite level (the
-- server-side validators in src/lib/validate.ts are the authority per the
-- brief: "Enforce GBP/ISO validation server-side, not just in the UI").
--
-- buy_price/currency/vat_type start NULL/GBP for existing rows — this
-- prototype's earlier receiving flow never captured them, so there is no
-- historical value to backfill. supplier_id links to the new `suppliers`
-- table added in 0008.

ALTER TABLE received_devices ADD COLUMN buy_price REAL;
ALTER TABLE received_devices ADD COLUMN currency TEXT NOT NULL DEFAULT 'GBP';
ALTER TABLE received_devices ADD COLUMN vat_type TEXT; -- MARGIN | STANDARD | ZERO, validated server-side
ALTER TABLE received_devices ADD COLUMN supplier_id INTEGER REFERENCES suppliers(id);

CREATE INDEX IF NOT EXISTS idx_received_supplier ON received_devices(supplier_id);
