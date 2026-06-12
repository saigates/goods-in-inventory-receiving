-- App settings (singleton row, id=1). Holds the print-target config.
CREATE TABLE IF NOT EXISTS app_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  print_mode TEXT NOT NULL DEFAULT 'browser',  -- 'browser' | 'printnode' | 'manual'
  printnode_api_key TEXT,                       -- API key (sensitive, ideally a wrangler secret)
  printnode_printer_id_large INTEGER,           -- DYMO 50x30mm printer id
  printnode_printer_id_small INTEGER,           -- DYMO 32x57mm printer id
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

INSERT OR IGNORE INTO app_settings (id, print_mode) VALUES (1, 'browser');
