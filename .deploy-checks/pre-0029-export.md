# Pre-0024–0029 deploy export (production, before this deploy)

- Date: 2026-08-18 (this pass, revised after control-plane visibility issue
  was resolved)
- Trigger: `gsk hosted d1_query` initially confirmed working (prior pass),
  then found to return `resource_not_found` again in a follow-up pass under
  this session's GSK_PROJECT_ID (d6aea290-...). Escalated rather than
  proceeding. User resolved it from their side (see below) — this was a
  control-plane / session-binding visibility gap, NOT data loss and NOT a
  wrong-target risk.

## Production identity — positively confirmed this pass

- **Production hostname**: https://d6aea290-bd61-4f82-aa8d-94378b9f2fec.vip.gensparksite.com
  (matches this session's own GSK_PROJECT_ID — confirmed via README.md).
- `GET /api/health` → `{"ok":true,"ts":"2026-08-18T15:2x:xx.xxxZ"}` (200) —
  our actual app, not a stray/unrelated worker.
- `GET /tracker/` → 200, serves "Goods In — Master Checklist" (our real
  tracker page, 88446 bytes).
- `GET /static/app.js` pulled and md5-compared against every git revision of
  public/static/app.js: **exact match to commit 5978311** (last commit to
  touch app.js before 6cbe4e2). No commit between 5978311 and 6cbe4e2 touches
  app.js, and no commit AFTER 6cbe4e2 matches (later commits — 278299b,
  a3add76, 9df135d, 44f6d4e, 8c71b2d, 7b3d590 — all touch app.js and none
  hash-match). This positively confirms production is running **6cbe4e2**,
  exactly as README.md's deploy history claims (deployed 2026-08-11).
- The `ff2edf75-4d0d-4beb-9330-ba7f69646d48.vip.gensparksite.com` worker
  surfaced by `gsk hosted list` under a DIFFERENT project id is CONFIRMED
  NOT OURS — user fetched its /api/health and got an HTML "Phone Repair
  Management System" login page (Tailwind login screen, quote/invoice print
  areas), not our JSON health shape. Unrelated project sharing account
  visibility. No mis-binding occurred; nothing to fix on our side.

## Export artifact — retrieved and independently verified this pass

- Download URL: https://www.genspark.ai/api/files/s/4aMkF1tG
  (file-wrapper URL — requires authenticated session; plain curl gets 403,
  DownloadFileWrapper tool succeeds. This is expected behavior, not evidence
  of a broken/fake artifact.)
- Retrieved via DownloadFileWrapper → /home/user/prod-export.sql (1,731,470
  bytes, 6147 lines).
- File terminates cleanly (`;\n`, no truncation).
- 24 `CREATE TABLE` statements, table names match expected schema
  (expected_devices, received_devices, shipments, shipment_lines, manifests,
  opr_authorisations, users, etc. — plus d1_migrations).
- 5,780 total `INSERT INTO` statements — matches the prior pass's reported
  record count exactly.
- Loaded into an in-memory sqlite3 DB (Python stdlib) and queried directly —
  not just grepped — to get real GROUP BY semantics.

## RAW, un-collapsed grade × condition cross-tab (the actual gate check for
## migration 0030, run properly this time — no UPPER() folding anywhere)

```
SELECT grade, condition, COUNT(*) FROM expected_devices GROUP BY grade, condition;

('A',  'REFURBISHED', 197)
('A',  'Refurbished', 218)
('C',  'Raw',          19)
('C',  'Used',         11)
('UG', 'Raw',           6)
('UG', 'UG',          296)
('UG', 'Used',          9)
sum: 756
```

This is the true seven-cell distribution, SQLite's default (case-sensitive,
BINARY-collation) GROUP BY — confirmed no grade value other than A/C/UG
exists in production (grade='B' count = 0), and confirmed 5 distinct raw
condition strings exist (REFURBISHED, Raw, Refurbished, UG, Used — i.e. the
'Refurbished'/'REFURBISHED' case split is real and exactly as documented in
src/lib/condition.ts's audit comment).

**This exactly matches migration 0030's audited baseline, cell for cell.**

## Resolved: the "30 vs 20 USED" open arithmetic question from the prior pass

Migration 0030's comment states post-migration USED should total 30. A naive
sum of rows currently LABELED 'Used' gives 11 (C/Used) + 9 (UG/Used) = 20 —
this was flagged as an unreconciled discrepancy.

Resolved by deriving from GRADE (not from today's condition label), which is
what deriveConditionFromGrade() / migration 0030 actually do:
  - USED  = COUNT(grade='C')  = 19 + 11 = 30  ✓ (grade B doesn't exist, 0 rows)
  - RAW   = COUNT(grade='UG') = 6 + 296 + 9  = 311 ✓
  - REFURBISHED = COUNT(grade='A') = 197 + 218 = 415 ✓
  - 415 + 30 + 311 = 756 ✓

The 9 rows currently labeled condition='Used' but graded 'UG' derive to RAW
post-migration (grade wins), not USED — that's the entire source of the
20-vs-30 gap. No data anomaly; migration 0030's stated totals are correct.

## Deploy scope for THIS deploy

Migrations 0024-0029 only. 0030 is explicitly HELD BACK per user instruction
(recreate-and-copy over 756 live expected_devices rows; deploy separately
once tooling has proven itself further). The raw cross-tab above IS the
gate check required immediately before 0030's eventual deploy — captured
now, to be re-verified fresh (not reused) immediately before that migration
actually runs, since production data may have changed in the interim.

## Durability — resolved this pass

- `/home/user/prod-export.sql` (sandbox, ephemeral) — md5 88185e6e61014db4ed1be34074bd29e3
- Copied to `/mnt/aidrive/prod-export-2026-08-18-pre-0029.sql` (user's own
  AI Drive, outside the sandbox lifecycle) — md5-verified byte-identical.
- This satisfies "confirm retrievable independently of the given URL, or
  copy it somewhere that outlives the session" — the actual export DATA now
  lives in a location the user controls directly, not just a link to it.
