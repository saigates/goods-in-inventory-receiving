# G5 item 2 — catalogue grade-variant gap sweep

**Dated snapshot, not live**: computed 2026-08-21 against
`backups/prod_backup_2026-08-11_1707.sql` (a 2026-08-11 production
export, 10 days old as of this write-up) — the SAME dataset migration
0031's own header used for its collision-freedom verification. This is
**not** a live read of production; re-run against a fresh export before
relying on these numbers for anything beyond scoping this item's work.

Method: parsed the dump's `INSERT INTO "sku_catalog"` / `"expected_devices"`
/ `"received_devices"` statements directly in Python (no D1 reload —
loading the full dump into a scratch D1 hit FK-ordering errors, consistent
with the multiple `prod_restore_*.sql` retry files already in `backups/`
from an earlier session's struggle with the same ordering problem; parsing
the INSERT statements directly sidesteps that entirely and reads the exact
same source bytes). Row counts cross-checked against `grep -c` on the raw
file and matched exactly (2781 / 538 / 193).

**Independence caveat for the `grep -c` cross-check**: this cross-check is
only genuinely independent of the Python parser if the dump emits one
`INSERT` statement per row (not a multi-row `VALUES (...),(...),(...)`
tuple, which `grep -c '^INSERT INTO'` would undercount against a
per-row parse). Confirmed true for this dump by direct line sampling —
`grep -n '^INSERT INTO "expected_devices"' backups/prod_backup_2026-08-11_1707.sql | head -1`
and `| tail -1` both show a single `VALUES (id, ...)` tuple per line, not
a batched multi-row statement. With that confirmed, the `grep -c` match
is a real independent check, not two methods sharing an unstated
assumption.

## Catalogue-side figure (a `sku_catalog`-only fact)

- 702 distinct (organisation_id, brand, model, capacity, color) configs.
- 2,781 total rows.
- 702 × 4 = 2,808 expected if fully populated; actual 2,781; difference 27.
- **9 configs are under-populated, all carrying only a single `UG` row
  (0 of the other 3 grades exist for any of them) — 27 missing rows
  total.** Exact list:

  | Brand | Model | Capacity | Color | Grades present |
  |---|---|---|---|---|
  | SAMSUNG | GALAXY S20 FE | 128GB | CLOUD NAVY | UG |
  | SAMSUNG | GALAXY S21 | 256GB | PHANTOM GRAY | UG |
  | SAMSUNG | GALAXY S23 FE | 256GB | GRAPHITE | UG |
  | SAMSUNG | GALAXY S24 | 256GB | PHANTOM BLACK | UG |
  | SAMSUNG | GALAXY S24 | 512GB | PHANTOM BLACK | UG |
  | SAMSUNG | GALAXY S24 FE | 256GB | GRAPHITE | UG |
  | SAMSUNG | GALAXY Z FLIP5 | 256GB | GRAPHITE | UG |
  | SAMSUNG | GALAXY Z FLIP5 | 512GB | GRAPHITE | UG |
  | SAMSUNG | GALAXY Z FOLD5 | 256GB | PHANTOM BLACK | UG |

  **Casing note, corrected 2026-08-21**: `color` values above are shown
  exactly as stored in `sku_catalog` (upper-case), not the mixed-case form
  an earlier draft of this table used (e.g. "Phantom Black"). The mismatch
  was caught during the Phase 2 offline rehearsal
  (`.deploy-checks/g5-phase2-offline-half.md`) when a lookup using the
  mixed-case literals returned a false "config not found" result for all
  9 rows — SQLite (and D1) string equality is case-sensitive, so copying
  the mixed-case literal into a query without `UPPER()` silently fails to
  match. Corrected here so a future reader copying this table's literals
  directly gets a correct match rather than repeating that mistake without
  the suspicion that caught it the first time.

This matches the pre-registered expectation exactly (9 configs / 27 rows).

**DECAYING FIGURE, noted 2026-08-21 alongside the Decision 2 correction
below**: this 9-configs/27-rows count is a **point-in-time measurement
of this snapshot, not a stable target**, precisely because the
correction below shows the route self-heals these configs. Any A/B/C
device received on one of these 9 models fills that config's remaining
rows in the same call, so the true count can only ever fall from here —
it will decay toward 0 as ordinary receiving happens post-deploy, not
stay pinned at 9/27 for future sweeps to reconcile against. A future run
finding fewer than 9 configs (or fewer than 27 rows) is expected
organic drift, not a discrepancy to root-cause against this figure.

**Decision 2 consequence (accepted wording)**: because the route's mixed
case (requested grade exists, sibling grades missing) REFUSES rather than
gap-fills (`{error, existing}`, per `src/routes/catalog.ts`'s `POST /`
decision-2 comment), the auto-generation route will **never self-heal**
these 9 UG-only configurations on its own — a `POST /api/catalog` naming
one of them (e.g. requesting grade A for `GALAXY S24 FE / 256GB /
GRAPHITE`) does not create the missing A/B/C rows; it simply returns
`{error, existing}` because a row already exists for that config (the UG
row) under Decision 2's mixed-case refusal. The 27 missing rows therefore
remain reachable only through a separate, still-unapproved bulk
remediation — auto-generation on the happy path (brand-new config, zero
existing rows) is a different case from these 9 and does not touch them.

**CORRECTION (2026-08-21) — the worked example above is wrong; checked,
not assumed.** `POST /api/catalog` requesting grade A for `GALAXY S24 FE
/ 256GB / GRAPHITE` (or any of the other 8 UG-only configs) does **not**
hit Decision 2's refusal and does **not** return `{error, existing}` —
it self-heals. Root cause: Decision 2's guard
(`existingMatch.status === 'match'`, `src/routes/catalog.ts` line 290)
only fires when a row matches on `model+capacity+color+`**`grade`**
together, and `resolveCatalogSku()`'s exact-match step
(`src/lib/catalog.ts` lines 206-217) requires the same four-way match
including the REQUESTED grade — so it returns `match` only when
re-requesting a grade that already has its own row (e.g. re-requesting
`UG` on one of these 9 configs), not when requesting a genuinely
missing grade. When the requested grade is missing, `existingMatch`
comes back `no_match`, the guard does not fire, and the loop at
`src/routes/catalog.ts` lines 306-340 computes `missingGrades` across
**all four** `VALID_GRADES` for that config (not just the requested
one) and inserts every missing row — the requested grade lands in
`row`, the rest in `generated_siblings`. Verified empirically, not just
by re-reading the code: a throwaway scratch spec seeded a fresh
UG-only config directly via SQL, then `POST /api/catalog` requesting
grade A returned `200 { ok:true, row:{ grade:"A", ... },
generated_siblings:[{grade:"B"},{grade:"C"}] }` against the real Hono
app + D1 (deleted immediately after use, per this project's scratch-file
discipline — never committed).

**Corrected consequence for the 9 UG-only configs**: any bench receive
of an A/B/C-graded device on one of them will self-heal that config's
remaining two missing rows in the same call, via the existing "Add to
catalogue & receive" button on the no-match red-banner path — no
separate bulk remediation is required to unblock the bench for that
case. Re-scanning a UG-graded device on the same 9 configs was never a
gap (the UG row already exists, so the ordinary `/scan` match succeeds
without touching this route at all). The still-unapproved 27-row bulk
remediation therefore becomes optional pre-emptive tidying, not a
bench-blocking prerequisite — see the tracker correction entry and the
User Guide note this correction prompted for the operator-facing
wording.

## Device-side ("bench-impact") figure — SEPARATE, do not substitute for the above

Per spec: devices whose own grade has no corresponding variant row on
their configuration — concretely, any device on one of the 9
under-populated configs above carrying grade A, B, or C (no catalogue row
exists for that grade+config, so it would hard-stop at receive/bench);
any UG-graded device on those same 9 configs is fine (a UG row does
exist).

Joined against both device tables in this snapshot:

- `received_devices`: **0 of 193** rows checked matched (all 193 rows
  independently confirmed present via `grep -c` before the join was
  computed — this is not a bare zero over an unconfirmed or possibly
  empty table).
- `expected_devices`: **0 of 538** rows checked matched (all 538 rows
  independently confirmed present via `grep -c` before the join was
  computed, same discipline).

Checked for a normalisation-mismatch false negative before accepting this
as a real zero: none of the 9 under-populated models (GALAXY S20 FE, S21,
S23 FE, S24, S24 FE, Z FLIP5, Z FOLD5) appear AT ALL in either device
table's model column in this snapshot, under any capacity/color
combination — so the zero is not an artifact of a capacity/color format
mismatch between `sku_catalog` and the device tables (which do differ:
device tables use `1024GB` where the catalogue uses the folded `1TB`
form, but that's irrelevant here since these 7 models don't appear in the
device tables at all in this snapshot).

**Conclusion, dated to this snapshot**: the 27-row catalogue-side gap
currently has **zero** real bench impact — no device in this 10-day-old
export would hard-stop against it. This does not mean the gap is safe to
leave unaddressed indefinitely (a future shipment of any of these 9
models in a non-UG grade would hard-stop immediately), only that fixing
it is not blocking any device sitting in the pipeline as of 2026-08-11.

## `expected_devices` count reconciliation (538 here vs 756 elsewhere)

A later export, `/mnt/aidrive/prod-export-2026-08-18-pre-0029.sql`
(2026-08-18, seven days after this sweep's 2026-08-11 snapshot), shows
**756** `expected_devices` rows where this sweep's snapshot shows **538**.
This was flagged for reconciliation rather than accepted on plausibility
— confirmed, not assumed, as time-based growth via an independent
id-set comparison (Python, `set()` difference, re-parsing both dumps
freshly — not derived from either count above):

- 0811 snapshot: 538 rows, ids all unique.
- 0818 export: 756 rows, ids all unique.
- Every one of the 538 ids from the 0811 snapshot is present, unchanged,
  in the 0818 export (`0811_ids.issubset(0818_ids) == True`) — zero ids
  were deleted or reused.
- The 0818 export adds exactly 218 new ids not present in 0811
  (538 + 218 = 756, reconciling exactly).
- Corroborated independently by each dump's own max `created_at` for this
  table: 0811 snapshot's latest `expected_devices.created_at` is
  `2026-08-05 13:43:53`; the 0818 export's latest is `2026-08-13
  15:00:10` — a later export with a later max timestamp and a strict
  superset of ids is the expected shape of ordinary growth, not a
  discrepancy.

**Conclusion**: the 538/756 difference reconciles cleanly as
manifest-upload growth between 2026-08-11 and 2026-08-18 — not a stale-
count bug (unlike the five prior instances of this class on this
project). Both figures are cited above with their source dump inline;
the "0 of 538" bench-impact finding above is scoped explicitly to the
2026-08-11 snapshot and is not claimed to hold against the later,
larger 0818 export (which has not been swept).

## Trailing-slash 404 (raised during this item's verification, not this item's bug)

While cross-checking this item's route (`POST /api/catalog`) against a
live dev server, a 404 was found on `POST /api/catalog/` (trailing
slash) that does not occur on `POST /api/catalog` (no slash). This was
root-caused to be a systemic, pre-existing Hono `app.route()` sub-mounting
behaviour affecting every mounted sub-router in this app, not something
introduced by or specific to this item's route rewrite, and confirmed not
to affect the real UI (which never sends the trailing-slash form). It is
**not detailed here** — see the general backlog entry in
`public/tracker/index.html` (alongside the `held-0030` and `startRepair()`
entries) for the full root-cause writeup.

## Browser citation

A real Playwright-driven browser flow (login → select manifest → scan
IMEI → click "Add to catalogue & receive") was run against the live dev
server and confirmed: toast and label modal render correctly, zero
console errors, and the server independently confirmed all 4 grade
variants (A/B/C/UG) were created by the one call. **What this proves,
precisely**: the new response shape renders without regression against
the existing UI flow. It does **not** prove the new `generated_siblings`
/ `sku_conflicts` fields are surfaced to the operator — the toast text in
this run did not mention the 3 sibling rows also created by the call,
consistent with the UI-surfacing enhancement being deliberately deferred
(not a bug). A non-empty `sku_conflicts` case remains unexercised in a
browser — listed as a low-priority follow-up below, not as a gap, since
surfacing these fields in the UI at all is itself deferred.

## Scope note

Any bulk remediation (writing the 27 missing rows) is explicitly OUT of
this item's commit — a separate future approval, per this project's
standing decision (see migration 0031's own header and
`src/routes/catalog.ts`'s `POST /` decision-2 comment). This sweep is
read-only reporting only.

## Follow-ups (not gaps)

- Exercise a non-empty `sku_conflicts` case through the real browser once
  (or if) the UI is extended to surface `generated_siblings`/
  `sku_conflicts` to the operator.
- Re-run this sweep against a fresher export (e.g. the 2026-08-18 one
  used for the count reconciliation above, or later) before relying on
  the "zero bench impact" conclusion beyond scoping this item's original
  commit.
