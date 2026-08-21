# Offline production-data checks (2026-08-21) — Luhn over 193 IMEIs + duplicate-open-repair_jobs

These are the two items explicitly carried forward from the G5 item 2
verification pass (raised after that pass was already ordered, deliberately
excluded from it, and requested to ride along with G5 item 3's scratch-DB
work instead of needing their own pass). Both are answered **offline**,
against MD5-pinned production exports already on disk from prior passes, in
throwaway `/tmp` SQLite scratch DBs — **no live D1 access, no gate
involvement, no writes anywhere**. This doc also records the standing method
note about that discipline (see final section).

## Standing method note: production-data questions get answered offline against the MD5-pinned export in a `/tmp` scratch DB

The live sweep endpoint that a production-data question would ideally use
ships in the still-held 0023-0029 migration batch (see
`.deploy-checks/pre-0029-export.md`) — so until that batch deploys, any
question about the actual state of production data is answered by loading
one of the two exports already retrieved and MD5-verified in prior passes
into a local SQLite file under `/tmp`, then querying it directly with
Python's stdlib `sqlite3`. This is strictly read-only against a disposable
local file — the export itself, on disk at
`/home/user/webapp/backups/prod_backup_2026-08-11_1707.sql` and
`/mnt/aidrive/prod-export-2026-08-18-pre-0029.sql`, is never modified, and
nothing here touches the shared local dev D1 (`.wrangler/state/v3/d1`) or
any live gate. The scratch `.db` files themselves are ephemeral and not
checked into the repo.

**Exports used, re-confirmed by hash before use (not re-fetched, not
assumed identical to a prior pass's memory of them):**

| Export | Path | MD5 | Rows loaded to confirm no truncation |
|---|---|---|---|
| 2026-08-11 (pre-migration-22 data, still current for `received_devices`/IMEIs) | `/home/user/webapp/backups/prod_backup_2026-08-11_1707.sql` | `64821f71b417e540640fbc1b1b4e3290` | `received_devices` = 193 (matches raw `grep -c "^INSERT INTO \"received_devices\""` on the source SQL file directly, independent of the SQLite load) |
| 2026-08-18 (later export, pre-0029) | `/mnt/aidrive/prod-export-2026-08-18-pre-0029.sql` | `88185e6e61014db4ed1be34074bd29e3` | `received_devices` = 398 (consistent with the already-reconciled 538/756 growth story from the prior pass — different table, same export, cross-checked here only as a load-sanity signal) |

Load method (both exports): `sqlite3.connect('/tmp/<scratch>.db')` then
`conn.executescript(open(<export>.sql).read())` — the export files are
plain `CREATE TABLE` + `INSERT INTO` statements (`gsk hosted d1_export`
format, confirmed by the `-- gsk hosted d1_export — schema + data` header
line), so this is a direct, lossless replay into a real SQLite engine, not
a hand-parse of the dump text. Row counts obtained via `SELECT COUNT(*)`
against the loaded DB were cross-checked against a raw `grep -c` on the
source `.sql` file for the 2026-08-11 export (193 == 193), giving the same
independent-comparison assurance used for the 538/756 reconciliation rather
than trusting the SQLite load alone.

## Check A: Luhn validation over the 193 production IMEIs

**Question**: of the 193 `received_devices` rows in the 2026-08-11 export,
do all IMEIs pass the GSMA Luhn (mod-10) checksum that
`src/lib/validate.ts`'s `luhnValid()` enforces at import time going
forward? This class of check has never been run against production data
before — importer-level Luhn validation (`validateImei()`,
`src/lib/validate.ts` lines 39-51) is enforced for **new** writes, but
nothing has ever swept the **existing** rows, which could predate that
validation or have entered through some other path.

**Method**: independent re-implementation of the checksum in Python
(deliberately not calling into the TypeScript source — an independent
re-derivation is the same discipline used for the 538/756 id-set
comparison), applied to all 193 `imei` values pulled from the scratch DB:

```python
def luhn_check(imei):
    if not imei.isdigit():
        return None
    digits = [int(d) for d in imei]
    checksum = 0
    for i, d in enumerate(reversed(digits)):
        if i % 2 == 1:
            d *= 2
            if d > 9:
                d -= 9
        checksum += d
    return checksum % 10 == 0
```

This is algorithmically identical to `luhnValid()` in
`src/lib/validate.ts` lines 21-33 (reverse the digit string, double every
second digit counting from the right, subtract 9 if the double exceeds 9,
sum, and require `sum % 10 === 0`) — verified by side-by-side reading of
both implementations, not merely assumed equivalent.

**Result**: **0 failures out of 193.** Every IMEI is exactly 15 numeric
digits (`non_numeric_count = 0`, `wrong_length_count = 0`) and every one
passes the Luhn checksum. No NULL, no non-numeric, no wrong-length, no
checksum-failing rows exist in this export.

**What this does and doesn't prove**: it proves the specific 193 IMEIs
present in this export are individually Luhn-valid. It does NOT prove
duplicate IMEIs are absent (a separate question, not asked here), and it
does not retroactively validate any row added to production after
2026-08-11 (the export's cutoff) — this is a point-in-time sweep of the
export in hand, not a live, continuously-running check. Given a clean
result, there is no remediation to schedule for this export; the value of
having actually run the check (rather than assuming clean data because the
importer validates going forward) is that it rules out a specific class of
legacy-data risk (pre-validation-era or non-standard-import-path rows)
that had never been measured.

## Check B: duplicate open `repair_jobs` per device — the production-data half of the `startRepair()` defect

**Question**: `startRepair()`'s known, already-logged defect
(`src/lib/repairWorkflow.ts` lines 71-79 — `public/tracker/index.html`
entry added 2026-08-20, status `Open`, explicitly not being fixed in this
pass or in G5 item 3) is an unguarded check-then-insert with no DB-level
uniqueness constraint, which COULD in theory let two concurrent
`POST /repair/start` calls both pass the SELECT and land two simultaneously
open (`status IN ('open','awaiting_qc')`) `repair_jobs` rows for the same
device. The code-level race is confirmed by reading; whether it has
actually **happened** in production is a data question, answered here.

**Method**: direct SQL against both scratch DBs —

```sql
SELECT device_id, COUNT(*) AS open_count
FROM repair_jobs
WHERE status IN ('open', 'awaiting_qc')
GROUP BY device_id
HAVING COUNT(*) > 1;
```

Run against BOTH exports (2026-08-11 and 2026-08-18), not just one, since
they're different points in time and a race that hadn't yet occurred by
08-11 could in principle have occurred by 08-18.

**Result**: `repair_jobs` contains **0 rows in both exports** (confirmed
two ways per export: `SELECT COUNT(*) FROM repair_jobs` after loading into
SQLite, AND a raw `grep -c "INSERT INTO repair_jobs"` / case-insensitive
grep against each source `.sql` file directly — the only match in either
file is the `d1_migrations` bookkeeping row recording that migration
`0022_repair_jobs_and_zoho_queue.sql` was applied on 2026-08-11, not any
actual `repair_jobs` data row). Since the table is empty in both exports,
the duplicate-open-job query trivially returns zero groups — **no
duplicate-open-job incident exists in either export**, not because the
defect can't happen, but because the in-house repair workflow evidently has
no rows in production as of either export's cutoff (consistent with
`docs/plan/device-lifecycle-slice1.md`'s stated status that this feature's
usage is still ramping, and with the tracker's own note that "Group D...
stock currently goes into Zoho by hand").

**What this does and doesn't prove**: it proves the defect has not yet
manifested as of 2026-08-18. It does NOT close the defect itself (still
`Open` in the tracker, still unfixed, still explicitly out of scope for G5
item 3 per instruction) — an empty table today is not evidence the race
can't occur once the in-house repair flow has real concurrent traffic. This
check simply answers "has it happened yet" (no) rather than "can it happen"
(yes, per the existing code-reading-based tracker entry, unchanged by this
result).

## Gates / discipline notes

- No live D1 access. No `wrangler d1 execute ... --production` calls of any
  kind. Both source `.sql` files were already on disk from prior,
  previously-verified passes (re-confirmed by MD5 here, not re-downloaded).
- No writes anywhere — this is a read-only sweep of two disposable, ephemeral
  `/tmp` SQLite files created from those exports for this check only.
- `tsc --noEmit` / vitest suite: not applicable — no source files touched by
  this doc's work.
- Scratch files (`/tmp/scratch_prod_export.db`, `/tmp/scratch_prod_export_0818.db`)
  are throwaway and not checked into the repo.
