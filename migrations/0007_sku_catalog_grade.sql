-- Migration 0007: catalog becomes the source of truth for SKUs.
--
-- Behaviour change: at scan time we now LOOK UP the catalog by
-- (model, capacity, color, grade) instead of inventing a SKU via buildSku().
-- That requires:
--   1. grade to be a first-class column on sku_catalog (was implicit in the
--      SKU suffix — APL-I14P-128-DPU-A vs -B vs -C vs -UG)
--   2. canonical capacity ("128", "128G", "128GB" all → "128GB")
--   3. a lookup index on (model, capacity, color, grade)
--
-- The existing 2104 rows already encode grade as the SKU suffix, so we
-- backfill grade from the last segment of the SKU after the final hyphen
-- when it's one of A | B | C | UG.

-- (explicit transaction wrapper removed: remote D1 rejects it [CF 7500];
-- wrangler applies each migration file as a single batch, which is the
-- supported atomicity mechanism on D1.)

-- 1. Add grade column (nullable for safety on backfill)
ALTER TABLE sku_catalog ADD COLUMN grade TEXT;

-- 2. Backfill grade from SKU suffix where the existing rows encode it
UPDATE sku_catalog
SET grade = CASE
  WHEN sku LIKE '%-A'  THEN 'A'
  WHEN sku LIKE '%-B'  THEN 'B'
  WHEN sku LIKE '%-C'  THEN 'C'
  WHEN sku LIKE '%-UG' THEN 'UG'
  ELSE grade
END
WHERE grade IS NULL;

-- 3. Normalise capacity to canonical "128GB" form for the rows that have
--    bare "128" or "128G". Leave NULLs and oddities alone — operator will
--    fix via catalog UI if they break lookup.
UPDATE sku_catalog
SET capacity =
  CASE
    WHEN capacity IS NULL OR capacity = '' THEN capacity
    -- already canonical
    WHEN capacity GLOB '*[0-9]GB' THEN capacity
    -- "128G" → "128GB"
    WHEN capacity GLOB '*[0-9]G'  THEN capacity || 'B'
    -- bare digits "128" → "128GB"
    WHEN capacity GLOB '[0-9]*' AND NOT capacity GLOB '*[A-Z]*' AND NOT capacity GLOB '*[a-z]*'
      THEN capacity || 'GB'
    ELSE capacity
  END
WHERE capacity IS NOT NULL;

-- 4. Lookup index. Case-insensitive equality is handled at the SQL site
--    (UPPER() in WHERE clause), so plain columns suffice here.
CREATE INDEX IF NOT EXISTS idx_sku_catalog_lookup
  ON sku_catalog(model, capacity, color, grade);

-- (transaction-end statement removed — see note where the wrapper began.)
