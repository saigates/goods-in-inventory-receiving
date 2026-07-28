-- OPR 6: manual dispatch support. MUCR (Master Unique Consignment
-- Reference) — the consolidation reference the carrier/agent associates
-- with the export movement (e.g. GB/SGAT-12345678). Recorded alongside
-- MRN / DUCR / EAD as proof-of-export material; captured at finalise or
-- later via /export-proof.
ALTER TABLE shipments ADD COLUMN mucr TEXT;
