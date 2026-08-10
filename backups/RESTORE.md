# D1 Local Backup — Restore Procedure

## Baseline snapshot

- **File**: `backups/d1-local-baseline-2026-08-10.sql`
- **Checksum**: see `backups/d1-local-baseline-2026-08-10.sql.sha256`
- **Taken**: 2026-08-10, immediately before the Device Lifecycle & Repair
  Operations workstream and the OPR Phase 0 regression-test work.
- **Source**: local `--local` D1 SQLite state at
  `.wrangler/state/v3/d1/miniflare-D1DatabaseObject/`, exported via
  `npx wrangler d1 export webapp-production --local --output=...`
- **Git baseline tag**: `baseline-pre-device-lifecycle-2026-08-10`
  → commit `0b76a8899b1ae373b6647851e88b6cec9770a7ed`
  ("Ticket C: communication tracker...")
- **Verified**: row counts in the dump (`shipments`=2, `users`=3,
  `received_devices`=1, `shipment_lines`=2, `device_events`=7) were
  cross-checked against a live `SELECT COUNT(*)` on the same local DB at
  export time and matched exactly.
- **Scope note**: this is the LOCAL sandbox D1 only. Production D1
  (`webapp-production`, remote) is untouched by this backup and by this
  entire workstream — no `--remote` flag has been used anywhere. The
  standing deploy-hold means production is not expected to diverge from
  commit `10f9544` regardless.

## To restore this snapshot (local sandbox only)

Only run this if local data needs to be rolled back — e.g. a migration
during the new workstream corrupts local state and you want to return to
the exact pre-workstream baseline.

```bash
cd /home/user/webapp

# 1. Stop the dev server first (avoid writing to the DB mid-restore)
pm2 delete webapp 2>/dev/null || true

# 2. Wipe the local D1 SQLite state (this ONLY affects --local dev data,
#    never production)
rm -rf .wrangler/state/v3/d1

# 3. Re-apply migrations up to the same point as the baseline
#    (0001 through 0020 — check backups/d1-local-baseline-2026-08-10.sql's
#    own d1_migrations rows if in doubt about exact migration set)
npx wrangler d1 migrations apply webapp-production --local

# 4. Import the baseline data over the freshly-migrated (empty) schema
npx wrangler d1 execute webapp-production --local \
  --file=backups/d1-local-baseline-2026-08-10.sql

# 5. Rebuild and restart
npm run build
pm2 start ecosystem.config.cjs

# 6. Sanity check row counts match this document's "Verified" section above
npx wrangler d1 execute webapp-production --local \
  --command="SELECT (SELECT COUNT(*) FROM shipments) AS shipments, (SELECT COUNT(*) FROM users) AS users, (SELECT COUNT(*) FROM received_devices) AS devices"
```

## To roll back code to the baseline commit

```bash
cd /home/user/webapp
git log --oneline -1 baseline-pre-device-lifecycle-2026-08-10   # confirm what it points to
git checkout baseline-pre-device-lifecycle-2026-08-10 -- .       # restore working tree only, OR
git reset --hard baseline-pre-device-lifecycle-2026-08-10        # full hard reset (destructive — confirm with user first)
```

`git reset --hard` is destructive to any uncommitted/committed work made
after the tag. Never run it without explicit user confirmation.

## Notes

- This backup captures schema (all `CREATE TABLE`/`CREATE INDEX`
  statements) and data (`INSERT` rows) for every table as of migration
  0020. It does NOT include `.wrangler` cache/session state — only actual
  D1 table content.
- Re-run `wrangler d1 export ... --local` again at any later checkpoint
  (e.g. after Phase 0 tests pass, before the first repair-workflow
  migration lands) to get an incremental restore point — do not rely on
  this single snapshot indefinitely as the workstream progresses.
