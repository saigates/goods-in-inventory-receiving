-- Migration 0026: effective-dated OPR-export procedure-code / supervising-
-- office policy (Item C follow-up, Sprint A).
--
-- OPR export shipments (chargeable OP) must declare procedure code 2100 +
-- additional procedure code 000, and the supervising office is GBLIV002
-- (HMRC S1756 IP-OP Customs Liverpool). Decided 2026-08-16, triggered by
-- the next export booking — an external event we do not control, not a
-- historical correction. The real 10 July export and both real return
-- legs under export MRN 26GB7LKWO3QHFLCAA0 discharged correctly despite
-- predating this policy; there is nothing to reclaim and nothing to
-- amend on those shipments.
--
-- Same effective-dated-default-table mechanism as value_adjustment_defaults
-- (0025) — an effective-from row, resolved by the SHIPMENT'S OWN DATE
-- (ship_date, falling back to created_at — see loadExportProcedurePolicy
-- in routes/opr.ts), NEVER by "today". A future policy revision is a NEW
-- row with its own effective_from; a shipment's validation result must
-- not change over time while the record itself is unchanged — the same
-- determinism principle that keeps computeCe1154() pure and the golden
-- fixtures reproducible.
--
-- (No explicit transaction wrapper: remote D1 rejects BEGIN/COMMIT
-- [CF 7500]; wrangler applies this file as a single batch.)

CREATE TABLE IF NOT EXISTS export_procedure_policy_defaults (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organisation_id INTEGER NOT NULL,
  procedure_code TEXT NOT NULL,
  additional_procedure_code TEXT,
  supervising_office_name TEXT,
  supervising_office_code TEXT NOT NULL,
  effective_from DATE NOT NULL,
  note TEXT,
  created_by_user_id INTEGER,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_export_procedure_policy_org ON export_procedure_policy_defaults(organisation_id, effective_from);

-- effective_from = 2026-08-16: the date the policy was decided. It is
-- after every real shipment filed to date (10 July export + both return
-- legs) and after the 2026-07-01/2026-08-01 test fixtures that predate
-- it, so forward-only holds without any edit to those. It is on/before
-- the next real export booking, which is the point of adding this at all.
INSERT INTO export_procedure_policy_defaults
  (organisation_id, procedure_code, additional_procedure_code, supervising_office_name, supervising_office_code, effective_from, note)
VALUES
  (1, '2100', '000', 'HMRC S1756 IP-OP Customs Liverpool', 'GBLIV002', '2026-08-16',
   'Decided 2026-08-16, ahead of the next export booking. Forward-only: the real 10 July export and both real return legs under 26GB7LKWO3QHFLCAA0 predate this and are not retro-flagged.');
