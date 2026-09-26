-- Migration 0039 — Z-9: return-consignment re-identify/re-grade.
--
-- Numbering: `ls migrations/ | sort -V | tail` confirms 0038
-- (customs_exchange_rate_month) is the highest existing file; this is the
-- next number.
--
-- ───────── Frozen half (unchanged) vs. mutable half (new) ─────────
-- shipment_lines (both legs) stays exactly as it is today — frozen at
-- add-time, never edited, the C&E1154 exported-goods value's source of
-- truth (see addDeviceToReturnShipment's header comment in
-- src/routes/opr.ts). This migration adds the MUTABLE half beside it: what
-- the operator actually observes when a device physically comes back and
-- is re-scanned, which may legitimately diverge from what was declared at
-- export (wrong grade recorded originally, colour typo, or — the material
-- case — a different handset entirely).
--
-- return_line_corrections is append-only, same convention as
-- shipment_value_deltas (0019) / shipment_misdeclaration_acks (0025):
-- every correction is a NEW row, never an UPDATE. "Current" state for a
-- line is the latest row for that shipment_line_id.
--
-- SNAPSHOT, not diff (operator amendment 1, 2026-09-26): each row carries
-- the FULL corrected state across all seven identity fields, not just the
-- fields that changed in that particular correction. This is required for
-- "latest row wins" to be unambiguous — if row 1 corrects grade only and
-- row 2 corrects colour only, a partial-diff scheme would have row 2's
-- NULL grade silently revert the line to the frozen export grade. Every
-- INSERT here is the CALLER's responsibility to populate from (frozen
-- export line) merged with (this correction's actual changes) merged with
-- (the previous correction row, if any) — the table itself does not carry
-- that merge logic, application code does (src/lib/returnCorrections.ts).
--
-- Deliberately NO corrected_unit_value / corrected_currency column. This
-- is what makes "declared value pinned to the original export value,
-- decoupled from grade" a structural guarantee rather than a check that
-- could be forgotten: computeCe1154()'s deviceValueGbp always reads
-- shipment_lines.unit_value (frozen), and there is no column here it
-- could ever read instead.
--
-- Review severity (operator amendment 3+4): requires_review is computed
-- and frozen at correction-write time (not re-derived later, same
-- discipline as every other decision-recorded-not-re-derived field in
-- this schema — see value_adjustment_provenance for the precedent). Three
-- ways a row can set it:
--   1. is_generation_boundary = 1 (corrected_model's parsed generation
--      differs from the frozen export line's) -> requires_review = 1,
--      amber while DRAFT, HARD-BLOCKS finalise until reviewed+acknowledged
--      (mirrors shipment_misdeclaration_acks: block clears via review,
--      not by silently re-passing).
--   2. Generation could not be PARSED at all for either the frozen or the
--      corrected model string -> requires_review = 1 (fail loud, never
--      silently pass an unparseable model through as "no boundary").
--   3. corrected_imei is non-null (an IMEI correction happened at all) ->
--      requires_review = 1 UNCONDITIONALLY, always hard-blocks finalise —
--      an IMEI change is the identity proof itself failing, stricter than
--      every other field, never merely a value-difference question.
--   (Catalog-value-difference trigger — corrected spec's catalog price vs
--   frozen spec's catalog price, both read from sku_catalog/received_devices
--   at correction time, per operator amendment 2 — also sets requires_review
--   when the difference exceeds 20%. Computed in application code; no
--   separate column needed beyond requires_review itself, though the
--   computed comparison figures are stored for the audit trail /
--   side-by-side display.)
--
-- reviewed_by_user_id/reviewed_at: set when an admin/manager clears a
-- requires_review=1 row (their own reason goes in a SEPARATE acknowledgement
-- concept, not implemented in this migration — see the app-layer design
-- note in src/lib/returnCorrections.ts for why review-clearing is modelled
-- as updating THIS row rather than a second append-only ack table: unlike
-- shipment_misdeclaration_acks' "does the current figure still match the
-- acknowledged one" lapse check, a correction row's identity fields never
-- change after insert (a NEW correction is a new row), so there is nothing
-- for a review-clearing ack to lapse against — an UPDATE of
-- reviewed_by_user_id/reviewed_at on the immutable identity row is safe.
--
-- (No explicit transaction wrapper: remote D1 rejects BEGIN/COMMIT
-- [CF 7500]; wrangler applies this file as a single batch.)

CREATE TABLE IF NOT EXISTS return_line_corrections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organisation_id INTEGER NOT NULL,
  shipment_line_id INTEGER NOT NULL,      -- the RETURN leg's shipment_lines.id (frozen row, untouched)
  received_device_id INTEGER NOT NULL,

  -- Full corrected-state SNAPSHOT (see header comment) — every field
  -- populated with the effective value after this correction, whether or
  -- not THIS particular correction changed it. NULL is only valid here to
  -- mean "the frozen export line also had NULL for this field" — never
  -- "no correction," since that ambiguity is exactly what snapshot
  -- semantics eliminates.
  corrected_imei TEXT NOT NULL,
  corrected_sku TEXT,
  corrected_brand TEXT,
  corrected_model TEXT,
  corrected_capacity TEXT,
  corrected_color TEXT,
  corrected_grade TEXT NOT NULL,
  -- Deliberately no corrected_unit_value / corrected_currency — see header.

  -- Generation-boundary detection (operator amendment 3).
  is_generation_boundary INTEGER NOT NULL DEFAULT 0,
  frozen_generation INTEGER,              -- parsed from the frozen export line's model, NULL if unparseable
  corrected_generation INTEGER,           -- parsed from corrected_model, NULL if unparseable
  generation_unparseable INTEGER NOT NULL DEFAULT 0,  -- 1 if EITHER side failed to parse

  -- Catalog-value-difference detection (operator amendment 2): both sides
  -- read from the catalog AT CORRECTION TIME, never from shipment_lines.unit_value.
  frozen_catalog_value_gbp REAL,          -- current catalog/avg value for the FROZEN (model,capacity,color,grade)
  corrected_catalog_value_gbp REAL,       -- current catalog/avg value for the CORRECTED (model,capacity,color,grade)
  catalog_value_diff_pct REAL,            -- (corrected - frozen) / frozen, as a fraction; NULL if either side unresolvable

  requires_review INTEGER NOT NULL DEFAULT 0,
  review_reason TEXT,                     -- WHY requires_review was set (generation_boundary | generation_unparseable | imei_change | catalog_value_diff | combination)
  reviewed_by_user_id INTEGER,
  reviewed_at DATETIME,
  review_note TEXT,

  reason TEXT,                            -- operator's free-text reason for the correction itself
  actor_user_id INTEGER NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,

  FOREIGN KEY (shipment_line_id) REFERENCES shipment_lines(id),
  FOREIGN KEY (received_device_id) REFERENCES received_devices(id),
  FOREIGN KEY (actor_user_id) REFERENCES users(id),
  FOREIGN KEY (reviewed_by_user_id) REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_return_line_corrections_line ON return_line_corrections(shipment_line_id);
CREATE INDEX IF NOT EXISTS idx_return_line_corrections_device ON return_line_corrections(received_device_id);
CREATE INDEX IF NOT EXISTS idx_return_line_corrections_review ON return_line_corrections(requires_review, reviewed_at);
CREATE INDEX IF NOT EXISTS idx_return_line_corrections_org ON return_line_corrections(organisation_id);

-- X-7 (Sprint 3, IMEI history chain) event type reserved now per operator
-- instruction, even though X-7 itself is not built: an IMEI correction
-- (corrected_imei != frozen exportLine.imei) fires device_events
-- event_type = 'RETURN_IMEI_CORRECTED' (in application code, not this
-- migration — device_events.event_type has no CHECK constraint, so no
-- schema change is needed to add a new value; this comment exists purely
-- so a future X-7 implementer knows the type name is already spoken for
-- and where it originates).
