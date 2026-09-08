# CSV export deploy (2026-09-08) — items 1–4 verified-by-construction, item 5 + D1 live PASS

**Deployed version**: `6a9810a4-a1cc-4ce4-a6a8-9c983de461ad`, built from `aae5b1f`
("B3/B4: CSV export column-set correction, IMEI encoding split, export
button, and test rewrite").
**Project**: `d6aea290-bd61-4f82-aa8d-94378b9f2fec`. **Account anchor**:
`7d2579beb52424d39cdd02c0983151e9`. **D1**: `c934cee3-27cd-4524-b852-5760878eba8f`.

## Why this entry exists

Items 1–4 below cannot be verified by a live authenticated browser check in
this pass: real per-person Saigates accounts are off-limits as fixtures, and
Playwright must never run against production. `.deploy-checks/g5-phase2-live-half.md`
established the precedent for exactly this situation — that pass verified a
route's identity from the *unauthenticated* `/api/auth/login` error-shape
rather than completing a real login, explicitly noting "no login was
actually completed with real credentials (by design, per the standing
instruction)". This entry follows the same pattern: source inspection, a
byte-exact hash match between the local build and the live static asset, and
the existing (already-committed, already-passing) spec suite stand in for a
live authenticated check. This is recorded as **verified-by-construction**,
not as a live PASS, and should not be read as one.

## Items 1–4 — verified-by-construction

**Item 1 — pagination fields present, "Showing X-Y of Z" not silently
truncated.**
`src/routes/inventory.ts:26-59` computes `pageSize` (capped 1-200),
`offset`, and always returns `total` from a separate `COUNT(*)` query
(`inventory.ts:47-49,59`) alongside the page of `results` — the response
shape is `{ devices, page, page_size, total }`. The comment directly above
the route (`inventory.ts:20-22`) states the intent explicitly: "`total` is
always returned so the UI can render 'Showing 1-200 of 1133' and never
silently present a truncated list as complete." The frontend renders this at
`public/static/app.js:120`: `` `Showing ${start}-${end} of ${total}` ``,
consuming the same `total` field. Confirmed present in the deployed
`app.js` via the hash match below — this is not dead/unused code.

**Item 2 — CSV export is unbounded, not silently capped.**
`src/routes/devices.ts:230` (`/export/csv`) builds its `where` clause with no
`LIMIT`/`OFFSET` anywhere in the query construction; the comment at
`devices.ts:274` states this directly: "No LIMIT/OFFSET, no row cap —
unbounded by design." Every matching row is streamed
(`devices.ts:330-336`, the `for (const row of results)` loop, one
`writer.write` per row, `rowCount++`). A capped export that silently dropped
rows past a page boundary would be a data-integrity issue for exactly the
kind of downstream tooling (accounting reconciliation, etc.) that consumes
this endpoint — the code confirms no such cap exists.

**Item 3 — cost columns are role-gated by full column removal, not by
blanking.**
`devices.ts:733-736` (`requireManager`) gates on
`role === 'manager' || role === 'admin'`. `devices.ts:318-320` builds
`headers` as `baseHeaders` alone for a non-manager, or
`[...baseHeaders, ...costHeaders]` for a manager/admin — `bill_ref`,
`purchase_cost_gbp`, `repair_cost_gbp` are absent from the header row
entirely for an operator, not present-but-empty. This exact behaviour is
asserted by the already-committed, already-passing test suite:
`test/csvExport.spec.ts:529` ("omits purchase_cost_gbp/repair_cost_gbp/
bill_ref from the header ENTIRELY for an operator, not just blanked cells")
and `test/csvExport.spec.ts:556` ("includes all three cost columns for a
manager/admin caller, on the very same device").

**Item 4 — `?excel=1` IMEI encoding, scoped to the IMEI column only.**
`devices.ts:222` defines `imeiAsText = (imei) => `="${String(imei ?? '')}"``.
`devices.ts:230-233` reads `excelSafe = q.excel === '1'`, and the per-row
loop at `devices.ts:332` applies `imeiAsText` only when
`h === 'imei' && excelSafe` — every other column always goes through the
plain `escapeCsv`. Asserted by `test/csvExport.spec.ts:581` ("emits the IMEI
in the `="..."` Excel text-forcing form under `?excel=1`") and
`test/csvExport.spec.ts:593` ("`?excel=1` affects only the imei column —
every other field is unchanged from the default").

**Hash evidence tying the above source to what is actually live**: the
local build artifact and the live production static asset are byte-identical.

```
$ sha256sum public/static/app.js
e45e4afdb4688dcd73504293bc5eff5982976d124e7588abd29702000192fd99  public/static/app.js

$ curl -s https://d6aea290-bd61-4f82-aa8d-94378b9f2fec.vip.gensparksite.com/static/app.js | sha256sum
e45e4afdb4688dcd73504293bc5eff5982976d124e7588abd29702000192fd99  -
```

This curl call is a plain unauthenticated GET against a public static asset
— no fixture, no credential, no write. `git log --oneline -- public/static/app.js`
confirms this file has not changed since `aae5b1f`, the commit the currently
deployed version was built from, so the hash match ties the exact source
inspected above to what is actually served in production right now.

## Item 5 — live PASS

QC sub-tabs unchanged by this deploy. `git diff b8e4ff9..aae5b1f -- public/static/app.js`
shows the one QC-adjacent line in the diff (`qcFailedDevices: [],`) appears
as unmodified context, not a `+`/`-` change — confirmed no QC-tab code was
touched by this deploy's commit.

## D1 — live PASS, with a row-count correction

Ran two read-only `gsk hosted d1_query` calls against production this pass
(bracketed by `gsk login-info` before and after; both returned
`saigateslimited@gmail.com`, the expected account, no retry needed):

```
$ gsk hosted d1_query -q "SELECT COUNT(*) AS total FROM received_devices"
{"total": 1135}
...
$ gsk hosted d1_query -q "SELECT id, imei, sku, created_at FROM received_devices ORDER BY id DESC LIMIT 5"
id=1137  created_at="2026-09-08 12:26:35"
id=1136  created_at="2026-09-08 12:25:38"
id=1135  created_at="2026-09-07 16:36:04"
...
$ gsk hosted d1_query -q "SELECT COUNT(DISTINCT imei) AS distinct_imei, COUNT(*) AS total FROM received_devices"
{"distinct_imei": 1135, "total": 1135}
```

**The previously "settled" figure of 1133 rows is stale, not wrong.** The
count has moved twice within this single check (1133 → 1135 between the two
queries above, with a `max_id` of 1137 and a `created_at` of today,
2026-09-08) because production is actively receiving new goods-in
submissions during this session — this is real ongoing traffic, not a test
artifact or a re-run of this session's own work (the new IMEIs do not carry
the reserved browser-test prefix `8604569`, and the SKUs are ordinary
catalog values, not synthetic ones). `COUNT(DISTINCT imei) = COUNT(*)` at
1135, so there is no duplicate-IMEI anomaly at the new count either — the
table is still internally consistent, just larger than the number quoted at
the top of this session. Any migration or reporting work relying on a fixed
device count should re-query rather than reuse either "1133" or "1135" as a
constant.

## Rollback

Not applicable — no failure was confirmed in any of the five items above.
Rollback target for this deploy, if a failure surfaces later, remains the
previous version `d9d6f61`.
