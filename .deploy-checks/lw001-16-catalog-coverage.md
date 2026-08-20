# Catalogue coverage — the 16 received LW001 devices (manifest 14)

Source: production `expected_devices` WHERE `manifest_id = 14 AND status =
'received'` (16 rows, confirmed via `gsk hosted d1_query` — `worker_get`
gate was open at query time). Manifest 14 (`LW001-40242714_40242715_20`,
supplier `LW001`) has 20 total lines: 16 received (these), 4 still pending.

Checked against the LOCAL sku_catalog (2,781 rows — believed at the time
of this check to mirror production per README's migration-0017 entry;
**production coverage itself is unverified — flagged per your instruction,
needs checking through the production Catalog tab directly**), using the
actual `matchCatalogRows()`

**CORRECTION (2026-08-20): the "mirrors production" premise above is
false and this file's checked-against catalog was never actually
2,781 rows.** Direct `SELECT COUNT(*)` against this sandbox's local
`--local` D1 today returns 682 `sku_catalog` rows, not 2,781 — confirmed
consistent with `backups/d1-local-baseline-2026-08-10.sql` (taken before
this file was written, already 682 rows), so local has held 682 rows,
not 2,781, for the whole period this file has existed. This file's own
17 rows above were therefore either (a) checked against a since-reset
local D1 that genuinely held 2,781 rows at write time and has since
dropped to 682, or (b) written from the production export data without
the local D1 actually holding it — the git history available does not
distinguish these two, and no evidence of an intervening `db:reset` or
migration replay between this file's write date and today was found.
Either way, this file's original per-row match/no-match findings (14
exact/fuzzy matches, 2 genuine gaps) cannot be re-verified against
today's local D1 without re-running the check, and should not be taken
as still-current without that re-run. This is this file's **second**,
independent reason (alongside the pre-existing "production coverage
itself is unverified" flag above) that its findings need re-confirming
before being relied on — see README.md's `sku_catalog` entry for the
corrected 2,781-rows-vs-702-configurations distinction that also bears
on any future re-check of this file's kind.
logic from `src/lib/catalog.ts` (lines 66-151) reimplemented faithfully in
Python — not a naive exact-string check. That matters: 3 of what looked
like misses on a first pass turned out to be legitimate **fuzzy-color
substring matches** the real app already resolves automatically (step 2,
lines 107-118) — e.g. "Purple" on the manifest legitimately resolves to
the catalogue's "Deep Purple" because one contains the other. Only the
last two rows below are genuine gaps.

15 distinct (model, capacity, color, grade) combinations across the 16
rows (704 and 705 are identical — same iPhone 13 Pro Max 128GB Blue
grade-C combo twice).

| expected_devices id(s) | Model | Capacity | Color (manifest) | Grade | Local catalogue result |
|---|---|---|---|---|---|
| 693 | iPhone 14 Plus | 128GB | Blue | UG | ✅ exact — `APL-I14PL-128-BLU-UG` |
| 695 | iPhone 13 Pro | 256GB | Graphite | C | ✅ exact — `APL-I13P-256-GRP-C` |
| 696 | iPhone 15 | 128GB | Yellow | UG | ✅ exact — `APL-I15-128-YLW-UG` |
| 697 | iPhone 14 Pro Max | 128GB | Gold | C | ✅ exact — `APL-I14PM-128-GLD-C` |
| 703 | iPhone 13 Pro Max | 128GB | Graphite | C | ✅ exact — `APL-I13PM-128-GRP-C` |
| 706 | iPhone 13 Pro Max | 256GB | Gold | C | ✅ exact — `APL-I13PM-256-GLD-C` |
| 707 | iPhone 12 | 64GB | Black | UG | ✅ exact — `APL-I12-64-BLK-UG` |
| 708 | iPhone 13 Pro | 128GB | Silver | C | ✅ exact — `APL-I13P-128-SLV-C` |
| 710 | iPhone 14 Plus | 256GB | Midnight | UG | ✅ exact — `APL-I14PL-256-MDN-UG` |
| 692 | iPhone 14 Pro Max | 256GB | Purple | UG | ✅ fuzzy — "Purple" ⊂ "Deep Purple" → `APL-I14PM-256-DPU-UG` |
| 698 | iPhone 14 Pro Max | 128GB | Purple | C | ✅ fuzzy — same rule → `APL-I14PM-128-DPU-C` |
| 700 | iPhone 13 Pro Max | 128GB | Green | C | ✅ fuzzy — "Green" ⊂ "Alpine Green" → `APL-I13PM-128-ALG-C` |
| 704, 705 | iPhone 13 Pro Max | 128GB | Blue | C | ✅ fuzzy — "Blue" ⊂ "Sierra Blue" → `APL-I13PM-128-SBL-C` |
| **701** | **iPhone 15 Pro Max** | **1024GB** | Black | UG | **❌ ABSENT** (see below) |
| **709** | **iPhone 16 Pro Max** | **256GB** | **Gold** | UG | **❌ ABSENT** (see below) |

## The two genuine gaps

**id 701 — iPhone 15 Pro Max / 1024GB / Black / UG**: this is NOT a
missing catalogue row — the catalogue HAS `iPhone 15 Pro Max` at 1TB in
every colour/grade (incl. `APL-I15PM-1TB-BLK-UG`, catalogue colour is
literally "Black"). The `1024GB` shown in the table above is the RAW value
this row was stored with under the OLD `normalizeCapacity()` (see below) —
it is not, and was never, a second valid catalogue-side spelling.

**UPDATE (2026-08-18, superseding the two options originally listed
here)**: the canonical form has since been decided and implemented —
committed as `e52b4ce` (`src/lib/catalog.ts`, with
`test/catalog.spec.ts`). The catalogue's own real distinct-capacity set
is exactly `{64GB, 128GB, 256GB, 512GB, 1TB, 2TB}` — it NEVER stores
`1024GB`/`2048GB` — so `1TB` is the one true canonical form, not `1024GB`.
`normalizeCapacity()` now folds any bare-GB value that's an exact multiple
of 1024 UP into TB form (`1024`/`1024GB` → `1TB`, `2048`/`2048GB` → `2TB`),
the opposite direction from what was floated as "option (a)" in the
original version of this note (adding a `1024GB`-labelled duplicate
catalogue row) — that option is now obsolete and was NOT taken; do not
reintroduce it or any other `1024GB`/`2048GB`-labelled catalogue row.
`MANIFEST_CLEANUP_PROMPT`'s Rule 4 was also corrected to match (commit
`02e7502`) — it used to instruct converting a TB value INTO `1024GB`,
which was backwards and is exactly what produced this row's bad value in
the first place.

**This code fix has NOT been deployed yet** (deploy remains HELD per
`pre-0029-export.md` pending the `worker_get` control-plane gate). Once it
IS deployed, note that fixing `normalizeCapacity()` does not retroactively
rewrite anything already stored — production `expected_devices` row 701
will still hold the literal stored value `1024GB` from the original
upload (inserted via the old, pre-fix normalizer at `src/routes/
manifests.ts` line 243) until it is explicitly **re-resolved**: re-running
the catalogue match against this row's current fields (e.g. via the
Confirm-SKU / manual-pick flow, or an edit-and-re-save that goes back
through `normalizeCapacity()`) so its stored capacity is rewritten to
`1TB` and the SKU lookup can then succeed. Deploying the code alone does
not fix this specific already-received row; it only fixes future uploads
and any future re-resolution of this one.

**id 709 — iPhone 16 Pro Max / 256GB / Gold / UG**: this one IS a genuine
missing catalogue row. iPhone 16 Pro Max only exists in four Apple
"Titanium" finishes in the local catalogue (Black/Desert/Natural/White
Titanium — Apple's actual 16 Pro Max colour range; "Gold" was never a
real finish for this model). "Gold" does not substring-match any of the
four Titanium names, so the app correctly falls through to `no_match`
rather than silently mis-picking one — this would show the operator a
manual-pick screen with the four Titanium SKUs as candidates, not a
"nothing exists for this model" dead end. **Two possibilities, and I
can't tell which from the data alone: (a) the manifest supplier's "Gold"
free-text label is describing one of the four real Titanium finishes
under different wording — the closest by common naming convention would
usually be Desert Titanium (a warm/gold-toned finish) but that's a guess,
not a fact; or (b) this is a genuine data-entry variance on the supplier's
side and the operator needs to resolve it by looking at the physical
device.** Recommend checking the physical unit or the supplier's own
listing before picking a SKU — not something to resolve by inference.

## Bottom line for your two-blocker sequencing

14 of the 16 devices have a clean, unambiguous local catalogue resolution
today. 2 need attention before catalogue lookup succeeds for them: 701's
code-side blocker is fixed (`e52b4ce`/`02e7502`, canonical form = `1TB`,
not deployed yet) but the already-stored production row still needs
re-resolving after deploy, as detailed above — it is not automatically
corrected by the deploy itself; 709 needs a human decision on which
Titanium finish "Gold" actually means (or a new catalogue row if it's
genuinely a colour Apple doesn't sell — unlikely but not ruled out here).

**Production coverage is UNVERIFIED** — this whole table is checked
against local D1 only, which mirrors the catalogue as of migration 0017
(2026-07-29). Confirm the same 14/2 split holds in the actual production
Catalog tab before treating this as final — the README explicitly
confirms local and prod matched exactly as of that migration, but that
was over two weeks before this manifest was received, so it's worth a
direct look rather than assuming persistence.

## Post-deploy checklist

Once the held commits (including `4a6d16f` / the id-43 self-heal follow-up
committed after it) are deployed via `gsk hosted deploy`:

1. **Row 701 re-resolution** (`expected_devices`, iPhone 15 Pro Max /
   1024GB / Black / UG): deploying the `normalizeCapacity()` fix
   (`e52b4ce`) does NOT retroactively rewrite this already-stored row —
   its `capacity` column still literally holds `1024GB` until it is
   explicitly re-resolved (Confirm-SKU / manual-pick flow, or an
   edit-and-re-save that goes back through the fixed normalizer). Do this
   after deploy; it does not happen automatically.

2. **Re-run the SKU/grade consistency sweep against PRODUCTION — do not
   trust the local result as representative.** The `1 mismatch out of 16`
   figure reported in `4a6d16f`'s commit message (id 43 locally) is a
   **local-only finding with zero extrapolation value**: local D1 holds
   only 16 `received_devices` rows total, while **production holds 193
   `received_devices` rows, none of which are present in local D1**. The
   true production mismatch count is therefore genuinely **unknown** — it
   could be 0, it could be dozens — until the sweep is actually re-run
   against production data. After deploy:
   - Call `GET /api/inventory/sku-grade-consistency` against the
     production URL (authenticated as an org admin), or run the
     equivalent read via `gsk hosted d1_query` directly against the
     production D1 binding, and record the real `mismatch_count` and the
     full `mismatches` list here.
   - For any production id that surfaces (id 43's local shape — grade
     column correct, SKU suffix stale — is exactly the case the
     `POST /api/inventory/grade` self-heal fix now handles): call
     `POST /api/inventory/grade` with each flagged device's own
     (already-correct) `grade` value. This re-resolves the SKU alone,
     writes a `SKU_CORRECTION` `device_events` row (not `GRADE_CHANGE`,
     no `grade_audit` write), and invalidates/re-queues any stale queued
     print label for that device — no fabricated regrade round-trip
     needed.
   - Re-run the consistency check once more afterward and confirm
     `mismatch_count: 0` (or that every remaining entry has been
     triaged — the self-heal only fires when it can find an unambiguous
     catalogue match; anything it can't resolve stays as an explicit
     `skipped` entry naming the missing combination, same fail-closed
     posture as the grade-change path).
   - Update this file with the actual production count once known —
     do not carry the "1/16" figure forward as if it were a production
     number.
