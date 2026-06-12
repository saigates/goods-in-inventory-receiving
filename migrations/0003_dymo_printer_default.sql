-- Rename the default printer to a real DYMO LabelWriter 450
-- and migrate any existing rows that still carry the old default
-- ("Zebra-ZD420-Bay1" from very early versions, or "DYMO-LW550-Bay1"
-- from the rename-without-migration).

-- Note: SQLite cannot ALTER the default of an existing column without
-- table-rebuild. We migrate the existing data and trust new code paths
-- to write the correct value going forward (handled in src/routes/scan.ts
-- via INSERT with explicit printer column).

UPDATE print_jobs
   SET printer = 'DYMO LabelWriter 450'
 WHERE printer IN ('Zebra-ZD420-Bay1', 'DYMO-LW550-Bay1', 'DYMO-LW550-Bay2');
