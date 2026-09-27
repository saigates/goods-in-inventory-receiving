-- Migration 0040 — Z-15: partial-return balance declarations.
--
-- Numbering: `ls migrations/ | sort -V | tail` confirms 0039
-- (return_line_corrections) is the highest existing file; this is the
-- next number.
--
-- Z-15's finalise-time gate (src/routes/opr.ts finaliseImportShipment)
-- runs the SAME exported/returned aggregate GET /discharge already
-- computes (computeDischargeRow in src/lib/oprImport.ts), scoped to one
-- export, WITH the return currently finalising included in the "returned"
-- side. If that leaves outstanding > 0, the finalise is allowed to
-- proceed (Export 1's 90-plus-72 two-tranche pattern is a legitimate
-- case), but only when a partial_return_declarations row is written in
-- the same request — recording WHY the balance remains outstanding and
-- carrying it forward against the ORIGINAL export's own discharge
-- deadline (never a new/extended one; Z-15 does not grant more time).
--
-- Append-only, same convention as shipment_value_deltas (0019) /
-- shipment_misdeclaration_acks (0025) / return_line_corrections (0039):
-- every declaration is a NEW row, never an UPDATE. One row per return leg
-- that finalises with returned < exported (cumulative) for its export. A
-- fully-discharging return (returned == exported cumulative) never writes
-- a row here.
--
-- (No explicit transaction wrapper: remote D1 rejects BEGIN/COMMIT
-- [CF 7500]; wrangler applies this file as a single batch.)

CREATE TABLE IF NOT EXISTS partial_return_declarations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organisation_id INTEGER NOT NULL,
  export_shipment_id INTEGER NOT NULL,   -- the export being partially discharged
  return_shipment_id INTEGER NOT NULL,   -- the return leg being finalised (this declaration's trigger)
  exported_count INTEGER NOT NULL,       -- frozen at declaration time
  returned_count_cumulative INTEGER NOT NULL,  -- across ALL finalised returns incl. this one
  outstanding_count INTEGER NOT NULL,    -- exported_count - returned_count_cumulative
  reason TEXT NOT NULL,                  -- free text: why the balance remains outstanding
  carried_forward_deadline TEXT NOT NULL,-- = the export's own discharge deadline (unchanged,
                                          --   never a new/extended deadline — Z-15 does not
                                          --   grant more time, only records that a balance
                                          --   remains against the EXISTING deadline)
  declared_by_user_id INTEGER NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (export_shipment_id) REFERENCES shipments(id),
  FOREIGN KEY (return_shipment_id) REFERENCES shipments(id),
  FOREIGN KEY (declared_by_user_id) REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_partial_return_export ON partial_return_declarations(export_shipment_id);
CREATE INDEX IF NOT EXISTS idx_partial_return_return ON partial_return_declarations(return_shipment_id);
CREATE INDEX IF NOT EXISTS idx_partial_return_org ON partial_return_declarations(organisation_id);
