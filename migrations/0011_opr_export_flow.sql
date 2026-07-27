-- OPR 2 — Export flow: finalisation/proof-of-export columns on shipments,
-- and the carrier pre-alert mailbox/cut-off as CONFIGURABLE DATA on the
-- authorisation (never inline in code).
--
-- (No explicit transaction wrapper: remote D1 rejects it [CF 7500];
-- wrangler applies each migration file as a single batch, which is the
-- supported atomicity.)

-- Proof of export, captured at/after finalisation. export_mrn already
-- exists from 0010; DUCR + EAD MRN complete the evidence set.
ALTER TABLE shipments ADD COLUMN ducr TEXT;
ALTER TABLE shipments ADD COLUMN ead_mrn TEXT;
ALTER TABLE shipments ADD COLUMN finalised_at DATETIME;
ALTER TABLE shipments ADD COLUMN finalised_by_user_id INTEGER;

-- Carrier customs pre-alert config lives on the authorisation record so it
-- can differ per authorisation/carrier without a code change.
ALTER TABLE opr_authorisations ADD COLUMN prealert_email TEXT;
ALTER TABLE opr_authorisations ADD COLUMN prealert_cutoff TEXT;
