-- Migration 0032 — zoho_items / sku_map / sku_map_audit
--
-- Deliberately its OWN migration, separate from the sale-attribution /
-- freight-bill / vat_treatment migration (still unwritten, still informally
-- called "0032" in migrations-held/README.md's numbering-claimant notes —
-- see that file for why this filename is not a guarantee that THIS is the
-- content the other note meant; whichever of the queued items is written
-- first takes the true next-free number, checked fresh against this
-- `migrations/` listing at write time. As of this write, 0031 is the
-- highest applied migration and this file claims 0032; the sale-attribution
-- work will need to re-check and take 0033 or later).
--
-- Explicit instruction this migration follows (2026-09-08 brief): mapping
-- tables + audit table go in their own migration because 0032-the-label was
-- already spoken for by sale columns/freight bills/allocation runs, and
-- there's no reason to block UI-adjacent schema on that unrelated work.
--
-- Shape: two tables, not one flat map.
--   zoho_items — keyed on zoho_item_id (Zoho's own primary key), UNIQUE on
--   zoho_sku (Zoho SKU <-> Zoho Item ID is a strict bijection, confirmed
--   empirically against Z-G-MAPPING.csv: 0 bijection breaks in either
--   direction across all 747 rows).
--
--   sku_map — keyed on goods_in_sku (this business's own SKU, already the
--   join key used throughout received_devices.sku), FK to zoho_items,
--   carrying brand/model/capacity/colour/grade taken from the goods-in
--   side ONLY. Never parse these from any SKU or item-name string — the
--   source CSV documents real, accepted drift between Zoho's naming and
--   the goods-in attributes (Graphite/Space-Gray, Rose-Gold/Pink-Gold,
--   spelling variants, delimiter anomalies) that must never leak into
--   reports/placards, which read sku_map's own columns, not zoho_items.
--
-- Cardinality: one goods-in SKU -> exactly one Zoho item (sku_map.zoho_item_id
-- NOT NULL). A Zoho item MAY be referenced by more than one goods-in SKU —
-- exactly three are, intentionally (physical-SIM / eSIM pairs with no
-- separate physical-SIM Zoho catalogue entry). This is why the FK lives on
-- sku_map -> zoho_items and NOT the other way around, and why sku_map has
-- no UNIQUE(zoho_item_id) constraint — that would forbid the exact sharing
-- this schema needs to allow.
--
-- Load-time constraints belong here, not only in the loader, because the
-- planned UI edit screen is a second write path that can't be trusted to
-- re-implement loader logic (explicit instruction): UNIQUE(goods_in_sku) on
-- sku_map, UNIQUE(zoho_item_id) and UNIQUE(zoho_sku) on zoho_items. The
-- "zoho_item_id referenced by >1 goods_in_sku is fine, zoho_sku duplicated
-- under two different IDs is not" asymmetry is expressed correctly: zoho_sku
-- is UNIQUE (one row per Zoho SKU in zoho_items), sku_map.zoho_item_id is a
-- plain FK column, not unique.

CREATE TABLE IF NOT EXISTS zoho_items (
  zoho_item_id TEXT PRIMARY KEY,
  zoho_sku TEXT NOT NULL UNIQUE,
  zoho_item_name TEXT NOT NULL,
  organisation_id INTEGER NOT NULL REFERENCES organisations(id) DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_zoho_items_org ON zoho_items(organisation_id);

CREATE TABLE IF NOT EXISTS sku_map (
  goods_in_sku TEXT PRIMARY KEY,
  organisation_id INTEGER NOT NULL REFERENCES organisations(id) DEFAULT 1,
  zoho_item_id TEXT NOT NULL REFERENCES zoho_items(zoho_item_id),
  brand TEXT NOT NULL,
  model TEXT NOT NULL,
  capacity TEXT,
  color TEXT,
  grade TEXT,
  -- Free-text note field. The CSV has no note column, so an import must
  -- never overwrite this — "CSV wins" is column-scoped, not row-scoped.
  -- Primary use case: the three intentional shared-ID pairs' explanatory
  -- note, entered once via the shared-ID UI screen and expected to survive
  -- every future re-import untouched.
  note TEXT,
  -- Set when a DB row has no corresponding line in the most recent import
  -- (goods_in_sku present in DB, absent from file). Absence from the CSV
  -- is NOT a delete — orphaned rows are marked and reported, never removed,
  -- because deleting would strip the join from sales already attributed
  -- through this mapping, unrecoverable from the file.
  orphaned_at DATETIME,
  -- Optimistic locking: the UI is a second write path (manual edits) that
  -- must not silently clobber a concurrent editor or a concurrent import.
  -- Every UPDATE must check-and-increment this, not just bump updated_at
  -- (a plain timestamp has second-level resolution and this table can see
  -- rapid successive writes from an import batch).
  row_version INTEGER NOT NULL DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_sku_map_org ON sku_map(organisation_id);
CREATE INDEX IF NOT EXISTS idx_sku_map_zoho_item ON sku_map(zoho_item_id);
CREATE INDEX IF NOT EXISTS idx_sku_map_orphaned ON sku_map(orphaned_at);

-- Audit trail: every overwrite of sku_map.zoho_item_id (whether via UI edit
-- or import) is recorded with its pre-image, per explicit instruction. The
-- import routine additionally uses this table to build its "which UI-edited
-- rows did this import revert" summary (source = 'import' rows whose
-- old_zoho_item_id differs from what a prior source = 'ui_edit' row had set
-- immediately before it).
CREATE TABLE IF NOT EXISTS sku_map_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organisation_id INTEGER NOT NULL REFERENCES organisations(id),
  goods_in_sku TEXT NOT NULL,
  old_zoho_item_id TEXT,
  new_zoho_item_id TEXT NOT NULL,
  -- 'ui_edit' | 'import'
  source TEXT NOT NULL,
  -- Only set when source = 'import' — groups all audit rows from a single
  -- importer run so the "reverted these rows" summary can be built by
  -- filtering on one batch id.
  import_batch_id TEXT,
  actor_user_id INTEGER REFERENCES users(id),
  reason TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_sku_map_audit_sku ON sku_map_audit(goods_in_sku);
CREATE INDEX IF NOT EXISTS idx_sku_map_audit_batch ON sku_map_audit(import_batch_id);

-- mapping_version — single-row counter, incremented on every sku_map write
-- (UI edit or import), recorded on every valuation/attribution run so that
-- editing a mapping today doesn't retroactively change a frozen historical
-- run's numbers. Same freeze-the-basis-at-run-time principle already used
-- for freight allocation (freight_invoices.apportioned_at / the planned
-- freight_allocation_runs pointer column in the separate sale-attribution
-- migration). A single-row table (not a bare column on some other table)
-- because there is exactly one global counter per organisation, not one
-- per sku_map row.
CREATE TABLE IF NOT EXISTS sku_map_version (
  organisation_id INTEGER PRIMARY KEY REFERENCES organisations(id),
  mapping_version INTEGER NOT NULL DEFAULT 0,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
INSERT OR IGNORE INTO sku_map_version (organisation_id, mapping_version) VALUES (1, 0);
