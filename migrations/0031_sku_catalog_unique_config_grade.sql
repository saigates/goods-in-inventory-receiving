-- Migration 0031 (renumbered from a locally-drafted 0030 before this
-- commit was ever pushed anywhere — see commit message for why 0030 was
-- wrong): constraint-backed idempotency for sku_catalog, plus a data fix
-- for the 14 rows that were never normalised.
--
-- G5 item 2 (four-grade-variant auto-generation) needs the catalogue's
-- create path to become idempotent WITHOUT a check-then-insert (see the
-- precedent this sprint found incidentally: src/lib/repairWorkflow.ts
-- startRepair() lines 71-79 has exactly that unguarded shape, logged as a
-- standalone defect, NOT fixed here — it's a different table). The
-- existing POST /api/catalog/ (src/routes/catalog.ts) currently does a
-- resolveCatalogSku() existence check, then a separate `sku` collision
-- SELECT, then INSERT — three round trips with a race window between the
-- check and the write. This migration adds a DB-level UNIQUE index on the
-- real business key so the eventual auto-generation logic can rely on
-- "INSERT ... ON CONFLICT DO NOTHING" / catch-and-treat-as-idempotent
-- instead of a pre-check.
--
-- Confirmed via live schema inspection (2026-08-20): only `sku` itself is
-- UNIQUE (sqlite_autoindex_sku_catalog_1); idx_sku_catalog_lookup on
-- (model, capacity, color, grade) is a PLAIN, non-unique index. No
-- uniqueness constraint exists on the real business key at all.
--
-- COLLISION-FREEDOM VERIFICATION SCOPE (dated, not live): "no pre-existing
-- row collides under the new key" was checked against two sources only:
-- (1) the shared local D1 (682 rows) and (2) an isolated /tmp scratch DB
-- loaded from backups/prod_backup_2026-08-11_1707.sql (2,781 rows) — a
-- 9-day-old production snapshot as of 2026-08-20, NOT a live read of
-- production. CREATE UNIQUE INDEX fails loudly (aborts the migration) on
-- an actual collision, which is the correct behaviour, but the practical
-- consequence on deploy is an aborted migration partway through a batch
-- that migrations-held/README.md documents as already non-subsettable
-- (gsk hosted deploy applies every untracked file in migrations/ as one
-- atomic action) — this file makes that batch ten migrations, not nine.
-- ACTION REQUIRED BEFORE DEPLOY: re-run the collision query below against
-- a FRESH read of production sku_catalog (not the 2026-08-11 export)
-- immediately before this batch ships, since 9 days of live writes are
-- unverified:
--   SELECT organisation_id, UPPER(brand), UPPER(model), COALESCE(capacity,''),
--          UPPER(COALESCE(color,'')), COALESCE(grade,''), COUNT(*) c
--   FROM sku_catalog GROUP BY 1,2,3,4,5,6 HAVING c > 1;
-- Expect zero rows; if not, resolve the real duplicates before deploying,
-- not by weakening this index. (The deploy gate for the whole 0023-0029+
-- batch is separately closed pending the 0023 FK-recreate fix per
-- migrations-held/README.md, so there is time to do this properly.)

-- ── Part A: data fix ────────────────────────────────────────────────────
-- 14 rows (local sandbox `seed.sql` fixture only) never passed through
-- migration 0017's own grade/capacity backfill, because seed.sql loads
-- AFTER migrations (db:seed / db:reset in package.json), not as part of
-- the migration chain. VERIFIED NO-OP ON PRODUCTION: a direct query
-- against backups/prod_backup_2026-08-11_1707.sql's sku_catalog rows
-- confirmed ZERO rows with grade IS NULL or non-canonical "256G"-style
-- capacity — every production row already carries a canonical grade and
-- capacity, so the two UPDATEs below touch only this sandbox's 14
-- seed.sql rows, never live data.
--
-- ORDERING: normalisation runs BEFORE the index is created, deliberately.
-- Canonicalising capacity ("256G" -> "256GB") and backfilling NULL grade
-- to 'UG' are exactly the kind of change that could itself CREATE a
-- collision under the new key (e.g. if some other row already existed as
-- "256GB"/'UG' for the same model/color) — running them first means any
-- such collision surfaces here, against the real values the index will
-- actually see, rather than the index being built against pre-normalised
-- data and then silently missing rows that only become duplicates once
-- normalised.
UPDATE sku_catalog
SET capacity = CASE
  WHEN capacity IS NULL OR capacity = '' THEN capacity
  WHEN capacity GLOB '*[0-9]GB' THEN capacity
  WHEN capacity GLOB '*[0-9]G'  THEN capacity || 'B'
  WHEN capacity GLOB '[0-9]*' AND NOT capacity GLOB '*[A-Za-z]*' THEN capacity || 'GB'
  ELSE capacity
END
WHERE capacity IS NOT NULL;

UPDATE sku_catalog SET grade = 'UG' WHERE grade IS NULL;

-- ── Part B: uniqueness constraint ───────────────────────────────────────
-- Business key: (organisation_id, brand, model, capacity, color, grade).
--
-- BRAND IS INCLUDED (decision, not oversight): checked empirically against
-- both datasets in this file's verification scope — zero models are
-- shared across more than one brand today (confirmed via
-- `SELECT model, COUNT(DISTINCT brand) ... HAVING > 1`, both sources),
-- and the 702-configuration count is IDENTICAL whether brand is included
-- in the grouping or not. Included anyway: model-string uniqueness across
-- brands is a fact about today's ~2,800 rows, not a schema guarantee, and
-- the same UPPER(...)-wrapped column costs nothing to add now versus
-- relying on an assumption that a future "Model X" from two different
-- OEMs never collides.
--
-- Expression index (confirmed supported by D1/SQLite via a live
-- CREATE UNIQUE INDEX ... (UPPER(...), ...) smoke test this session) so
-- the constraint matches the case-insensitive equality the application
-- already applies at read time (resolveCatalogSku / matchCatalogRows both
-- compare via UPPER(...)/norm()). Without UPPER() here, 'Galaxy S24' and
-- 'GALAXY S24' would be treated as different keys and the constraint
-- would fail to catch the exact duplicates it exists to prevent — this
-- repo's catalogue already has real mixed-case rows (brand: 'Samsung' AND
-- 'SAMSUNG' both present, confirmed via `SELECT DISTINCT brand`), so this
-- is not a hypothetical.
--
-- COALESCE(capacity, '') / COALESCE(color, '') so two rows that both have
-- a NULL capacity or color are still treated as the same key — SQLite
-- treats NULL as distinct from NULL in a UNIQUE index (an arbitrary
-- number of NULLs coexist without violating uniqueness), so a bare
-- nullable column here would silently let duplicates back in.
--
-- COALESCE(grade, '') for the SAME reason — added here to close a real
-- gap found on review: sku_catalog.grade has no NOT NULL constraint
-- (confirmed: migrations/0001 declares it `grade TEXT` with no NOT NULL,
-- and 0007's `ALTER TABLE sku_catalog ADD COLUMN grade TEXT` doesn't add
-- one either — unlike received_devices.grade, which has carried a CHECK
-- constraint since migration 0004). Part A's backfill means zero rows
-- have grade IS NULL as of this migration, which is exactly why this
-- needs to be structural now: nothing today exercises the gap, so a
-- bare, unwrapped `grade` column in the index would let any FUTURE
-- NULL-grade row bypass the uniqueness guarantee entirely — coexisting
-- with any number of other NULL-grade rows for the same
-- organisation/brand/model/capacity/color with no constraint violation,
-- silently defeating the idempotency guarantee G5 item 2 is being built
-- on. Wrapping it the same way as capacity/color closes that.
CREATE UNIQUE INDEX IF NOT EXISTS ux_sku_catalog_org_config_grade
  ON sku_catalog(
    organisation_id,
    UPPER(brand),
    UPPER(model),
    COALESCE(capacity, ''),
    UPPER(COALESCE(color, '')),
    COALESCE(grade, '')
  );
