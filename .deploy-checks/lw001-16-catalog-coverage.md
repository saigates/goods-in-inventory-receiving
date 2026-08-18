# Catalogue coverage — the 16 received LW001 devices (manifest 14)

Source: production `expected_devices` WHERE `manifest_id = 14 AND status =
'received'` (16 rows, confirmed via `gsk hosted d1_query` — `worker_get`
gate was open at query time). Manifest 14 (`LW001-40242714_40242715_20`,
supplier `LW001`) has 20 total lines: 16 received (these), 4 still pending.

Checked against the LOCAL sku_catalog (2,781 rows — mirrors production per
README's migration-0017 entry; **production coverage itself is
unverified — flagged per your instruction, needs checking through the
production Catalog tab directly**), using the actual `matchCatalogRows()`
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
literally "Black"). The blocker is `normalizeCapacity()`
(`src/lib/catalog.ts` lines 19-25): it only recognizes a bare number
optionally followed by `GB`/`G` and rewrites it to `<n>GB` — there is no
GB↔TB unit conversion anywhere in the function. `"1024GB"` normalizes to
`"1024GB"` and can never equal the catalogue's `"1TB"`, regardless of
colour or grade. This is a **normalization gap, not a missing SKU** — the
underlying catalogue entry already exists.
  - Two ways to close it before this device blocks anything: (a) the
    fastest fix — just add a `1024GB`-labelled duplicate row to the
    catalogue for this one SKU (no code change, mirrors how the catalogue
    already treats capacity as a free-text label); or (b) the correct fix
    — extend `normalizeCapacity()` to fold `1024` (and `1024GB`) to `1TB`
    for models whose catalogue capacity is expressed in TB. (b) is a code
    change and out of scope for "add it in production today through the
    UI" — recommend (a) for the immediate unblock, and I can open (b) as
    a follow-up ticket if you want the normalization fixed properly later
    (it would silently affect every future 1TB manifest row, not just
    this device).

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
today. 2 need attention before catalogue lookup succeeds for them: 701
needs either a same-model 1024GB-labelled row added or the TB-normalization
fix; 709 needs a human decision on which Titanium finish "Gold" actually
means (or a new catalogue row if it's genuinely a colour Apple doesn't
sell — unlikely but not ruled out here).

**Production coverage is UNVERIFIED** — this whole table is checked
against local D1 only, which mirrors the catalogue as of migration 0017
(2026-07-29). Confirm the same 14/2 split holds in the actual production
Catalog tab before treating this as final — the README explicitly
confirms local and prod matched exactly as of that migration, but that
was over two weeks before this manifest was received, so it's worth a
direct look rather than assuming persistence.
