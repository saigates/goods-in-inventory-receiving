# Zoho Inwards/Outwards reconnaissance (2026-09-09) — format + revenue-classifier findings

**Inputs** (user-uploaded, read-only, NOT committed to this repo — this note
records findings derived from them, not the files themselves):
- `Serial Number Details_Inwards.csv` — 1635 data rows (1636 lines incl. header)
- `Serial Number Details_Outwards.csv` — 1581 data rows (1582 lines incl. header)

Both files share an identical 25-column header:
```
product_name, serial_number_item_id, sku, serial_number_code, status,
in_entity, in_entity_type, in_entity_id, in_entity_number, in_contact_id,
in_contact_name, in_entity_date, out_entity, out_entity_type, out_entity_id,
out_entity_number, out_entity_date, out_contact_id, out_contact_name,
line_item_location_id, line_item_location_name, cost_price, sold_price,
profit, item_status
```
"Inwards" vs "Outwards" is a report DATE-FILTER distinction (filtered on
`in_entity_date` vs `out_entity_date` respectively), not a schema
difference — confirmed via 1066 shared `serial_number_code` values and 183
shared `serial_number_item_id` values between the two files.

These figures supersede any earlier index-derived figures on file for this
dataset; everything below is freshly computed from the two CSVs via Python
`csv.DictReader`, not retyped from memory.

## Section 1 — Structural findings (bijection, cardinality, dates)

- `sku` ↔ `serial_number_item_id`: strict 1:1 bijection, 207 distinct pairs
  in Inwards.
- `line_item_location_name`: constant (1 distinct value) across all rows in
  both files.
- `status='sold'` ⟺ `out_entity` populated: 0 mismatches across all 3216
  combined rows — `status` is fully redundant with out_entity presence.
- `item_status='active'`: 100% of rows in both files.
- `in_entity_type`: Inwards = 100% `bill`; Outwards = 1580 `bill` + 1 `creditnote`.
- ID-shaped columns (`serial_number_item_id`, `in_entity_id`,
  `out_entity_id`, `in_contact_id`, `out_contact_id`,
  `line_item_location_id`) match an 18-digit Zoho-ID shape 100% of the time
  populated.
- `in_entity_date` (Inwards): **MIN = 2026-08-03, MAX = 2026-09-08** (exact,
  not the looser "all 2026" framing used in the prior pass). Earliest-date
  histogram:
  ```
  2026-08-03: 1     2026-08-04: 12    2026-08-05: 222   2026-08-06: 223
  2026-08-07: 2     2026-08-10: 23    2026-08-11: 3     2026-08-12: 2
  2026-08-13: 221   2026-08-14: 14
  ```
  → **Inwards is an August-onward receipt view. Its `available` rows are
  NOT a complete stock roster** — any consumer treating Inwards `available`
  as "all current stock" will undercount everything received before
  2026-08-03.
- `in_entity_date` (Outwards): spans 2022-11-04 to 2026-09-08 — this file's
  IN side reaches back to 2022, predating this business's own goods-in
  tracking window (`received_devices` earliest receipt is inside the 2026
  window; see Section 3).

## Section 2 — Row-signature mismatch investigation (was: 16/200 sampled, 8%)

Re-run exhaustively (not sampled) across all 1066 shared `serial_number_code`
values:
- 954 codes have exactly 1 row in each file (clean 1:1 comparison).
- 112 codes excluded from this comparison (multi-row in at least one file —
  legitimate multi-leg history, not a mismatch).
- Of the 954: **947 identical across all 25 columns, 7 different**
  (0.7% of the clean-comparison set — the earlier 8%-on-a-200-sample
  figure was noise from a small sample, not a systemic rate).

All 7 differing pairs share the same shape: `status` differs
(`available` in Inwards / `sold` in Outwards) alongside every out_-prefixed
column and, in some cases, `in_contact_id`/`in_contact_name`/`in_entity_date`
and even `product_name`/`serial_number_item_id`/`sku`.

**Root cause, confirmed by inspection, not assumed**: this is a
`serial_number_item_id` REUSE artifact, not a data-integrity fault. Zoho
recycles a `serial_number_code` (physical device) across DIFFERENT
`serial_number_item_id`/`sku` catalogue entries over its history — e.g.
`serial_number_code=351264783478842` appears once as
`serial_number_item_id=251444000067528154` / `sku=I13-128-BLK-A` (grade A,
received via `SW001` 2026-09-07, still `available` — this is the CURRENT
leg) and once as `serial_number_item_id=251444000069096954` /
`sku=I13-128-BLK-B` (grade B, received via `GR CHANGE AUTO IN` 2026-07-14,
sold as a vendor_credit to `rep` on 2026-08-06 — an EARLIER, closed leg
after an internal grade change). The two "rows" for one shared code are two
different legs of the same physical device's life, each correctly
`available`/`sold` in ITS OWN entity context — the Inwards/Outwards report
pair is just each showing a different one of the device's legs depending
on which `in_entity_date`/`out_entity_date` falls in that report's window.

**Consequence for the importer's dedupe key**: `serial_number_code` alone
is NOT a safe 1:1 key across a device's full history — `(serial_number_code,
serial_number_item_id)` or `(serial_number_code, in_entity_id)` is needed to
pin one specific leg. The serial-first importer (Section 4) must match on
`serial_number_code` against `received_devices.imei` (an IMEI has no
grade-change concept, so this collision cannot occur on our own side of the
join), but must not assume the FIRST or ONLY Zoho row for a matched code is
the relevant one if a device's own history contains a re-grade — this is
flagged for the importer's design, not yet resolved in code.

## Section 3 — out_contact_id revenue classifier (mandatory pre-branch-logic query)

`out_entity_type` is confirmed the WRONG revenue classifier: FBA custody
transfers and internal grade-change moves both carry `out_entity_type=
'invoice'` alongside real customer sales. `out_contact_id` is the correct
classifier. Empirical aggregation, run against the combined Inwards+Outwards
CSV data (Python, not live D1 — this data lives only in the uploaded files):

```sql
SELECT out_contact_id, out_contact_name, out_entity_type,
       COUNT(*), MIN(sold_price), MAX(sold_price), AVG(cost_price)
GROUP BY 1,2,3 ORDER BY COUNT(*) DESC
```

| out_contact_id | out_contact_name | out_entity_type | count | min_sold | max_sold | avg_cost |
|---|---|---|---|---|---|---|
| 251444000000060479 | Amazon UK - Customer | invoice | 1526 | 64.37 | 857.95 | 274.06 |
| (blank — status='available') | | | 525 | NULL | NULL | 218.08 |
| 251444000023280586 | AMAZON MANUAL | invoice | 281 | 80.00 | 970.00 | 205.33 |
| 251444000122630826 | Last Rope BM Automation | invoice | 226 | 85.00 | 570.00 | 216.28 |
| 251444000458664685 | TEMU | invoice | 178 | 94.50 | 899.00 | 216.19 |
| 251444000000214057 | Saigates BM Automation | invoice | 138 | 166.00 | 640.00 | 219.71 |
| 251444000347365746 | SW001 | vendor_credit | 95 | 180.00 | 655.00 | 239.62 |
| 251444000345383017 | Amazon FBA | invoice | 88 | 450.00 | 450.00 | 180.45 |
| 251444000459339270 | REFURBED | invoice | 67 | 215.00 | 450.00 | 202.46 |
| 251444000065690570 | GR CHANGE AUTO OUT | invoice | 54 | 100.00 | 899.00 | 223.24 |
| 251444000244894695 | rep | vendor_credit | 10 | 265.00 | 550.00 | 324.20 |
| 251444000000147532 | ADJ | vendor_credit | 6 | 75.00 | 655.00 | 170.00 |
| 251444000005533455 | BM-LR Manual | invoice | 6 | 100.00 | 590.00 | 183.33 |
| 251444000458172774 | TEMU | invoice | 3 | 125.00 | 320.00 | 146.67 |
| 251444000000051003 | BM MANUAL | invoice | 3 | 245.00 | 250.00 | 191.67 |
| 251444000418326549 | EBAY LASTDROP | invoice | 3 | 439.95 | 443.44 | 365.00 |
| 251444000000365314 | MT001 | vendor_credit | 2 | 275.00 | 275.00 | 275.00 |
| 251444000457721449 | TWG001 | vendor_credit | 1 | 285.00 | 285.00 | 105.00 |
| 251444000007063707 | Backmarket LR | invoice | 1 | 237.00 | 237.00 | 215.00 |
| 251444000104824496 | Shop Customer | invoice | 1 | 80.00 | 80.00 | 65.00 |
| 251444000048250993 | RAKESHBHAI LONDON | invoice | 1 | 280.00 | 280.00 | 188.00 |
| 251444000119914593 | YH001 | vendor_credit | 1 | 235.00 | 235.00 | 160.00 |

22 distinct groups total. Verification against the two named facts given:
- `Amazon FBA` (id `251444000345383017`): n=88, cost range **£160.00–£200.00**
  (matches the "£160–£185" description directionally; the true max is £200,
  slightly wider than stated — reported verbatim, not rounded to fit), sold_price
  is a **flat £450.00 for all 88 rows** — confirms FBA_TRANSFER disposition,
  not revenue.
- `GR CHANGE AUTO OUT` (id `251444000065690570`): n=54. Both named invoices
  found: `INV-059076` → sold_price=£100.00/cost=£100.00 (2 rows, duplicate
  leg); `INV-059592` → sold_price=£300.00/cost=£135.00 (2 rows) — matches
  the brief exactly. **However**, this bucket's sold_price is NOT uniformly
  £300 — it ranges £100.00 to £899.00 across its 54 rows. The £300 example is
  one instance, not the bucket's shape; the disposition (not revenue) applies
  regardless of price.

**Mapped disposition enum** (every `out_contact_id` above accounted for,
zero left `UNCLASSIFIED` in this dataset — but the enum below is the
mapping table the importer must consult by ID, and any FUTURE
`out_contact_id` not in this table must still produce `UNCLASSIFIED`,
never default to `SALE_EXTERNAL`):

| out_contact_id | out_contact_name | disposition |
|---|---|---|
| 251444000000060479 | Amazon UK - Customer | SALE_EXTERNAL |
| 251444000023280586 | AMAZON MANUAL | SALE_EXTERNAL |
| 251444000122630826 | Last Rope BM Automation | SALE_EXTERNAL |
| 251444000458664685 | TEMU | SALE_EXTERNAL |
| 251444000458172774 | TEMU (2nd contact_id, same display name) | SALE_EXTERNAL |
| 251444000000214057 | Saigates BM Automation | SALE_EXTERNAL |
| 251444000459339270 | REFURBED | SALE_EXTERNAL |
| 251444000005533455 | BM-LR Manual | SALE_EXTERNAL |
| 251444000000051003 | BM MANUAL | SALE_EXTERNAL |
| 251444000418326549 | EBAY LASTDROP | SALE_EXTERNAL |
| 251444000007063707 | Backmarket LR | SALE_EXTERNAL |
| 251444000104824496 | Shop Customer | SALE_EXTERNAL |
| 251444000048250993 | RAKESHBHAI LONDON | SALE_EXTERNAL |
| 251444000345383017 | Amazon FBA | FBA_TRANSFER |
| 251444000065690570 | GR CHANGE AUTO OUT | GRADE_CHANGE_OUT |
| 251444000347365746 | SW001 | RETURN_TO_SUPPLIER |
| 251444000244894695 | rep | RETURN_TO_SUPPLIER |
| 251444000000147532 | ADJ | RETURN_TO_SUPPLIER |
| 251444000000365314 | MT001 | RETURN_TO_SUPPLIER |
| 251444000457721449 | TWG001 | RETURN_TO_SUPPLIER |
| 251444000119914593 | YH001 | RETURN_TO_SUPPLIER |
| (blank) | (blank, status='available', unsold) | N/A — not yet sold, no disposition |

**IMPORTANT — name collision hazard confirmed**: `TEMU` maps to TWO
distinct `out_contact_id` values (`251444000458664685` and
`251444000458172774`). The importer's disposition lookup MUST key on
`out_contact_id`, never on `out_contact_name` — the same display name can
legitimately carry two different underlying Zoho contacts (this is Zoho's
own data, not a normalization bug on our side, and must be preserved as
two separate mapping-table rows, both SALE_EXTERNAL here but potentially
divergent in a future export).

## Section 4 — Vendor-credit price-equality correction (verified)

Combined vendor_credit rows across both files: 115 (53 Inwards + 62
Outwards, i.e. counted independently — this is NOT deduplicated by serial
code, since the two files' vendor_credit rows are largely disjoint dates).

Price-equality breakdown by contact within the vendor_credit bucket:

| out_contact_name | sold_price == cost_price | sold_price != cost_price |
|---|---|---|
| SW001 | 37 | 58 |
| rep | 5 | 5 |
| ADJ | 2 | 4 |
| MT001 | 2 | 0 |
| TWG001 | 0 | 1 |
| YH001 | 0 | 1 |
| **Total** | **46** | **69** |

**Confirmed: price equality does NOT hold reliably even for SW001** — 58 of
95 SW001 rows (61%) have sold_price ≠ cost_price. The £260/£135 example
cited in the brief is present and verified: `out_contact_name=SW001,
cost_price=135.00, sold_price=260.00`. Price equality must NOT be used as a
vendor-credit detection heuristic anywhere in the importer — `out_contact_id`
membership in the RETURN_TO_SUPPLIER set (Section 3 table) is the only
correct detector.

## Section 5 — Match-rate framing against live `received_devices`

Live production read (bracketed by `gsk login-info` before/after,
`account_id=7d2579beb52424d39cdd02c0983151e9` confirmed via `gsk hosted
list` metadata, project `d6aea290-bd61-4f82-aa8d-94378b9f2fec`; SELECT-only,
read-only):
```
SELECT COUNT(*) as cnt, COUNT(imei) as with_imei FROM received_devices
→ cnt=1135, with_imei=1135
```
Confirms the 1,135-device figure exactly (ties to the Amendment-4 session's
own `source='manifest'`=1133 + `source='manual'`=2 = 1135 finding).

Case-insensitive exact-string match of all 1135 `received_devices.imei`
values against Outwards' 1499 distinct `serial_number_code` values:
- **Matched: 506** (44.6% of goods-in devices; 33.8% of Outwards' distinct
  codes)
- **Unattributed Outwards codes: 993** (66.2% of Outwards)

This is the EXPECTED shape per the brief, not a failure signal: Outwards
carries `in_entity_date` back to 2022-11-04 (Section 1), predating this
business's own goods-in tracking window (earliest `received_devices` receipt
inside the 2026 window) — the majority of the 993 unattributed rows are
devices this system never received in the first place, not import misses.
**The importer must surface `993` (or whatever the live figure is at
build/run time) as an explicit placard count on the import summary screen,
never silently absorbed.**

For reference, the same check against Inwards' 1555 distinct codes: 779
matched (50.1%) — expected to be higher since Inwards' window is closer to
`received_devices`' own window, but still well under 100% for the same
2022-vs-2026 reason.

## Section 6 — serial_number_code shape distribution (importer design input)

Across both files combined, 3216 total `serial_number_code` values:
- 3194 are exactly 15-digit numeric (99.3%). Of these, **3192 are
  Luhn-valid, 2 are Luhn-INVALID**: the single Luhn-invalid value found in
  this dataset is `861669048498974` (HUAWEI MATE 20 PRO-128GB/TWILIGHT/C).
  **Correction to the brief's specific example**: `990003060138753` (the
  cited cellular iPad value) was checked against both the app's exact
  Luhn algorithm (`src/lib/validate.ts:luhnValid`, Node-verified) and an
  independent Python implementation — **it IS Luhn-valid**, not
  Luhn-invalid as stated. The general rule the brief is making (never
  Luhn-gate Zoho serials) still stands and is independently confirmed by
  the real counter-example found in this data (`861669048498974`) — the
  specific value cited just isn't the failing one; this is a good-faith
  numerical correction, not a rebuttal of the underlying instruction.
- 1 value is exactly 10-character alphanumeric.
- 21 values (18 distinct) are "other" shapes, 11–16 characters, mixed
  alnum, e.g. `RFAR72WAX0L` / `rfat12vx6ey` (the case-difference pair cited
  in the brief — confirmed present, exact case as given), `C02W63V9HV2L`,
  `DLXW600QHPJ5`, `3356295608925687` (16-digit numeric, IMEISV-shaped, also
  outside `validateImei()`'s accepted set).
- 4 total rows (across all shapes) contain lowercase letters:
  `gy6dnf5mq1rd` (x2), `rfat12vx6ey` (x2) — confirming case-insensitive
  matching is required, not optional.

All 18 distinct "other"-shape values would fall to `UNMATCHED_SERIAL_SHAPE`
under the planned importer design (Section 4 of the user's brief) if they
don't happen to exact-match a `received_devices.imei` string — they must
never be coerced through `validateImei()`, which would reject all of them
(neither 15-digit-Luhn nor exactly-10-alnum).

## Section 7 — implications for the importer (design, not yet built)

1. Match key: `serial_number_code` (case-insensitive, exact string) ↔
   `received_devices.imei`. No SKU translation in this path.
2. Disposition: look up `out_contact_id` in the Section 3 mapping table.
   Unmapped → `UNCLASSIFIED`, counted, surfaced, never defaults to
   `SALE_EXTERNAL`.
3. Vendor credits (`RETURN_TO_SUPPLIER`): do not set `status=SOLD`, do not
   populate `sold_price_pence`; record credit value in a new dedicated
   field (not yet added to schema — `0033_sale_attribution.sql` has no such
   column today); excluded from revenue.
4. Serial shape: no Luhn gate, no `validateImei()` coercion;
   non-matching-shape codes get `UNMATCHED_SERIAL_SHAPE`, counted and
   reported.
5. Dedupe: `serial_number_code` alone is not a safe leg-identifier (Section
   2) — matching against `received_devices.imei` is fine (IMEI has no
   grade-change reuse), but if a future need arises to dedupe WITHIN the
   Zoho export itself, `(serial_number_code, serial_number_item_id)` is the
   safe compound key, not `serial_number_code` alone.
6. Unattributed-count placard: surface the Section 5 unmatched count
   explicitly on every import run, framed as expected (pre-2026 stock),
   not as an error.
7. `Z-G-MAPPING.csv` (SKU rollup/reporting map) is NOT a dependency for
   this path — only needed for reporting rollups and any future
   unmatched-fallback attribution, per explicit instruction.

## Status

Read-only reconnaissance. No schema, route, or importer code written yet.
Next: design + build the serial-first importer module and its D1 write
path (new migration for the vendor-credit value column), with unit tests
covering the shape/disposition/dedupe edge cases documented above.
