-- 0005: add capacity + color to expected_devices so manifest imports can
-- carry storage/colour through to receiving + SKU resolution.
ALTER TABLE expected_devices ADD COLUMN capacity TEXT;
ALTER TABLE expected_devices ADD COLUMN color TEXT;
