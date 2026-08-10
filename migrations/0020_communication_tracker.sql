-- OPR — communication tracker (Ticket C): log sent + received FedEx/customs
-- correspondence against a shipment, flag overdue chases, and track the
-- per-return outstanding-items checklist.
--
-- SEND LOG: reuses the existing sent_emails outbox (0013) rather than a
-- parallel table — that table already carries exactly what's needed (date
-- via created_at, mailbox via to_email, one-line summary via subject, true
-- status via status 'sent'|'failed'|'manual') and already enforces the
-- honesty rule (a row is written only for a real attempt/explicit manual
-- confirmation, never a default). `kind` is unconstrained TEXT, so no
-- schema change is needed to add a third value: 'correspondence' — general
-- FedEx/customs messages that aren't the structured pre-alert/clearance
-- drafts (e.g. ad-hoc chases). See src/routes/opr.ts POST .../correspondence.
--
-- RECEIVED LOG: no prior infrastructure existed for this (confirmed by
-- search), so a new table is needed.
--
-- (No explicit transaction wrapper: remote D1 rejects BEGIN/COMMIT
-- [CF 7500]; wrangler applies this file as a single batch.)

CREATE TABLE IF NOT EXISTS shipment_replies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organisation_id INTEGER NOT NULL,
  shipment_id INTEGER NOT NULL,
  from_mailbox TEXT NOT NULL,
  summary TEXT NOT NULL,
  received_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  logged_by_user_id INTEGER,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (shipment_id) REFERENCES shipments(id)
);
CREATE INDEX IF NOT EXISTS idx_shipment_replies_shipment ON shipment_replies(shipment_id);
CREATE INDEX IF NOT EXISTS idx_shipment_replies_org ON shipment_replies(organisation_id);

-- Per-return outstanding-items checklist fields (import/re-import shipments).
-- VAT evidence is deliberately a free-text reference, NOT a PVA/C79 flag —
-- the agent has not yet confirmed which evidence type applies (Section D
-- point 4 of the outstanding-items list), so the schema must not assume one.
ALTER TABLE shipments ADD COLUMN customs_entry_ref TEXT;             -- C88 / CDS entry reference
ALTER TABLE shipments ADD COLUMN vat_evidence_ref TEXT;               -- generic VAT evidence reference/description
ALTER TABLE shipments ADD COLUMN repair_cost_confirmed_at DATETIME;
ALTER TABLE shipments ADD COLUMN repair_cost_confirmed_by_user_id INTEGER;
