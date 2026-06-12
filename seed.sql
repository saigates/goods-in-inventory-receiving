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
