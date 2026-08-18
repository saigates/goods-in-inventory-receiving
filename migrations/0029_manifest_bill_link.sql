-- Migration 0029: manifest → bill link (Sprint B §1 follow-up).
--
-- Manifests carry the itemisation, bills carry the header — this is
-- deliberately NOT a manifest-generates-bill-lines relationship. A bill's
-- own bill_lines/bill_line_serials keep resolving against received_devices
-- exactly as before (0028, unchanged); this column is purely an OPTIONAL
-- pointer from a manifest to the bill it was shipped against, so that
-- reconciliation (manifestBillReconciliation.ts) can compare the
-- manifest's summed unit costs against that bill's declared_total_gbp.
--
-- bill_id is NULLABLE and stays NULL for the (permitted, pre-existing)
-- case of goods received with no bill at all — this column must never
-- become a gate on receiving. ON DELETE SET NULL rather than CASCADE: a
-- bill being deleted must never take a manifest's itemisation with it.
ALTER TABLE manifests ADD COLUMN bill_id INTEGER REFERENCES bills(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_manifests_bill ON manifests(bill_id);
