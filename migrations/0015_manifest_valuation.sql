-- Manifest-line valuation (optional): suppliers' files often carry a unit
-- price (already stored as expected_devices.unit_cost since 0001) — add the
-- missing currency + VAT type so the goods-in confirm modal can be
-- PRE-FILLED at scan time. These are hints only: the authoritative
-- "valuation required at receive" rule stays on /scan/confirm — the
-- operator always confirms (and may override) the values.
ALTER TABLE expected_devices ADD COLUMN currency TEXT;   -- ISO 4217, validated+uppercased at import
ALTER TABLE expected_devices ADD COLUMN vat_type TEXT;   -- MARGIN | STANDARD | ZERO, validated at import
