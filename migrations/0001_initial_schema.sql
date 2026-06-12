-- Manifests (Advanced Shipping Notices)
CREATE TABLE IF NOT EXISTS manifests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reference TEXT NOT NULL UNIQUE,
  supplier TEXT NOT NULL,
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'open',  -- open | closed
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  closed_at DATETIME
);

-- Expected devices on a manifest (the ASN line items)
CREATE TABLE IF NOT EXISTS expected_devices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  manifest_id INTEGER NOT NULL,
  oem TEXT,
  condition TEXT,            -- New | Used
  description TEXT,          -- e.g. "Galaxy S24_256G"
  grade TEXT,                -- e.g. "B+"
  model_no TEXT,             -- e.g. "SM-S921N_256G"
  imei TEXT NOT NULL,
  unit_cost REAL,
  sku TEXT,                  -- pre-resolved SKU (optional)
  status TEXT NOT NULL DEFAULT 'pending', -- pending | received
  received_at DATETIME,
  received_device_id INTEGER,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (manifest_id) REFERENCES manifests(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_expected_manifest ON expected_devices(manifest_id);
CREATE INDEX IF NOT EXISTS idx_expected_imei ON expected_devices(imei);
CREATE INDEX IF NOT EXISTS idx_expected_status ON expected_devices(status);

-- Catalog of clean SKUs (brand/model/capacity/color)
CREATE TABLE IF NOT EXISTS sku_catalog (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sku TEXT NOT NULL UNIQUE,
  brand TEXT NOT NULL,
  model TEXT NOT NULL,
  capacity TEXT,
  color TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_sku_brand_model ON sku_catalog(brand, model);

-- Devices that have been physically received and accepted into inventory
CREATE TABLE IF NOT EXISTS received_devices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uuid TEXT NOT NULL UNIQUE,
  imei TEXT NOT NULL,
  sku TEXT NOT NULL,
  brand TEXT,
  model TEXT,
  capacity TEXT,
  color TEXT,
  grade TEXT,
  source TEXT NOT NULL,           -- manifest | unreconciled
  manifest_id INTEGER,
  expected_device_id INTEGER,
  status TEXT NOT NULL DEFAULT 'received', -- received | graded | sold
  label_printed_at DATETIME,
  notes TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (manifest_id) REFERENCES manifests(id),
  FOREIGN KEY (expected_device_id) REFERENCES expected_devices(id)
);
CREATE INDEX IF NOT EXISTS idx_received_imei ON received_devices(imei);
CREATE INDEX IF NOT EXISTS idx_received_sku ON received_devices(sku);
CREATE INDEX IF NOT EXISTS idx_received_manifest ON received_devices(manifest_id);

-- Print job queue (simulated PrintNode/QZ Tray integration)
CREATE TABLE IF NOT EXISTS print_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  received_device_id INTEGER NOT NULL,
  printer TEXT NOT NULL DEFAULT 'DYMO-LW550-Bay1',
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued', -- queued | sent | error
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  sent_at DATETIME,
  FOREIGN KEY (received_device_id) REFERENCES received_devices(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_print_status ON print_jobs(status);

-- Scan audit log
CREATE TABLE IF NOT EXISTS scan_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  manifest_id INTEGER,
  imei TEXT NOT NULL,
  outcome TEXT NOT NULL,  -- matched | duplicate | unreconciled | rejected
  message TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_scan_manifest ON scan_events(manifest_id);
