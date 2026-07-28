-- OPR 4: automation. Outbox of every email the system actually attempted
-- to send (pre-alert / clearance instruction). Rows are written only when
-- a real send was attempted (Gmail configured) — an unconfigured system
-- refuses with 503 and writes nothing, so this table is an honest audit
-- of attempts, not intentions.
CREATE TABLE IF NOT EXISTS sent_emails (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organisation_id INTEGER NOT NULL,
  shipment_id INTEGER NOT NULL,
  kind TEXT NOT NULL,                -- 'prealert' | 'clearance'
  to_email TEXT NOT NULL,
  subject TEXT NOT NULL,
  provider TEXT NOT NULL DEFAULT 'gmail',
  provider_message_id TEXT,          -- Gmail message id on success
  status TEXT NOT NULL,              -- 'sent' | 'failed'
  error TEXT,                        -- failure detail (never a secret)
  user_id INTEGER,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (shipment_id) REFERENCES shipments(id)
);

CREATE INDEX IF NOT EXISTS idx_sent_emails_shipment ON sent_emails(shipment_id);
CREATE INDEX IF NOT EXISTS idx_sent_emails_org ON sent_emails(organisation_id);
