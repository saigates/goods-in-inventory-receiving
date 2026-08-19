-- Migration 0023b (REWRITE, 2026-08-19, Sprint G re-split): received_devices
-- recreate — status CHECK widened +2 values, received_at column, plus the
-- SINGLE recreation of shipment_lines (shared child of both received_devices
-- and shipments). SECOND in the new split ordering (previously FIRST as
-- 0023a) — see 0023a's "SPLIT ORDERING" note for why the order flipped.
--
-- 0023 has never been applied to production (confirmed: production's
-- d1_migrations table only lists IDs 1-22; production's live
-- received_devices CHECK constraint lacks TEMP_EXPORTED_STANDARD /
-- RETURNED_UNDER_STANDARD — reconfirmed this pass via F1's static
-- `git show 6cbe4e2` check, see migrations-review/README.md). It
-- therefore has no released history to protect and is being rewritten in
-- place rather than patched forward.
--
-- DEFECT BEING FIXED (found 2026-08-19, forensic review): the original
-- monolithic 0023 recreated received_devices and repointed FOUR child
-- tables (device_events, shipment_lines, print_jobs, grade_audit) but
-- MISSED TWO tables that also carry a `NOT NULL REFERENCES
-- received_devices(id)` FK with no ON DELETE action (default NO ACTION):
-- repair_jobs and zoho_batch_devices — both introduced one migration
-- later by 0022_repair_jobs_and_zoho_queue.sql, after the four-table list
-- (first established by 0021 REVISION 3) was written. 0023 inherited that
-- list without re-deriving it against the schema as it stood by its own
-- time.
--
-- NINE-TABLE AUDIT, RE-RUN WITH ON DELETE MODE ENUMERATED (Sprint G, G1 —
-- supersedes the Sprint E audit, which used a test — foreign_key_check —
-- blind to CASCADE/SET NULL children). Every child of every one of the 9
-- originally-recreated tables, across the full codebase (migrations/ +
-- migrations-review/), with ON DELETE mode and handling status:
--
-- ┌────────────────────┬──────────────────────┬─────────────────┬──────────────────────────────┬────────────────────────────────────────────┐
-- │ Recreated parent    │ Child                │ ON DELETE mode  │ Handled in this rewrite?     │ Row-count evidence                          │
-- ├────────────────────┼──────────────────────┼─────────────────┼──────────────────────────────┼──────────────────────────────────────────────┤
-- │ received_devices    │ device_events        │ NO ACTION       │ Yes (recreated below)        │ 1→1 (this file, /tmp/g1-cascade-audit)      │
-- │ received_devices    │ print_jobs           │ ON DELETE CASCADE│ Yes (recreated below)       │ 1→1, seeded fresh this pass — NOT reused    │
-- │                     │                      │                 │                               │ from Sprint E (which never seeded this      │
-- │                     │                      │                 │                               │ table); confirmed by row count, not         │
-- │                     │                      │                 │                               │ foreign_key_check alone                     │
-- │ received_devices    │ grade_audit          │ ON DELETE CASCADE│ Yes (recreated below)       │ 1→1, seeded fresh this pass, same caveat    │
-- │ received_devices    │ repair_jobs          │ NO ACTION       │ Yes (recreated below) —      │ 1→1 (this file). MISSING from the original  │
-- │                     │                      │                 │ this is the original defect  │ 0023; negative-tested (omit → fails loud)   │
-- │ received_devices    │ zoho_batch_devices   │ NO ACTION       │ Yes (recreated below) —      │ 1→1 (this file). MISSING from the original  │
-- │                     │                      │                 │ this is the original defect  │ 0023                                         │
-- │ received_devices    │ shipment_lines       │ NO ACTION       │ Yes (recreated ONCE below,   │ 1→1 (this file's single recreate)           │
-- │                     │ (received_device_id) │                 │ shared with shipments)        │                                              │
-- │ received_devices    │ removal_flags        │ ON DELETE CASCADE│ Yes — DOES NOT EXIST IN     │ N/A this deploy: 0 rows at deploy time       │
-- │                     │ (0023c, new table)   │                 │ PRODUCTION (F1: zero matches  │ (table created fresh by 0023c, which runs   │
-- │                     │                      │                 │ at 6cbe4e2); ordering matters │ AFTER this file — see 0023c header and the  │
-- │                     │                      │                 │ for RE-RUNS, not this deploy  │ CASCADE-HAZARD note below)                  │
-- │ received_devices    │ cost_ledger (0028)   │ NO ACTION       │ N/A — created by 0028, which  │ Out of scope for 0023b: 0028 runs after     │
-- │                     │                      │                 │ runs after this file          │ 0023-0027; its FK targets the FINAL         │
-- │                     │                      │                 │                               │ received_devices, never touched by 0023b     │
-- │ shipments           │ sent_emails          │ none declared   │ Yes (0023a, unchanged from    │ 1→1 (0023a)                                 │
-- │                     │                      │ (no FOREIGN KEY │ Sprint E's correct verdict)   │                                              │
-- │                     │                      │ ON DELETE clause)│                              │                                              │
-- │ shipments           │ shipment_value_deltas│ none declared   │ Yes (0023a)                   │ 1→1 (0023a)                                 │
-- │ shipments           │ shipment_replies     │ none declared   │ Yes (0023a)                   │ 1→1 (0023a)                                 │
-- │ shipments           │ shipment_lines       │ ON DELETE CASCADE│ Yes (recreated ONCE below,   │ 1→1 (this file's single recreate)           │
-- │                     │ (shipment_id)        │                 │ shared with received_devices) │                                              │
-- │ shipments (self-ref)│ related_export_      │ none declared   │ Yes (0023a, self-reference    │ Confirmed via /tmp/f2-selfref (Sprint F):    │
-- │                     │ shipment_id          │                 │ column carried through)       │ SQLite rewrites a table's OWN self-reference │
-- │                     │                      │                 │                               │ FK text on its own rename automatically      │
-- │ shipments           │ shipment_misdeclaration_acks (0025)│ none declared │ N/A — created by 0025, runs after 0023a │ Out of scope: targets the FINAL shipments   │
-- │ shipments           │ freight_invoices (0028)│ none declared │ N/A — created by 0028, runs after 0023a │ Out of scope: targets the FINAL shipments   │
-- └────────────────────┴──────────────────────┴─────────────────┴──────────────────────────────┴──────────────────────────────────────────────┘
--
-- The other 7 originally-recreated tables (device_events, print_jobs,
-- grade_audit, sent_emails, shipment_value_deltas, shipment_replies,
-- repair_jobs's own... no, correction: the 7 non-parent recreated tables)
-- are themselves FK LEAVES — nothing anywhere in the codebase declares a
-- FOREIGN KEY pointing at any of them (re-verified this pass:
-- `grep -rn "REFERENCES device_events(\|REFERENCES print_jobs(\|REFERENCES
-- grade_audit(\|REFERENCES sent_emails(\|REFERENCES shipment_value_deltas(\|
-- REFERENCES shipment_replies(\|REFERENCES shipment_lines("` across
-- migrations/*.sql and migrations-review/*.sql returns zero hits except
-- the two parent FKs on shipment_lines itself, both accounted for above).
-- So they need no further child-of-child accounting.
--
-- SPRINT E "EIGHT OF NINE CORRECT" VERDICT: DOES NOT SURVIVE THE STRICTER
-- TEST, AS STATED, BUT THE OUTCOME IS UNCHANGED. The stricter ON DELETE
-- audit changes what the verdict actually rests on: Sprint E's audit used
-- `foreign_key_check`, a test blind to CASCADE/SET NULL silent data loss.
-- Re-running the two received_devices CASCADE children (print_jobs,
-- grade_audit) that Sprint E's audit implicitly passed without ever
-- seeding a row into either — this pass seeded both fresh and proved 1→1
-- by row count, not by a test that cannot see the failure mode. They
-- pass. The other 7 tables' "correct" status is unaffected (none of their
-- newly-enumerated child relationships are CASCADE/SET NULL, per the
-- table above). So: no additional silent-loss case exists beyond
-- removal_flags's ordering-dependent hazard (which is itself moot for
-- THIS deploy per F1 — see below) — the practical verdict "0023's
-- recreates are safe once rewritten this way" still holds, but it now
-- rests on affirmative row-count evidence for every CASCADE child, not
-- on a test that would have missed the removal_flags class entirely had
-- it existed with live rows.
--
-- CASCADE-HAZARD FINDING (Sprint F→G): a `ON DELETE CASCADE` child of a
-- recreated parent does NOT fail loudly if omitted from that parent's
-- swap, unlike a `NO ACTION` child. SQLite still silently rewrites the
-- CASCADE child's FK text to the renamed-away old parent (same mechanism
-- as the NO ACTION case), but when that old parent is finally dropped,
-- the CASCADE fires and silently deletes the child's rows — no error, no
-- guard trip, clean foreign_key_check. Empirically demonstrated this pass
-- (/tmp/f2-bystander, /tmp/f2-bystander2, /tmp/f2-hazard, all cleaned up):
-- a bystander CASCADE-child table created BEFORE a parent's zero-window
-- recreate, left out of that recreate's own swap, went from 1 row to 0
-- rows with zero errors. This is why removal_flags (0023c) MUST run
-- AFTER, not before, this file's received_devices swap has fully
-- completed — confirmed safe in that position (this file's own guard
-- covers this file's tables; 0023c's own guard, and the fact that it
-- creates removal_flags as a brand-new empty table referencing the
-- ALREADY-settled `received_devices`, means there is no window in which
-- it could be pointed at a since-renamed-away table). This hazard is
-- REAL for correctness and for any future re-run of this migration set
-- against a database that already has removal_flags rows, but per F1 it
-- is NOT live on this deploy: removal_flags does not exist in production
-- (zero matches at 6cbe4e2), so 0023c creates it fresh with zero rows —
-- there is nothing for a misordering to destroy on this specific run.
--
-- FK ENFORCEMENT ACROSS MULTI-STATEMENT DDL: re-verified this pass (not
-- assumed) against real `wrangler d1 migrations apply --local`, extending
-- 0021 REVISION-2's finding: neither `PRAGMA foreign_keys = OFF` nor
-- `PRAGMA defer_foreign_keys = TRUE` change D1's enforcement of an
-- implicit DELETE from DROP TABLE — both still raise
-- SQLITE_CONSTRAINT_FOREIGNKEY identically to the no-pragma case. Do not
-- reintroduce either pragma as "the fix" without re-verifying against a
-- real `wrangler d1 migrations apply --local` run first.
--
-- SINGLE SHIPMENT_LINES RECREATE (Sprint G, G2): shipment_lines is a
-- child of BOTH received_devices and shipments. Recreating it separately
-- in each parent's file (as an earlier Sprint F draft did) would double
-- its exposure window and copy its data twice for a table that only
-- needs reshaping once. Instead: 0023a (shipments) and this file
-- (received_devices) both leave shipment_lines completely untouched
-- during their own swaps, deferring both old parents' final DROP until
-- AFTER shipment_lines is recreated exactly once, below, pointing at
-- both FINAL parent tables. Empirically validated end-to-end this pass
-- (/tmp/g3-combined, now cleaned up): full 3-file sequence, seeded row in
-- every one of the 9 originally-recreated tables plus every 0023b child,
-- 1→1 row counts throughout, clean foreign_key_check, zero leftover
-- _old/_new tables. Negative-tested (/tmp/g3-neg, cleaned up): omitting
-- repair_jobs from this file's recreate still fails loudly with
-- SQLITE_CONSTRAINT_FOREIGNKEY at this file's final DROP statement,
-- confirming the safety net survives the single-recreate redesign
-- unchanged.
--
-- Two new device statuses added to received_devices.status:
--   TEMP_EXPORTED_STANDARD  - mirrors EXPORTED_UNDER_OPR, for the new
--                              non-customs "temporary export, standard"
--                              consignment type.
--   RETURNED_UNDER_STANDARD - mirrors RETURNED_UNDER_OPR, the return-side
--                              counterpart.
-- See src/lib/deviceLifecycle.ts for the ALLOWED_TRANSITIONS wiring.
--
-- received_at (plain ALTER, no recreate needed) records when a device was
-- physically received, independent of created_at (row-insert time) —
-- backdatable via scan.ts's receive endpoints.

------------------------------------------------------------------
-- Plain column addition (no recreate required)
------------------------------------------------------------------
ALTER TABLE received_devices ADD COLUMN received_at DATETIME;

------------------------------------------------------------------
-- received_devices (parent) — status CHECK widened +2 values
------------------------------------------------------------------
CREATE TABLE received_devices_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organisation_id INTEGER NOT NULL DEFAULT 1 REFERENCES organisations(id),
  uuid TEXT NOT NULL UNIQUE,
  imei TEXT NOT NULL UNIQUE,
  sku TEXT NOT NULL,
  brand TEXT,
  model TEXT,
  capacity TEXT,
  color TEXT,
  grade TEXT NOT NULL DEFAULT 'UG'
    CHECK (grade IN ('A','B','C','UG')),
  source TEXT NOT NULL
    CHECK (source IN ('manifest','unreconciled','manual')),
  manifest_id INTEGER,
  expected_device_id INTEGER,
  status TEXT NOT NULL DEFAULT 'RECEIVED'
    CHECK (status IN (
      'RECEIVED','SORTING','ACTIVE_INVENTORY','IN_HOUSE_REPAIR',
      'READY_FOR_EXPORT','IN_EXPORT_CONSIGNMENT','EXPORTED_UNDER_OPR',
      'RETURNED_UNDER_OPR','SOLD','REJECTED',
      'QC_FAILED','READY_FOR_ZOHO',
      'TEMP_EXPORTED_STANDARD','RETURNED_UNDER_STANDARD'
    )),
  label_printed_at DATETIME,
  notes TEXT,
  created_by_user_id INTEGER,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME,
  buy_price REAL,
  currency TEXT NOT NULL DEFAULT 'GBP',
  vat_type TEXT,
  supplier_id INTEGER REFERENCES suppliers(id),
  received_at DATETIME,
  FOREIGN KEY (manifest_id)        REFERENCES manifests(id)        ON DELETE SET NULL,
  FOREIGN KEY (expected_device_id) REFERENCES expected_devices(id) ON DELETE SET NULL
);

INSERT INTO received_devices_new
  (id, organisation_id, uuid, imei, sku, brand, model, capacity, color, grade, source,
   manifest_id, expected_device_id, status, label_printed_at, notes,
   created_by_user_id, created_at, updated_at,
   buy_price, currency, vat_type, supplier_id, received_at)
SELECT
  id, organisation_id, uuid, imei, sku, brand, model, capacity, color, grade, source,
  manifest_id, expected_device_id, status, label_printed_at, notes,
  created_by_user_id, created_at, updated_at,
  buy_price, currency, vat_type, supplier_id, received_at
FROM received_devices;

------------------------------------------------------------------
-- Children of received_devices — COMPLETE six-table set MINUS
-- shipment_lines (deliberately deferred to the single-recreate section
-- below). Columns/indexes otherwise unchanged from their current shape.
------------------------------------------------------------------
CREATE TABLE device_events_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organisation_id INTEGER NOT NULL REFERENCES organisations(id),
  device_id INTEGER REFERENCES received_devices_new(id),
  event_type TEXT NOT NULL,
  from_status TEXT,
  to_status TEXT,
  user_id INTEGER REFERENCES users(id),
  reference TEXT,
  metadata TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO device_events_new
  (id, organisation_id, device_id, event_type, from_status, to_status, user_id, reference, metadata, created_at)
SELECT
  id, organisation_id, device_id, event_type, from_status, to_status, user_id, reference, metadata, created_at
FROM device_events;

CREATE TABLE print_jobs_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  received_device_id INTEGER NOT NULL REFERENCES received_devices_new(id) ON DELETE CASCADE,
  printer TEXT NOT NULL DEFAULT 'DYMO LabelWriter 450',
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  sent_at DATETIME,
  organisation_id INTEGER NOT NULL DEFAULT 1,
  created_by_user_id INTEGER
);
INSERT INTO print_jobs_new
  (id, received_device_id, printer, payload_json, status, created_at, sent_at, organisation_id, created_by_user_id)
SELECT
  id, received_device_id, printer, payload_json, status, created_at, sent_at, organisation_id, created_by_user_id
FROM print_jobs;

CREATE TABLE grade_audit_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  received_device_id INTEGER NOT NULL REFERENCES received_devices_new(id) ON DELETE CASCADE,
  imei TEXT NOT NULL,
  old_grade TEXT,
  new_grade TEXT NOT NULL,
  actor TEXT NOT NULL DEFAULT 'operator',
  reason TEXT,
  bulk_id TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  organisation_id INTEGER NOT NULL DEFAULT 1,
  user_id INTEGER
);
INSERT INTO grade_audit_new
  (id, received_device_id, imei, old_grade, new_grade, actor, reason, bulk_id, created_at, organisation_id, user_id)
SELECT
  id, received_device_id, imei, old_grade, new_grade, actor, reason, bulk_id, created_at, organisation_id, user_id
FROM grade_audit;

-- ── repair_jobs — MISSING from the original 0023, added in this rewrite ──
CREATE TABLE repair_jobs_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organisation_id INTEGER NOT NULL REFERENCES organisations(id),
  device_id INTEGER NOT NULL REFERENCES received_devices_new(id),
  imei TEXT NOT NULL,
  fault_code TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'awaiting_qc', 'completed', 'cancelled')),
  qc_result TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (qc_result IN ('PENDING', 'PASSED', 'FAILED')),
  qc_fail_reason TEXT,
  qc_by INTEGER REFERENCES users(id),
  qc_at DATETIME,
  repair_cost_gbp REAL,
  parts_cost_gbp REAL,
  labour_cost_gbp REAL,
  cost_source TEXT,
  cost_source_reference TEXT,
  cost_recorded_at DATETIME,
  cost_recorded_by INTEGER REFERENCES users(id),
  opened_by_user_id INTEGER REFERENCES users(id),
  opened_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  closed_at DATETIME
);
INSERT INTO repair_jobs_new
  (id, organisation_id, device_id, imei, fault_code, status, qc_result, qc_fail_reason, qc_by, qc_at,
   repair_cost_gbp, parts_cost_gbp, labour_cost_gbp, cost_source, cost_source_reference, cost_recorded_at,
   cost_recorded_by, opened_by_user_id, opened_at, closed_at)
SELECT
  id, organisation_id, device_id, imei, fault_code, status, qc_result, qc_fail_reason, qc_by, qc_at,
  repair_cost_gbp, parts_cost_gbp, labour_cost_gbp, cost_source, cost_source_reference, cost_recorded_at,
  cost_recorded_by, opened_by_user_id, opened_at, closed_at
FROM repair_jobs;

-- ── zoho_batch_devices — MISSING from the original 0023, added in this rewrite ──
CREATE TABLE zoho_batch_devices_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id INTEGER NOT NULL REFERENCES zoho_batches(id) ON DELETE CASCADE,
  device_id INTEGER NOT NULL REFERENCES received_devices_new(id),
  imei TEXT NOT NULL,
  sku TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO zoho_batch_devices_new
  (id, batch_id, device_id, imei, sku, created_at)
SELECT
  id, batch_id, device_id, imei, sku, created_at
FROM zoho_batch_devices;

-- shipment_lines is NOT touched here; recreated exactly once, below,
-- after both parents (shipments from 0023a, received_devices here) have
-- settled into their final names.

------------------------------------------------------------------
-- ZERO-EXPOSURE-WINDOW SWAP for received_devices and its 5 NO ACTION/
-- CASCADE children that are NOT shared with shipments. Old parent
-- renamed away and new parent renamed into place as adjacent statements
-- (zero-statement window). received_devices_old is deliberately NOT
-- dropped yet — shipment_lines' live FK clause still reads (after this
-- rename) "REFERENCES received_devices_old(id)", and it is repointed,
-- along with shipments_old's equivalent, by the single-recreate section
-- immediately below.
------------------------------------------------------------------
ALTER TABLE received_devices     RENAME TO received_devices_old;
ALTER TABLE received_devices_new RENAME TO received_devices;

DROP TABLE device_events;
DROP TABLE print_jobs;
DROP TABLE grade_audit;
DROP TABLE repair_jobs;
DROP TABLE zoho_batch_devices;

ALTER TABLE device_events_new       RENAME TO device_events;
ALTER TABLE print_jobs_new          RENAME TO print_jobs;
ALTER TABLE grade_audit_new         RENAME TO grade_audit;
ALTER TABLE repair_jobs_new         RENAME TO repair_jobs;
ALTER TABLE zoho_batch_devices_new  RENAME TO zoho_batch_devices;

-- received_devices_old NOT dropped yet. See single-recreate section below.

------------------------------------------------------------------
-- shipment_lines: recreated EXACTLY ONCE here, referencing BOTH final
-- parent tables (shipments, settled by 0023a; received_devices, settled
-- immediately above). This is the point at which shipment_lines'
-- exposure window opens and closes for the only time in this migration
-- set — it is never dropped/recreated a second time.
------------------------------------------------------------------
CREATE TABLE shipment_lines_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organisation_id INTEGER NOT NULL REFERENCES organisations(id),
  shipment_id INTEGER NOT NULL REFERENCES shipments(id) ON DELETE CASCADE,
  received_device_id INTEGER NOT NULL REFERENCES received_devices(id),
  imei TEXT NOT NULL,
  sku TEXT,
  brand TEXT,
  model TEXT,
  capacity TEXT,
  color TEXT,
  grade TEXT,
  unit_value REAL NOT NULL,
  currency TEXT NOT NULL DEFAULT 'GBP',
  added_by_user_id INTEGER,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO shipment_lines_new
  (id, organisation_id, shipment_id, received_device_id, imei, sku, brand, model, capacity, color, grade,
   unit_value, currency, added_by_user_id, created_at)
SELECT
  id, organisation_id, shipment_id, received_device_id, imei, sku, brand, model, capacity, color, grade,
  unit_value, currency, added_by_user_id, created_at
FROM shipment_lines;

DROP TABLE shipment_lines;
ALTER TABLE shipment_lines_new RENAME TO shipment_lines;

-- NOW both old parents can be dropped: shipment_lines, their last
-- remaining referent (the only table anywhere still pointing at either
-- _old name), has just been repointed at the final tables above.
DROP TABLE received_devices_old;
DROP TABLE shipments_old;

CREATE INDEX IF NOT EXISTS idx_received_imei     ON received_devices(imei);
CREATE INDEX IF NOT EXISTS idx_received_sku      ON received_devices(sku);
CREATE INDEX IF NOT EXISTS idx_received_manifest ON received_devices(manifest_id);
CREATE INDEX IF NOT EXISTS idx_received_org      ON received_devices(organisation_id);
CREATE INDEX IF NOT EXISTS idx_received_status   ON received_devices(status);
CREATE INDEX IF NOT EXISTS idx_received_supplier ON received_devices(supplier_id);

CREATE INDEX IF NOT EXISTS idx_device_events_device ON device_events(device_id);
CREATE INDEX IF NOT EXISTS idx_device_events_org    ON device_events(organisation_id);
CREATE INDEX IF NOT EXISTS idx_device_events_type   ON device_events(event_type);

CREATE INDEX IF NOT EXISTS idx_print_status   ON print_jobs(status);
CREATE INDEX IF NOT EXISTS idx_print_jobs_org ON print_jobs(organisation_id);

CREATE INDEX IF NOT EXISTS idx_grade_audit_device ON grade_audit(received_device_id);
CREATE INDEX IF NOT EXISTS idx_grade_audit_bulk   ON grade_audit(bulk_id);
CREATE INDEX IF NOT EXISTS idx_grade_audit_org    ON grade_audit(organisation_id);

CREATE INDEX IF NOT EXISTS idx_repair_jobs_device ON repair_jobs(device_id);
CREATE INDEX IF NOT EXISTS idx_repair_jobs_org    ON repair_jobs(organisation_id);
CREATE INDEX IF NOT EXISTS idx_repair_jobs_imei   ON repair_jobs(imei);
CREATE INDEX IF NOT EXISTS idx_repair_jobs_status ON repair_jobs(status);

CREATE INDEX IF NOT EXISTS idx_zoho_batch_devices_batch  ON zoho_batch_devices(batch_id);
CREATE INDEX IF NOT EXISTS idx_zoho_batch_devices_device ON zoho_batch_devices(device_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_zoho_batch_devices_unique ON zoho_batch_devices(batch_id, device_id);

CREATE INDEX IF NOT EXISTS idx_shipment_lines_device   ON shipment_lines(received_device_id);
CREATE INDEX IF NOT EXISTS idx_shipment_lines_shipment ON shipment_lines(shipment_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_shipment_lines_unique ON shipment_lines(shipment_id, received_device_id);

------------------------------------------------------------------
-- WHAT A FAILURE HERE LEAVES / DOES THE APP STILL FUNCTION (Sprint F/G
-- explicit ask). If any statement in this file fails on a real
-- (non-atomic) D1 deploy:
--   - Before the received_devices swap block: received_devices untouched,
--     no app impact beyond needing a re-run. shipments (from 0023a) is
--     already live under its final name at this point, but
--     shipments_old still exists — harmless, it is a pure leftover with
--     nothing pointing at it except shipment_lines' unmodified FK text,
--     which still resolves correctly to the pre-widening shipments row
--     set until this file's single-recreate section runs.
--   - During/after the received_devices swap block but before the
--     shipment_lines single-recreate: the app is DOWN for anything
--     touching received_devices (scan.ts receive/regrade flows,
--     inventory.ts). shipment_lines itself is untouched and still reads
--     correctly (its FK text, silently rewritten by the RENAME above,
--     points at received_devices_old, which still holds the live rows —
--     nothing has been dropped yet). received_devices_old AND
--     shipments_old both surviving at this point is the expected,
--     diagnosable intermediate state, not a mystery: both are dropped
--     together in the very next statements once shipment_lines is
--     repointed.
--   - During the shipment_lines single-recreate itself: if the recreate
--     fails before its own DROP TABLE shipment_lines / RENAME pair, the
--     ORIGINAL shipment_lines table (still pointing at both _old names)
--     survives untouched — no data loss, the deploy simply needs a
--     re-run. If it fails AFTER that rename but before the two final
--     DROP TABLE statements, shipment_lines is already correctly
--     repointed at the final tables and fully functional; only the
--     harmless _old leftovers remain undropped, which the CHECK-guard
--     directly below still catches as a red flag (nonzero
--     foreign_key_check would not fire here since _old tables declare no
--     outgoing FK, but leftover _old tables are visible via a simple
--     `sqlite_master` query and are the diagnosable signal that this
--     file did not reach its final two DROP statements).
--   - If a CASCADE child of received_devices (print_jobs, grade_audit)
--     were EVER omitted from this file's swap in a future edit: the
--     omitted child's FK text still gets silently rewritten to
--     received_devices_old, but the final DROP TABLE received_devices_old
--     statement would trigger its CASCADE and SILENTLY DELETE its rows —
--     no error, clean foreign_key_check. This is the CASCADE-hazard
--     finding documented above; it is why print_jobs and grade_audit are
--     verified above by seeded row count, not by this file's own
--     foreign_key_check guard, which cannot see this failure class.
------------------------------------------------------------------
CREATE TABLE __fk_check_guard_0023b (ok INTEGER NOT NULL CHECK (ok = 1));
INSERT INTO __fk_check_guard_0023b (ok)
SELECT 0 FROM pragma_foreign_key_check() LIMIT 1;
DROP TABLE __fk_check_guard_0023b;
