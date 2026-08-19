-- Migration 0030: expected_devices.condition becomes a DERIVED column
-- (grade always wins, condition is always optional), plus the matching
-- CHECK (grade IN ('A','B','C','UG')) that closes the asymmetry with
-- received_devices (has had that CHECK since 0004; expected_devices has
-- always been bare TEXT, per 0001).
--
-- SCOPE: expected_devices ONLY. received_devices is explicitly excluded —
-- it has never had a condition column at all (confirmed by grep across
-- every migration file), and even if it gains one later, its condition
-- could reflect an actual physical inspection rather than an unverified
-- vendor claim, where grade-wins derivation would destroy real
-- information. That is a decision for a future migration, not this one.
--
-- WHY THIS IS SAFE HERE: expected_devices rows are pre-receipt manifest
-- lines. Nothing in that table has been physically inspected — grade is a
-- vendor claim from the manifest, and condition was only ever derived
-- from that same claim in the first place (via whatever the uploaded
-- spreadsheet's Condition column happened to say, unvalidated — see
-- src/routes/manifests.ts, fixed in this same pass to stop reading
-- r.condition at all and call deriveConditionFromGrade() instead).
-- Replacing the stored condition with a pure function of grade therefore
-- loses no verified information; it only removes drift that a free-typed
-- spreadsheet column allowed to accumulate.
--
-- Real distribution (audited from production; NOT hard-coded into this
-- migration's UPDATE logic, which applies uniformly to every row
-- regardless of the mix of values actually present):
--   A/REFURBISHED  (197, no-op)      A/Refurbished (218, case-only)
--   C/Used         (11,  case-only)  C/Raw         (19,  semantic)
--   UG/Used        (9,   semantic)   UG/Raw        (6,   semantic)
--   UG/UG          (296, semantic — UG was never a valid condition)
-- Expected post-migration totals: REFURBISHED 415, USED 30, RAW 311,
-- total 756 unchanged, 0 rows outside the 3-value enum. Change breakdown:
-- 197 no-op / 229 case-only / 330 semantic. These are PRODUCTION numbers
-- to be verified with a post-migration SELECT when this is applied to
-- production at deploy time — this file does not (and cannot) assert
-- them itself, and local dev D1 has zero expected_devices rows to check
-- them against in advance (confirmed empty at the time of writing).
--
-- Grade scale: only A/B/C/UG are ever stored (VALID_GRADES, src/lib/
-- grade.ts). D/E are vendor-scale values that must never reach storage —
-- the CHECK below makes that a hard DB-level guarantee for
-- expected_devices, matching received_devices since 0004. NOTE (flagged
-- to the user, not resolved by this migration): src/lib/grade.ts's
-- normalizeGrade() currently coerces any non-A/B/C/UG value to 'UG'
-- BEFORE insertion, so a real vendor D/E is laundered away before this
-- CHECK ever sees it — the constraint is still correct to add (it is the
-- right invariant for the column), but it does not by itself achieve
-- "fail at import instead of at receive" for D/E under the current
-- import code path. That gap is separate from this migration and is
-- called out in src/lib/condition.ts's own comments.
--
-- SQLite can't ALTER TABLE ADD CONSTRAINT, so the CHECK is added via the
-- standard recreate-and-copy pattern (same as 0004's received_devices
-- migration). The condition derivation is applied AS PART OF the copy
-- (derive first, then the new table's constraints validate on insert —
-- so the CHECK never rejects a row this migration should have
-- normalised, matching the instructed ordering).

-- 1. Recreate expected_devices with CHECK (grade IN ('A','B','C','UG')).
--    Column order/types otherwise unchanged from the live schema
--    (0001 + 0005 capacity/color + 0008 organisation_id + 0015 currency/
--    vat_type).
CREATE TABLE expected_devices_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  manifest_id INTEGER NOT NULL,
  oem TEXT,
  condition TEXT,
  description TEXT,
  grade TEXT
    CHECK (grade IS NULL OR grade IN ('A','B','C','UG')),
  model_no TEXT,
  imei TEXT NOT NULL,
  unit_cost REAL,
  sku TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  received_at DATETIME,
  received_device_id INTEGER,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  capacity TEXT,
  color TEXT,
  organisation_id INTEGER NOT NULL DEFAULT 1,
  currency TEXT,
  vat_type TEXT,
  FOREIGN KEY (manifest_id) REFERENCES manifests(id) ON DELETE CASCADE
);

-- 2. Copy data, deriving condition from grade (grade wins; UG/D/E -> RAW,
--    A -> REFURBISHED, B/C -> USED). Rows whose grade is NULL or anything
--    outside A/B/C/UG (there should be none — normalizeGrade() already
--    forces this at write time, but the CASE has a defensive fallback of
--    RAW rather than leaving the old free-text condition value untouched,
--    to guarantee no row survives this migration with a condition outside
--    the 3-value enum).
INSERT INTO expected_devices_new
  (id, manifest_id, oem, condition, description, grade, model_no, imei,
   unit_cost, sku, status, received_at, received_device_id, created_at,
   capacity, color, organisation_id, currency, vat_type)
SELECT
  id, manifest_id, oem,
  CASE
    WHEN grade = 'A' THEN 'REFURBISHED'
    WHEN grade IN ('B', 'C') THEN 'USED'
    ELSE 'RAW'  -- UG, NULL, or anything else — grade wins, never leaves
                -- the old free-text condition value in place.
  END,
  description, grade, model_no, imei,
  unit_cost, sku, status, received_at, received_device_id, created_at,
  capacity, color, organisation_id, currency, vat_type
FROM expected_devices;

DROP TABLE expected_devices;
ALTER TABLE expected_devices_new RENAME TO expected_devices;

-- 3. Re-create indexes (dropped along with the old table).
CREATE INDEX IF NOT EXISTS idx_expected_manifest ON expected_devices(manifest_id);
CREATE INDEX IF NOT EXISTS idx_expected_imei     ON expected_devices(imei);
CREATE INDEX IF NOT EXISTS idx_expected_status   ON expected_devices(status);
CREATE INDEX IF NOT EXISTS idx_expected_org      ON expected_devices(organisation_id);
