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

## Coverage note (recorded per explicit user request, not a bug)

Grade `B` has **zero rows** in production (`COUNT(*) FROM expected_devices
WHERE grade='B'` = 0, confirmed in the raw cross-tab above — only A/C/UG
appear). Consequence: `deriveConditionFromGrade()`'s `B → USED` branch
(`src/lib/condition.ts`) is currently exercised **only by its unit test**,
never by live data. Not a defect — just a confidence/coverage fact worth
having on record before 0030 (which depends on that function) ships.

## Migration-mechanics investigation for the 0024–0029 deploy (this pass)

**Question**: does `gsk hosted deploy` apply migrations itself (so
schema-first ordering is guaranteed), or is that a separate manual step?

**Finding — re-test of `gsk hosted d1_query` under the confirmed project id
(d6aea290-...) FAILED again**, this time consistently across every read-only
`gsk hosted` probe tried:

```
d1_query      -> resource_not_found: "No D1 database deployed for project
                 d6aea290-...  Deploy with --with-db first."
d1_schema     -> resource_not_found: same message
worker_get    -> resource_not_found: "No worker deployed for project
                 d6aea290-...  Run `gsk hosted deploy` first to create one."
worker_stats  -> resource_not_found: "Stats only exist after a successful
                 deploy."
custom_domain_status -> resource_not_found: "No custom domain is bound..."
list          -> Found 1 hosted resource: the ff2edf75-... worker only
                 (confirmed NOT ours, per above) — zero resources under
                 d6aea290-...
```

This is a **stronger and different** failure than the earlier pass: last
time only D1 reads failed while production was independently confirmed
live. This time EVERY hosted-control-plane read for this project — worker,
D1, stats, custom domain — reports nothing provisioned at all, while an
independent plain HTTPS check in the same moment shows production is still
fully live and unchanged:

```
GET /api/health -> 200 {"ok":true,"ts":"2026-08-18T16:20:45.327Z"}
GET /tracker/   -> 200
```

Interpretation: the `gsk hosted` control plane currently cannot see ANY
resource for this project — not "the worker exists but D1 doesn't," but
"nothing is registered under this project id at all" from the control
plane's point of view — even though the actual Cloudflare Worker and its D1
data are demonstrably still serving real traffic. This looks like the same
class of session/control-plane visibility gap flagged earlier in this
deploy-check sequence, now worse (covering worker_get/stats/custom_domain
too, not just D1), not a new data-loss event — production traffic and data
are unaffected — but it means the safety rail this deploy explicitly
depends on (confirming `d1_query` works BEFORE trusting `gsk hosted deploy`
to sequence migrations correctly) cannot be exercised right now.

**Per explicit user instruction this pass ("if d1_query still returns
resource_not_found, hold — a worker-only deploy is worse than no deploy"):
this deploy is HELD.** No `gsk hosted deploy` call has been made. No
`--with-db`, `d1_rebuild`, or `d1_execute` call has been made either (all
three remain off-limits per standing instruction regardless of project
identification).

### Secondary findings from the same investigation (retained for when the
### control plane recovers and this is re-attempted)

- **No dedicated "apply migrations" subcommand exists.** `gsk hosted --help`
  lists exactly: `d1_query`, `d1_execute`, `d1_export`, `d1_import`,
  `d1_rebuild`, `d1_schema` for D1, plus worker/R2/secret/custom-domain
  commands. There is no `d1_migrate` / `migrations_apply`.
- **Circumstantial evidence that `gsk hosted deploy` bundles migration
  application into the same approved action** (not a separate step the
  agent must trigger):
  - The `gsk-hosted-deploy` skill documents a deploy action's result schema
    carrying `result.migration_status` (`applied`/`failed`/`seed_applied`/
    `seed_failed`), `result.migration_errors`, and `result.schema_verification`
    (`verified`/`incomplete`/`unavailable`) — fields that only make sense if
    migration application is something the deploy pipeline itself performs
    and reports on.
  - README.md's own deploy history (lines 456-458): "production is on
    commit `6cbe4e2` (deployed 2026-08-11 via an approved `gsk hosted
    deploy` action, 22/22 migrations applied...)" — describing ONE approved
    action that both shipped code and applied all pending migrations, not
    two separate approvals.
  - A second, earlier deploy entry (2026-07-29, lines 361-372) explicitly
    says the redeploy "also re-ran migration 0017 against prod D1 (wrangler
    applies any migration file not yet recorded as applied on that Worker's
    tracking table)" — again describing migration application as an
    automatic, built-in part of the same `gsk hosted deploy` invocation,
    keyed off a tracking table so already-applied migrations are skipped
    (idempotent), not something requiring a separate manual trigger.
  - There is no example anywhere in README's deploy history of a separate
    manual migration-apply step being run against production alongside a
    `gsk hosted deploy` action. Every recorded prod deploy either applied
    pending migrations automatically as part of the one approved action, or
    (the 197-IMEI-manifest-fix redeploy) explicitly noted "no migrations
    pending, so this was a code-only redeploy" — i.e. the deploy pipeline
    itself is what decides whether migrations run, based on what's pending.
  - **Not fully reconciled**: README also documents `npm run
    db:migrate:prod` (lines 294, 413) as a step in the LOCAL-DEV and BYOK
    (bring-your-own-Cloudflare-account) instructions — that script runs
    `wrangler d1 migrations apply webapp-production` directly against a
    user's OWN Cloudflare account, entirely outside the `gsk hosted deploy`
    pipeline. This is the alternate/legacy path for someone deploying to
    their own account (see the `cf-byok-deploy` skill), not evidence
    against automatic migration application under `gsk hosted deploy` —
    the two are different deploy mechanisms for two different account
    setups, not two steps of the same one. Conclusion: no contradiction,
    but this was inferential, not from one single unambiguous sentence
    naming the mechanism explicitly for the `gsk hosted deploy` path.
  - **Overall confidence**: schema-first ordering (migrations landing before
    the new worker version starts serving requests) is very likely achieved
    automatically by `gsk hosted deploy` for THIS deploy mechanism, based on
    the above — but this is inference from documented behavior and a result
    schema, not a single explicit guarantee statement, and it cannot be
    exercised live right now because the control plane read path is down
    for this project. Recommend treating this as "probably fine, but
    unverified for this specific attempt" rather than "confirmed safe."

## Migration content review — 0024, 0025, 0027, 0028, 0029 (this pass)

Read in full (0026 was already confirmed additive in the Check 2 pass).
None of the six drop or rewrite a column; all are additive:

- **0024** (`ce1154_worksheet_rewrite`): 15× `ALTER TABLE shipments ADD
  COLUMN` only (inbound_freight_gbp, non_eu_freight_share_gbp,
  export_freight_gbp, insurance_gbp, value_adjustment_gbp DEFAULT 1.31,
  commodity_code, duty_override_claimed NOT NULL DEFAULT 0,
  entry_accepted_at, entry_cleared_at, supplementary_units,
  entry_duty_base_gbp, entry_vat_base_gbp, entry_duty_gbp, entry_vat_gbp,
  declared_invoice_total_gbp, declared_piece_count,
  declared_gross_weight_kg, misdeclaration_ack_at,
  misdeclaration_ack_by_user_id). No DROP, no rewrite, no table recreate.
- **0025** (`misdeclaration_ack_and_value_adjustment_defaults`): 2×
  `CREATE TABLE IF NOT EXISTS` (shipment_misdeclaration_acks,
  value_adjustment_defaults) + indexes + one seed `INSERT`. Purely
  additive new tables.
- **0027** (`worksheet_input_provenance`): single `ALTER TABLE shipments
  ADD COLUMN worksheet_input_provenance TEXT`. Purely additive.
- **0028** (`bills_cost_ledger_freight`, Sprint B §1-§3 — this is the
  previously-unknown migration): 5× `CREATE TABLE IF NOT EXISTS` (bills,
  bill_close_overrides, bill_lines, bill_line_serials, cost_ledger,
  freight_invoices — 6 tables total) + indexes. No ALTER on any existing
  table. Purely additive new tables.
- **0029** (`manifest_bill_link`): single `ALTER TABLE manifests ADD
  COLUMN bill_id INTEGER REFERENCES bills(id) ON DELETE SET NULL` + one
  index. Purely additive, nullable, `ON DELETE SET NULL` (not CASCADE) so
  it cannot destructively cascade either.

**Confirmed: all of 0024-0029 (plus the already-checked 0026) are additive
only — every statement is `CREATE TABLE IF NOT EXISTS` or `ALTER TABLE ...
ADD COLUMN`. Zero `DROP COLUMN`, zero `DROP TABLE`, zero
recreate-and-copy-data pattern anywhere in the six files.** The user's
premise ("0024-0029 should all be additive, so rollback ought to be
bundle-only") is now independently confirmed true by direct inspection,
not assumed.

## Rollback plan (stated per user request, now with the additive-only
## confirmation above backing it)

- **Bundle rollback**: redeploy git commit `6cbe4e2` via `gsk hosted
  deploy` (that commit is what production is on today, positively
  confirmed above). Since all six pending migrations are additive-only,
  the OLD code at `6cbe4e2` continues to run correctly against a schema
  that has EXTRA (unused-by-it) columns/tables — additive schema changes
  are backward-compatible with older code by construction, so a
  bundle-only rollback is sufficient; there is no scenario among 0024-0029
  where old code would break against the new schema.
- **Data rollback**: the durable export at
  `/mnt/aidrive/prod-export-2026-08-18-pre-0029.sql` (md5-verified) is the
  fallback ONLY if something outside the migrations themselves corrupts
  data (e.g. a bad manual `d1_execute`, which is off-limits anyway) — not
  expected to be needed given the additive-only confirmation above. Using
  it would require `d1_rebuild` (drop+recreate) followed by `d1_import`,
  both destructive/approval-gated operations, and would lose any writes
  made to production between this export and the rebuild.
- **Net**: rollback should be bundle-only in the expected case. Data
  rollback is a documented but unlikely-to-be-needed fallback, gated
  behind operations already prohibited this pass unless the user
  explicitly authorizes them at that time.

## Current status: DEPLOY HELD

Per the user's explicit instruction, this deploy does not proceed while
`gsk hosted d1_query` (and, as newly found, every other hosted-control-plane
read for this project) returns `resource_not_found`. Nothing has been
applied. Next action is to re-test the control plane again before
attempting `gsk hosted deploy` for 0024-0029.
