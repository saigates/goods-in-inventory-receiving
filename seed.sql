-- Seed common SKUs (resolved at scan time when manifest model_no matches)
INSERT OR IGNORE INTO sku_catalog (sku, brand, model, capacity, color) VALUES
  ('SMSG-S24-256-PBK',  'Samsung', 'Galaxy S24',         '256G', 'Phantom Black'),
  ('SMSG-S24-512-PBK',  'Samsung', 'Galaxy S24',         '512G', 'Phantom Black'),
  ('SMSG-S24FE-256-GRY','Samsung', 'Galaxy S24 FE',      '256G', 'Graphite'),
  ('SMSG-S23-256-BLK',  'Samsung', 'Galaxy S23',         '256G', 'Phantom Black'),
  ('SMSG-S23-512-BLK',  'Samsung', 'Galaxy S23',         '512G', 'Phantom Black'),
  ('SMSG-S23P-256-BLK', 'Samsung', 'Galaxy S23 Plus',    '256G', 'Phantom Black'),
  ('SMSG-S23P-512-BLK', 'Samsung', 'Galaxy S23 Plus',    '512G', 'Phantom Black'),
  ('SMSG-S23FE-256-GRY','Samsung', 'Galaxy S23 FE',      '256G', 'Graphite'),
  ('SMSG-S22P-256-BLK', 'Samsung', 'Galaxy S22 Plus',    '256G', 'Phantom Black'),
  ('SMSG-S21-256-GRY',  'Samsung', 'Galaxy S21',         '256G', 'Phantom Gray'),
  ('SMSG-S20FE-128-CLD','Samsung', 'Galaxy S20 FE',      '128G', 'Cloud Navy'),
  ('SMSG-ZFLIP5-256-GRA','Samsung','Galaxy Z Flip5',     '256G', 'Graphite'),
  ('SMSG-ZFLIP5-512-GRA','Samsung','Galaxy Z Flip5',     '512G', 'Graphite'),
  ('SMSG-ZFOLD5-256-PBK','Samsung','Galaxy Z Fold5',     '256G', 'Phantom Black');

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
