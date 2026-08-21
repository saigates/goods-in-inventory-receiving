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

## Catalogue-side figure (a `sku_catalog`-only fact)

- 702 distinct (organisation_id, brand, model, capacity, color) configs.
- 2,781 total rows.
- 702 × 4 = 2,808 expected if fully populated; actual 2,781; difference 27.
- **9 configs are under-populated, all carrying only a single `UG` row
  (0 of the other 3 grades exist for any of them) — 27 missing rows
  total.** Exact list:

  | Brand | Model | Capacity | Color | Grades present |
  |---|---|---|---|---|
  | SAMSUNG | GALAXY S20 FE | 128GB | Cloud Navy | UG |
  | SAMSUNG | GALAXY S21 | 256GB | Phantom Gray | UG |
  | SAMSUNG | GALAXY S23 FE | 256GB | Graphite | UG |
  | SAMSUNG | GALAXY S24 | 256GB | Phantom Black | UG |
  | SAMSUNG | GALAXY S24 | 512GB | Phantom Black | UG |
  | SAMSUNG | GALAXY S24 FE | 256GB | Graphite | UG |
  | SAMSUNG | GALAXY Z FLIP5 | 256GB | Graphite | UG |
  | SAMSUNG | GALAXY Z FLIP5 | 512GB | Graphite | UG |
  | SAMSUNG | GALAXY Z FOLD5 | 256GB | Phantom Black | UG |

This matches the pre-registered expectation exactly (9 configs / 27 rows).

## Device-side ("bench-impact") figure — SEPARATE, do not substitute for the above

Per spec: devices whose own grade has no corresponding variant row on
their configuration — concretely, any device on one of the 9
under-populated configs above carrying grade A, B, or C (no catalogue row
exists for that grade+config, so it would hard-stop at receive/bench);
any UG-graded device on those same 9 configs is fine (a UG row does
exist).

Joined against both device tables in this snapshot:

- `received_devices` (193 rows, already-confirmed devices): **0** matches.
- `expected_devices` (538 rows, pending/not-yet-received manifest lines):
  **0** matches.

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

## Scope note

Any bulk remediation (writing the 27 missing rows) is explicitly OUT of
this item's commit — a separate future approval, per this project's
standing decision (see migration 0031's own header and
`src/routes/catalog.ts`'s `POST /` decision-2 comment). This sweep is
read-only reporting only.
