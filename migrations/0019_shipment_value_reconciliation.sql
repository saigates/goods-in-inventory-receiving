-- OPR — value reconciliation: goods-value discharge check (not just unit
-- counts) + a durable delta record of every declared-value correction.
--
-- Context: shipment_lines.unit_value is FROZEN at add-time and is never
-- subsequently updated anywhere in the codebase (confirmed by search) —
-- customs truth must not silently drift. So a "value change" tracked here
-- is never an edit to a line's declared value. It is ops recording or
-- correcting the DECLARED RECONCILIATION VALUE for an export batch (e.g.
-- against a FedEx/manifest total) — a separate, explicit field from the
-- computed sum of the batch's frozen lines.
--
--   reconciled_value_gbp — starts NULL (defaults to the computed sum of
--   the shipment's lines until ops explicitly reconciles it via
--   POST /shipments/:id/reconcile-value). Every correction after that
--   writes a permanent row to shipment_value_deltas: old value, new
--   value, difference, timestamp, actor — nothing is ever overwritten
--   or deleted from that table.
--
-- Invariant (protected, see project instructions): this is goods-value
-- bookkeeping only. It is never read by computeCe1154() or
-- parseRepairFields() — the VAT/duty basis stays the repair cost,
-- completely untouched by this migration and the code that uses it.
--
-- (No explicit transaction wrapper: remote D1 rejects BEGIN/COMMIT
-- [CF 7500]; wrangler applies this file as a single batch.)

ALTER TABLE shipments ADD COLUMN reconciled_value_gbp REAL;

CREATE TABLE IF NOT EXISTS shipment_value_deltas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organisation_id INTEGER NOT NULL,
  shipment_id INTEGER NOT NULL,
  old_value_gbp REAL NOT NULL,     -- baseline: previous reconciled_value_gbp, or (first correction) the computed sum of lines at that time
  new_value_gbp REAL NOT NULL,
  difference_gbp REAL NOT NULL,    -- new_value_gbp - old_value_gbp
  note TEXT,
  user_id INTEGER,                 -- actor
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (shipment_id) REFERENCES shipments(id)
);
CREATE INDEX IF NOT EXISTS idx_shipment_value_deltas_shipment ON shipment_value_deltas(shipment_id);
CREATE INDEX IF NOT EXISTS idx_shipment_value_deltas_org ON shipment_value_deltas(organisation_id);
