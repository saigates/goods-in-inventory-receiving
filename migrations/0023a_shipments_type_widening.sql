-- Migration 0023a (REWRITE, 2026-08-19, Sprint G re-split; follow-up pass
-- 2026-08-20 for M1/M2/M6): shipments recreate — shipment_type CHECK
-- widened +1 value, authorisation_id / procedure_code relaxed to
-- nullable. FIRST in the new split ordering (previously LAST as 0023b) —
-- see "SPLIT ORDERING" below for why.
--
-- Split from the original monolithic 0023 (migrations/0023_temp_export_
-- standard_and_received_at.sql, left unmodified in place, never deployed)
-- per Sprint-E instruction: "a rewritten table-recreation migration is
-- its own reviewed unit." See 0023b's header for the full nine-table
-- audit and the ON DELETE-mode audit table (Sprint G, G1).
--
-- SPLIT ORDERING (Sprint G, G2 — reversed from the previous Sprint F
-- draft): shipments recreates FIRST, received_devices SECOND (0023b).
-- The naive alternative — received_devices strictly last, with
-- shipment_lines recreated twice (once here referencing the not-yet-
-- touched received_devices, once more in 0023b re-deriving from the
-- by-then-updated copy) — was built and empirically validated
-- (/tmp/f2-final-reorder, now cleaned up) but rejected: it doubles
-- shipment_lines' exposure window and copies its data twice for a table
-- that only needs reshaping once. Instead, shipment_lines is intentionally
-- left UNTOUCHED by this file — it keeps pointing at the current
-- (pre-widening) shipments table across this migration and into 0023b,
-- where it is recreated EXACTLY ONCE, after BOTH parents have settled
-- into their final names. Empirically validated end-to-end (Sprint G,
-- /tmp/g3-combined, now cleaned up): full 0023a→0023b→0023c sequence
-- against a seeded copy of all 9 originally-recreated tables plus every
-- one of the 6 received_devices children — zero row loss, clean
-- foreign_key_check, no leftover _old/_new tables.
--
-- This table's 4-child accounting (sent_emails, shipment_value_deltas,
-- shipment_replies, plus shipments' own self-referencing
-- related_export_shipment_id) was already correct in the original 0023
-- and is unchanged here — the only defect in the original monolith was
-- received_devices' undercounted child list (see 0023b's header).
--
-- One new shipment_type value added:
--   TEMP_EXPORT_STANDARD - the new non-customs consignment type. Existing
--                           'OPR_REPAIR' value and default unchanged.
-- authorisation_id and procedure_code are relaxed from NOT NULL to
-- nullable — required for TEMP_EXPORT_STANDARD shipments, which per the
-- standing "no customs machinery" instruction have no OPR authorisation
-- and no procedure code. OPR_REPAIR creation code (opr.ts) continues to
-- always supply both; this is a widening, not a removal, of guarantees
-- for the existing flow.
--
-- SELF-REFERENCING FK ORDERING (Sprint G follow-up, verified not assumed):
-- related_export_shipment_id references shipments_new(id) with no
-- explicit ON DELETE, enforced immediately (non-deferred). The
-- INSERT...SELECT below carries no ORDER BY, which raised the question of
-- whether a row referencing another row not yet inserted could trip the
-- FK mid-statement. Settled empirically this pass in three isolated
-- scratch tests (/tmp/g-selfref-test, /tmp/g-selfref-adversarial,
-- /tmp/g-selfref-negctrl(+2), all cleaned up): (1) a genuinely linked
-- forward pair (lower-id export, higher-id import referencing it)
-- succeeds; (2) the adversarial reverse case (lower-id row referencing a
-- higher-id row, seeded via insert-then-UPDATE) ALSO succeeds, with
-- correct data and a clean foreign_key_check; (3) a negative control
-- (genuinely dangling reference to a nonexistent id) correctly fails
-- loudly with SQLITE_CONSTRAINT_FOREIGNKEY, confirming enforcement in the
-- harness is real, not silently off. This is not domain luck — it is
-- documented SQLite behaviour: immediate (non-deferred) FK constraints
-- are evaluated at the CONCLUSION of the statement, not per intermediate
-- row, so a multi-row INSERT...SELECT can never trip on intra-statement
-- row ordering regardless of which row lands first. This guarantee is
-- PER-STATEMENT ONLY — it says nothing about the gaps BETWEEN statements
-- in this file's multi-statement DDL sequence, which is exactly why the
-- zero-exposure-window swap below is still the thing doing the real work.
--
-- ZERO-EXPOSURE-WINDOW SWAP: the old shipments table is renamed away and
-- the new one renamed into place as two ADJACENT statements (zero
-- statements where "shipments" resolves to nothing), matching 0023b's
-- pattern. shipments_old is deliberately NOT dropped by this file (the
-- TABLE survives — see "WHAT A FAILURE HERE LEAVES" below), but its
-- INDEXES are dropped immediately after the swap — see "INDEX-NAME
-- COLLISION" below.
--
-- INDEX-NAME COLLISION WITH THE DEFERRED shipments_old (Sprint G
-- follow-up, M2/M6): the RENAME above carries `shipments`' three named
-- indexes (idx_shipments_org, idx_shipments_auth, and the UNIQUE
-- idx_shipments_org_ref) to shipments_old along with the table, and index
-- names occupy one namespace per schema. Because shipments_old is not
-- dropped until 0023b, those three names stay claimed by shipments_old
-- for the rest of THIS file. The original version of this file recreated
-- those indexes with `CREATE INDEX IF NOT EXISTS` at the end, which found
-- the names already taken and SILENTLY NO-OPED — measured directly this
-- pass via a full 25-file sequence against a fresh scratch DB, querying
-- `pragma_index_list('shipments')` and `sqlite_master` after the full run
-- completed (not the SQL source text): 0 of 3 indexes existed on the
-- final `shipments` table, including the UNIQUE org/reference constraint,
-- with a clean foreign_key_check and zero errors throughout. This is the
-- same silent-loss class as the CASCADE-hazard finding (0023b's header) —
-- a test built to verify rows and FK consistency cannot see a missing
-- schema object — and it is more severe than an ordinary missing index:
-- losing idx_shipments_org_ref silently removes a uniqueness constraint
-- on (organisation_id, reference), and duplicates admitted from that
-- point on would make a later attempt to recreate the index fail.
--
-- The fix actually taken: drop the three indexes explicitly, immediately
-- after the swap, INSIDE this file (not by moving their CREATE INDEX
-- into 0023b after `DROP TABLE shipments_old`, which was considered and
-- rejected — that would open a CROSS-FILE window, surviving indefinitely
-- on a stalled non-atomic deploy, in which the live `shipments` table has
-- no uniqueness constraint on org/reference at all). Dropping the
-- indexes (not the table — shipments_old itself must still exist for
-- 0023b to repoint shipment_lines against) frees the names immediately.
-- The three CREATE INDEX statements are placed directly after the DROP
-- INDEX block (Sprint G follow-up, tightening pass), so the collision
-- window is the 3 DROP INDEX + 3 CREATE INDEX statements sitting
-- immediately adjacent — not "a single statement" as an earlier pass of
-- this note claimed, and not spread across the ~9 statements it spanned
-- before this reorder (the three child DROP TABLEs and three RENAMEs now
-- sit AFTER shipments' own indexes are already recreated, not between the
-- drop and the recreate). The three CREATE INDEX statements for shipments
-- itself omit IF NOT EXISTS: with the names freed immediately above, a
-- genuine collision at CREATE INDEX time can only mean something
-- upstream is structurally wrong, and should fail the migration loudly
-- rather than vanish a second time.
--
-- GUARD STRENGTH NOTE: this file's own foreign_key_check guard (below)
-- CANNOT detect that shipment_lines is still pointing at shipments_old at
-- the moment this file ends — that is legitimate and expected by design
-- (shipment_lines is untouched until 0023b), not a defect this guard is
-- failing to catch. A green run of 0023a in isolation is not proof the
-- shipments graph is fully settled; only the guard at the end of 0023b,
-- once shipment_lines has been repointed and both _old parents dropped,
-- carries that meaning. See migrations-review/README.md for the
-- corresponding note comparing the two guards' scope.
------------------------------------------------------------------
-- RE-RUN SAFETY PROLOGUE (Sprint G follow-up, generalizing 0023b's M1
-- fix to this file's identical exposure): on a real, non-atomic D1
-- deploy, a partial failure anywhere below this point could leave one or
-- more _new scratch tables, or the guard table, already created from the
-- failed attempt. Without dropping them first, a straight re-run of this
-- same file text would die immediately on "table already exists" for
-- whichever one survived, rather than actually retrying the work. This
-- prologue is a no-op on a genuine first run (nothing exists yet) and
-- discards any partially-copied data from a failed attempt otherwise.
-- It guarantees the PRE-SWAP portion of this file is re-runnable; it does
-- not, by itself, resolve every possible re-run state once the swap
-- statements below have already executed once (e.g. a retry after
-- `shipments` has already been renamed into place would re-read from the
-- now-already-final `shipments` table rather than the pre-widening one,
-- and would then fail on `shipments_old` already existing at the next
-- rename attempt). That residual gap is tied to the still-outstanding
-- production D1 atomicity question, not solved here, and is why the
-- non-atomic-worst-case posture (assume a failure needs investigation,
-- not an unattended blind re-run) remains the standing instruction for
-- this migration set until that question is answered.
------------------------------------------------------------------
DROP TABLE IF EXISTS shipments_new;
DROP TABLE IF EXISTS sent_emails_new;
DROP TABLE IF EXISTS shipment_value_deltas_new;
DROP TABLE IF EXISTS shipment_replies_new;
DROP TABLE IF EXISTS __fk_check_guard_0023a;

CREATE TABLE shipments_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organisation_id INTEGER NOT NULL REFERENCES organisations(id),
  reference TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('export','import')),
  shipment_type TEXT NOT NULL DEFAULT 'OPR_REPAIR'
    CHECK (shipment_type IN ('OPR_REPAIR','TEMP_EXPORT_STANDARD')),
  status TEXT NOT NULL DEFAULT 'DRAFT'
    CHECK (status IN ('DRAFT','FINALISED','CANCELLED')),
  authorisation_id INTEGER REFERENCES opr_authorisations(id),
  procedure_code TEXT,
  additional_procedure_code TEXT,
  consignee_name TEXT,
  consignee_address TEXT,
  carrier TEXT,
  carrier_account TEXT,
  incoterm TEXT,
  currency TEXT NOT NULL DEFAULT 'GBP',
  ship_date DATE,
  related_export_shipment_id INTEGER REFERENCES shipments_new(id),
  export_mrn TEXT,
  notes TEXT,
  created_by_user_id INTEGER,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME,
  ducr TEXT,
  ead_mrn TEXT,
  finalised_at DATETIME,
  finalised_by_user_id INTEGER,
  repair_cost REAL,
  repair_cost_currency TEXT,
  customs_exchange_rate REAL,
  duty_rate_pct REAL,
  import_mrn TEXT,
  mucr TEXT,
  reconciled_value_gbp REAL,
  customs_entry_ref TEXT,
  vat_evidence_ref TEXT,
  repair_cost_confirmed_at DATETIME,
  repair_cost_confirmed_by_user_id INTEGER
);

INSERT INTO shipments_new
  (id, organisation_id, reference, direction, shipment_type, status,
   authorisation_id, procedure_code, additional_procedure_code,
   consignee_name, consignee_address, carrier, carrier_account, incoterm,
   currency, ship_date, related_export_shipment_id, export_mrn, notes,
   created_by_user_id, created_at, updated_at,
   ducr, ead_mrn, finalised_at, finalised_by_user_id, repair_cost,
   repair_cost_currency, customs_exchange_rate, duty_rate_pct, import_mrn,
   mucr, reconciled_value_gbp, customs_entry_ref, vat_evidence_ref,
   repair_cost_confirmed_at, repair_cost_confirmed_by_user_id)
SELECT
  id, organisation_id, reference, direction, shipment_type, status,
  authorisation_id, procedure_code, additional_procedure_code,
  consignee_name, consignee_address, carrier, carrier_account, incoterm,
  currency, ship_date, related_export_shipment_id, export_mrn, notes,
  created_by_user_id, created_at, updated_at,
  ducr, ead_mrn, finalised_at, finalised_by_user_id, repair_cost,
  repair_cost_currency, customs_exchange_rate, duty_rate_pct, import_mrn,
  mucr, reconciled_value_gbp, customs_entry_ref, vat_evidence_ref,
  repair_cost_confirmed_at, repair_cost_confirmed_by_user_id
FROM shipments;

CREATE TABLE sent_emails_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organisation_id INTEGER NOT NULL,
  shipment_id INTEGER NOT NULL,
  kind TEXT NOT NULL,
  to_email TEXT NOT NULL,
  subject TEXT NOT NULL,
  provider TEXT NOT NULL DEFAULT 'gmail',
  provider_message_id TEXT,
  status TEXT NOT NULL,
  error TEXT,
  user_id INTEGER,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (shipment_id) REFERENCES shipments_new(id)
);
INSERT INTO sent_emails_new
  (id, organisation_id, shipment_id, kind, to_email, subject, provider, provider_message_id, status, error, user_id, created_at)
SELECT
  id, organisation_id, shipment_id, kind, to_email, subject, provider, provider_message_id, status, error, user_id, created_at
FROM sent_emails;

CREATE TABLE shipment_value_deltas_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organisation_id INTEGER NOT NULL,
  shipment_id INTEGER NOT NULL,
  old_value_gbp REAL NOT NULL,
  new_value_gbp REAL NOT NULL,
  difference_gbp REAL NOT NULL,
  note TEXT,
  user_id INTEGER,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (shipment_id) REFERENCES shipments_new(id)
);
INSERT INTO shipment_value_deltas_new
  (id, organisation_id, shipment_id, old_value_gbp, new_value_gbp, difference_gbp, note, user_id, created_at)
SELECT
  id, organisation_id, shipment_id, old_value_gbp, new_value_gbp, difference_gbp, note, user_id, created_at
FROM shipment_value_deltas;

CREATE TABLE shipment_replies_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organisation_id INTEGER NOT NULL,
  shipment_id INTEGER NOT NULL,
  from_mailbox TEXT NOT NULL,
  summary TEXT NOT NULL,
  received_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  logged_by_user_id INTEGER,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (shipment_id) REFERENCES shipments_new(id)
);
INSERT INTO shipment_replies_new
  (id, organisation_id, shipment_id, from_mailbox, summary, received_at, logged_by_user_id, created_at)
SELECT
  id, organisation_id, shipment_id, from_mailbox, summary, received_at, logged_by_user_id, created_at
FROM shipment_replies;

------------------------------------------------------------------
-- ZERO-EXPOSURE-WINDOW SWAP for shipments and its 3 children that are
-- NOT shared with received_devices (sent_emails, shipment_value_deltas,
-- shipment_replies). shipment_lines is DELIBERATELY excluded from this
-- swap — see the file header. Old parent renamed away and new parent
-- renamed into place as adjacent statements; shipments_old's TABLE is
-- left standing (not dropped) because shipment_lines' live FK clause
-- still reads (after this rename) "REFERENCES shipments_old(id)" and
-- dropping it now would trip that constraint. The table is dropped by
-- 0023b, once shipment_lines has been repointed at the final `shipments`
-- table. Its indexes, however, are dropped immediately below — see the
-- header's INDEX-NAME COLLISION note.
------------------------------------------------------------------
ALTER TABLE shipments     RENAME TO shipments_old;
ALTER TABLE shipments_new RENAME TO shipments;

DROP INDEX idx_shipments_org;
DROP INDEX idx_shipments_auth;
DROP INDEX idx_shipments_org_ref;

-- Recreated immediately, right after the DROP INDEX block above and BEFORE
-- the child DROP TABLE/RENAME statements below (Sprint G follow-up,
-- tightening M6): the names are freed by the three DROP INDEX statements
-- immediately above, so nothing prevents recreating them here rather than
-- after the three children are swapped. Moving these three statements up
-- (they used to sit after the children's RENAMEs) shrinks the window
-- during which `shipments` carries no uniqueness constraint on
-- (organisation_id, reference) from ~9 statements down to these 3
-- DROP INDEX / 3 CREATE INDEX statements being directly adjacent. See the
-- header's INDEX-NAME COLLISION note for the full rationale; this is a
-- pure reorder, no behavioural change — the data copy into shipments_new
-- (INSERT...SELECT, above) already completed long before any of this.
CREATE INDEX idx_shipments_org     ON shipments(organisation_id);
CREATE INDEX idx_shipments_auth    ON shipments(authorisation_id);
CREATE UNIQUE INDEX idx_shipments_org_ref ON shipments(organisation_id, reference);

DROP TABLE sent_emails;
DROP TABLE shipment_value_deltas;
DROP TABLE shipment_replies;

ALTER TABLE sent_emails_new           RENAME TO sent_emails;
ALTER TABLE shipment_value_deltas_new RENAME TO shipment_value_deltas;
ALTER TABLE shipment_replies_new      RENAME TO shipment_replies;

-- shipments_old (the TABLE) intentionally NOT dropped here — its indexes
-- are already gone, above. See header + 0023b for the table's own drop.

-- IF NOT EXISTS ASYMMETRY (deliberate, not an oversight): the three
-- shipments-family children below keep `CREATE INDEX IF NOT EXISTS`,
-- while `shipments`' own three indexes above do not. This is correct, not
-- inconsistent: sent_emails/shipment_value_deltas/shipment_replies are
-- fully DROP TABLEd (above), which unconditionally frees their old index
-- names outright — a subsequent collision there really would mean nothing
-- was dropped, so IF NOT EXISTS costs nothing and stays as a defensive
-- no-op. `shipments`, by contrast, is RENAMEd (not dropped) — its old
-- indexes only stop claiming the names because of the explicit DROP INDEX
-- block above, so a collision at its CREATE INDEX time is a genuine signal
-- that block didn't run as expected, and IF NOT EXISTS would silently mask
-- exactly that failure (see INDEX-NAME COLLISION note above). Do not
-- "fix" this asymmetry in either direction — it reflects the two
-- differing removal mechanisms (DROP TABLE vs. explicit DROP INDEX after
-- RENAME), not carelessness.
CREATE INDEX IF NOT EXISTS idx_sent_emails_shipment ON sent_emails(shipment_id);
CREATE INDEX IF NOT EXISTS idx_sent_emails_org      ON sent_emails(organisation_id);

CREATE INDEX IF NOT EXISTS idx_shipment_value_deltas_shipment ON shipment_value_deltas(shipment_id);
CREATE INDEX IF NOT EXISTS idx_shipment_value_deltas_org      ON shipment_value_deltas(organisation_id);

CREATE INDEX IF NOT EXISTS idx_shipment_replies_shipment ON shipment_replies(shipment_id);
CREATE INDEX IF NOT EXISTS idx_shipment_replies_org      ON shipment_replies(organisation_id);

-- NOTE: no idx_shipment_lines_* here — shipment_lines is untouched by
-- this file; its indexes are recreated once, in 0023b, alongside its
-- single recreation.

------------------------------------------------------------------
-- WHAT A FAILURE HERE LEAVES / DOES THE APP STILL FUNCTION (Sprint F/G
-- explicit ask). If any statement in this file fails on a real
-- (non-atomic) D1 deploy:
--   - Before the swap block: `shipments` is untouched, still the
--     pre-widening table. No app impact; the deploy needs a re-run once
--     the cause is fixed. d1_migrations correctly records 0023a as
--     not-applied. The prologue above makes this specific case (failure
--     anywhere before the swap) genuinely re-runnable by clearing any
--     half-created _new tables first.
--   - During/after the swap block but before this file's guard: the app
--     is DOWN for anything touching shipments (TEMP_EXPORT_STANDARD
--     shipment creation, OPR flows) — `shipments` and its 3 recreated
--     children are in one of a few well-defined intermediate states.
--     `shipment_lines` itself is NEVER broken by this file (it isn't
--     touched), so anything reading/writing shipment_lines directly by
--     id continues to work throughout. A retry attempted from this point
--     is NOT a simple blind re-run — see the prologue's closing note
--     above — and requires checking which side of the rename the
--     failure landed on before re-applying.
--   - shipments_old (the table) surviving past this file's end (by
--     design, until 0023b) is diagnosable, not a mystery: `SELECT name
--     FROM sqlite_master WHERE name = 'shipments_old'` after this file
--     should show the table if and only if 0023b has not yet completed.
--     If it is still present after the full 0023a+0023b+0023c batch is
--     supposed to have finished, that is itself the fault signal — 0023b
--     did not reach its final DROP TABLE shipments_old statement.
--     shipments_old's INDEXES, by contrast, are gone the moment this
--     file's DROP INDEX statements above succeed — their absence is not
--     a similar fault signal, it is the expected post-0023a state.
------------------------------------------------------------------
CREATE TABLE __fk_check_guard_0023a (ok INTEGER NOT NULL CHECK (ok = 1));
INSERT INTO __fk_check_guard_0023a (ok)
SELECT 0 FROM pragma_foreign_key_check() LIMIT 1;
DROP TABLE __fk_check_guard_0023a;
