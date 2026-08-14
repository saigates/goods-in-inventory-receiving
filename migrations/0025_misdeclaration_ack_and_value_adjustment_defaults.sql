-- Migration 0025: misdeclaration-acknowledgement log + effective-dated
-- value-adjustment defaults (Item C follow-up).
--
-- ── Misdeclaration acknowledgement ──
-- 0024 added shipments.misdeclaration_ack_at/misdeclaration_ack_by_user_id
-- as a single timestamp/actor pair, but that was only half-wired: there was
-- no endpoint to SET it, and a single pair cannot distinguish which kind of
-- variance was acknowledged. Both real legs carry TWO independently-arising
-- variances (declared invoice value vs. computed line-sum; carried-forward
-- piece count/gross weight vs. a sibling leg) that are different broker
-- errors and must be acknowledged separately — acknowledging one must never
-- silently clear the other.
--
-- shipment_misdeclaration_acks is an append-only LOG (never updated/deleted)
-- so every acknowledgement is permanent history, mirroring the
-- shipment_value_deltas convention (0019/0023). "Currently active" is
-- computed by the application as the latest, non-lapsed row per
-- (shipment_id, variance_type) — see checkMisdeclaration()/oprImport.ts.
--
-- Values are FROZEN at acknowledgement time (declared_gbp/computed_gbp/
-- difference_gbp for 'value'; declared_count/declared_weight_kg for
-- 'piece_count'/'gross_weight'). If the line set later changes and the
-- computed device value moves, the frozen computed_gbp on the latest
-- 'value' ack no longer matches a fresh computeCe1154() run — the
-- application detects that mismatch and treats the ack as LAPSED (a fresh
-- acknowledgement is required), never silently re-validating a stale one.
--
-- (No explicit transaction wrapper: remote D1 rejects BEGIN/COMMIT
-- [CF 7500]; wrangler applies this file as a single batch.)

CREATE TABLE IF NOT EXISTS shipment_misdeclaration_acks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organisation_id INTEGER NOT NULL,
  shipment_id INTEGER NOT NULL,
  -- 'value' | 'piece_count' | 'gross_weight' — the three variance kinds
  -- checkMisdeclaration() can raise. Enforced by the route layer, not a
  -- CHECK constraint (same convention as the rest of this schema).
  variance_type TEXT NOT NULL,
  reason TEXT NOT NULL,
  -- Frozen at acknowledgement time. Only the fields relevant to
  -- variance_type are populated; the others stay NULL.
  declared_gbp REAL,
  computed_gbp REAL,
  difference_gbp REAL,
  declared_count INTEGER,
  declared_weight_kg REAL,
  suspect_carried_forward_from TEXT,
  acknowledged_by_user_id INTEGER NOT NULL,
  acknowledged_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (shipment_id) REFERENCES shipments(id)
);
CREATE INDEX IF NOT EXISTS idx_misdeclaration_acks_shipment ON shipment_misdeclaration_acks(shipment_id, variance_type);
CREATE INDEX IF NOT EXISTS idx_misdeclaration_acks_org ON shipment_misdeclaration_acks(organisation_id);

-- ── Effective-dated value-adjustment defaults ──
-- DEFAULT_VALUE_ADJUSTMENT_GBP (£1.31, both real legs) was a hard-coded
-- module constant in oprImport.ts. That is now wrong for two reasons: (1)
-- it is a broker-generated figure, same handling class as freight — it
-- must be CAPTURED per entry (shipments.value_adjustment_gbp, unchanged
-- from 0024), never computed; (2) the STANDING DEFAULT an operator's input
-- starts from must itself be able to change over time (a future FedEx
-- worksheet revision) without rewriting the meaning of historical entries
-- that were correctly £1.31 under the old standing default. A single
-- constant (in code or in a one-row settings table) cannot represent that
-- — a revision is a NEW row with its own effective_from, and
-- computeCe1154() resolves "the default in effect" by date, never by
-- overwriting history.
CREATE TABLE IF NOT EXISTS value_adjustment_defaults (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organisation_id INTEGER NOT NULL,
  amount_gbp REAL NOT NULL,
  effective_from DATE NOT NULL,
  note TEXT,
  created_by_user_id INTEGER,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_value_adjustment_defaults_org ON value_adjustment_defaults(organisation_id, effective_from);

-- Seed the standing default that both real legs (R1 2026, R2 2026) came
-- through at, effective from the authorisation's own valid_from so every
-- existing/backfilled entry resolves against it.
INSERT INTO value_adjustment_defaults (organisation_id, amount_gbp, effective_from, note)
VALUES (1, 1.31, '2026-03-01', 'Standing default at OPR authorisation start — both R1 and R2 came through at this figure.');
