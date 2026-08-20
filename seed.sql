-- Seed common SKUs (resolved at scan time when manifest model_no matches)
--
-- CORRECTED (2026-08-20, G5 item 2 prep): this fixture used to omit `grade`
-- entirely and use non-canonical "256G"/"128G"/"512G" capacity strings.
-- Because seed.sql loads AFTER migrations (see db:seed / db:reset in
-- package.json), these 14 rows never passed through migration 0017's
-- grade-backfill (`UPDATE sku_catalog SET grade = 'UG' WHERE grade IS
-- NULL`) or its capacity-canonicalisation UPDATE — they were the ONLY
-- rows in a fresh local D1 with grade IS NULL or a bare "256G"-style
-- capacity (confirmed via direct query; production and every
-- migration-inserted row already use grade='UG'/'A'/etc. and canonical
-- "256GB" form). Migration 0031 (renumbered from a locally-drafted 0030
-- before it was ever pushed anywhere — see that migration's own header)
-- data-fixes any already-seeded copies of these rows in existing
-- databases; this fixture is corrected here so a fresh `db:reset`
-- doesn't reintroduce the same drift.
INSERT OR IGNORE INTO sku_catalog (sku, brand, model, capacity, color, grade) VALUES
  ('SMSG-S24-256-PBK',  'Samsung', 'Galaxy S24',         '256GB', 'Phantom Black', 'UG'),
  ('SMSG-S24-512-PBK',  'Samsung', 'Galaxy S24',         '512GB', 'Phantom Black', 'UG'),
  ('SMSG-S24FE-256-GRY','Samsung', 'Galaxy S24 FE',      '256GB', 'Graphite', 'UG'),
  ('SMSG-S23-256-BLK',  'Samsung', 'Galaxy S23',         '256GB', 'Phantom Black', 'UG'),
  ('SMSG-S23-512-BLK',  'Samsung', 'Galaxy S23',         '512GB', 'Phantom Black', 'UG'),
  ('SMSG-S23P-256-BLK', 'Samsung', 'Galaxy S23 Plus',    '256GB', 'Phantom Black', 'UG'),
  ('SMSG-S23P-512-BLK', 'Samsung', 'Galaxy S23 Plus',    '512GB', 'Phantom Black', 'UG'),
  ('SMSG-S23FE-256-GRY','Samsung', 'Galaxy S23 FE',      '256GB', 'Graphite', 'UG'),
  ('SMSG-S22P-256-BLK', 'Samsung', 'Galaxy S22 Plus',    '256GB', 'Phantom Black', 'UG'),
  ('SMSG-S21-256-GRY',  'Samsung', 'Galaxy S21',         '256GB', 'Phantom Gray', 'UG'),
  ('SMSG-S20FE-128-CLD','Samsung', 'Galaxy S20 FE',      '128GB', 'Cloud Navy', 'UG'),
  ('SMSG-ZFLIP5-256-GRA','Samsung','Galaxy Z Flip5',     '256GB', 'Graphite', 'UG'),
  ('SMSG-ZFLIP5-512-GRA','Samsung','Galaxy Z Flip5',     '512GB', 'Graphite', 'UG'),
  ('SMSG-ZFOLD5-256-PBK','Samsung','Galaxy Z Fold5',     '256GB', 'Phantom Black', 'UG');

-- ───────── OPR authorisation (OPR 1) ─────────
-- The Saigates OPR authorisation as configurable DATA (never inline in
-- code). Two distinct identifiers stored deliberately: cds_number (CDS
-- Authorisation Number) goes on CDS declarations; op_authorisation_number
-- (OPR Authorisation Number, e.g. OP/0922/601/31) goes in the C&E1154 paper
-- form's authorisation field. They must never be confused. Neither is a
-- "CHIEF number" — no legacy CHIEF-format identifier exists on this
-- authorisation (per HMRC authorisation correspondence).
INSERT OR IGNORE INTO opr_authorisations
  (id, organisation_id, holder_name, eori, cds_number, op_authorisation_number,
   valid_from, valid_to, supervising_office_name, supervising_office_code,
   commodity_scope, commodity_codes, rate_of_yield, discharge_period_months, notes,
   prealert_email, prealert_cutoff)
VALUES
  (1, 1, 'Saigates Limited', 'GB369979995000',
   'GBOPO36997999500020260226105539', 'OP/0922/601/31',
   '2026-03-01', '2031-02-28',
   'HMRC S1756 IP-OP Customs Liverpool', 'GBLIV002',
   'Smartphones', '8517130000', '1:1', 6,
   'Correspondence: Central Mail Unit Newcastle NE98 1ZZ. Goods identified by IMEI. Export 2100 (standard) / 2200+B51 or B02 (warranty; 2100+B51 NOT permitted). Re-import 6121. Carrier FedEx (declarant FedEx Express UK Limited, EORI GB271251133000); pre-alert controlprealert@fedex.com, cut-off 4pm.',
   'controlprealert@fedex.com', '16:00');

-- Rows seeded before migration 0011 predate the structured pre-alert
-- columns (INSERT OR IGNORE will not touch them) — backfill from the
-- values documented in the notes.
UPDATE opr_authorisations
   SET prealert_email = 'controlprealert@fedex.com', prealert_cutoff = '16:00'
 WHERE id = 1 AND prealert_email IS NULL;
